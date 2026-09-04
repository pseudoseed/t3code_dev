import Foundation
import llama

/// A loaded GGUF model and the context one rewrite runs in.
///
/// This binds llama.cpp directly rather than going through a Swift wrapper
/// package. The wrappers all carry a chat-session abstraction with history, a
/// SwiftSyntax macro dependency, or both, and cleanup needs neither: it is one
/// stateless prompt in, one rewrite out.
///
/// Not `Sendable`. `CleanupEngine` owns exactly one of these and serializes
/// every call into it.
final class LlamaCleanupSession {
  enum SessionError: Error {
    case modelLoadFailed
    case contextCreationFailed
    case promptTooLong(tokens: Int, limit: Int)
    case tokenizationFailed
    case decodeFailed
  }

  private let model: OpaquePointer
  private let vocab: OpaquePointer
  private let context: OpaquePointer
  private let sampler: UnsafeMutablePointer<llama_sampler>
  private let contextLength: Int32
  private let chatTemplate: String?

  /// llama.cpp writes its own progress and diagnostics to stderr. Silenced
  /// once, at first load: the interesting failures come back as errors, and the
  /// noise buries every other native log the app emits.
  private static let backend: Void = {
    llama_backend_init()
    llama_log_set({ _, _, _ in }, nil)
  }()

  init(weights: URL, contextLength requestedContextLength: Int32) throws {
    _ = Self.backend

    var modelParams = llama_model_default_params()
    #if targetEnvironment(simulator)
      // The simulator has no usable Metal path for these kernels; running the
      // model on CPU is slow but it is the difference between verifying the
      // feature locally and not being able to.
      modelParams.n_gpu_layers = 0
    #endif

    guard let model = llama_model_load_from_file(weights.path, modelParams) else {
      throw SessionError.modelLoadFailed
    }
    self.model = model

    // A context larger than the model was trained on produces garbage rather
    // than an error, so the model's own limit wins over ours.
    contextLength = min(requestedContextLength, llama_model_n_ctx_train(model))

    var contextParams = llama_context_default_params()
    contextParams.n_ctx = UInt32(contextLength)
    contextParams.n_batch = UInt32(contextLength)
    contextParams.n_threads = Int32(max(1, ProcessInfo.processInfo.activeProcessorCount - 1))
    contextParams.n_threads_batch = contextParams.n_threads

    guard let context = llama_init_from_model(model, contextParams) else {
      llama_model_free(model)
      throw SessionError.contextCreationFailed
    }
    self.context = context

    guard let vocab = llama_model_get_vocab(model) else {
      llama_free(context)
      llama_model_free(model)
      throw SessionError.modelLoadFailed
    }
    self.vocab = vocab

    // Greedy. A rewrite has one right answer, and sampling temperature only
    // buys drift that the shared length-ratio guard then rejects.
    guard let chain = llama_sampler_chain_init(llama_sampler_chain_default_params()) else {
      llama_free(context)
      llama_model_free(model)
      throw SessionError.contextCreationFailed
    }
    llama_sampler_chain_add(chain, llama_sampler_init_greedy())
    sampler = chain

    chatTemplate = llama_model_chat_template(model, nil).map { String(cString: $0) }
  }

  deinit {
    llama_sampler_free(sampler)
    llama_free(context)
    llama_model_free(model)
  }

  /// Rewrites one transcript.
  ///
  /// The context is cleared first, so no previous dictation influences this
  /// one. `deadline` and `shouldStop` are both checked between tokens, which is
  /// the only place generation can be interrupted: a single `llama_decode` is
  /// not cancellable. Stopping early returns the partial rewrite, which the
  /// shared length-ratio guard then rejects in favour of the raw transcript.
  func generate(
    systemPrompt: String,
    transcript: String,
    maximumOutputTokens: Int,
    deadline: Date,
    shouldStop: () -> Bool
  ) throws -> String {
    llama_memory_clear(llama_get_memory(context), true)

    let prompt = applyChatTemplate(systemPrompt: systemPrompt, transcript: transcript)
    var tokens = try tokenize(prompt, addSpecial: chatTemplate == nil)

    // Leave room for the answer. A prompt that fills the window produces a
    // truncated rewrite, which reads as a cleanup that ate half the sentence.
    let promptLimit = Int(contextLength) - maximumOutputTokens
    guard tokens.count < promptLimit else {
      throw SessionError.promptTooLong(tokens: tokens.count, limit: promptLimit)
    }

    guard llama_decode(context, llama_batch_get_one(&tokens, Int32(tokens.count))) == 0 else {
      throw SessionError.decodeFailed
    }

    // Pieces are accumulated as bytes and decoded once at the end. A token can
    // be half of a multi-byte character, and decoding per token turns every
    // accented word and emoji into replacement characters.
    var output: [UInt8] = []
    var generated = 0

    while generated < maximumOutputTokens {
      if shouldStop() || Date() >= deadline { break }

      var token = llama_sampler_sample(sampler, context, -1)
      if llama_vocab_is_eog(vocab, token) { break }

      output.append(contentsOf: piece(for: token))
      generated += 1

      guard llama_decode(context, llama_batch_get_one(&token, 1)) == 0 else {
        throw SessionError.decodeFailed
      }
    }

    return ReasoningText.strip(Self.decodeUTF8(output))
  }

  private func applyChatTemplate(systemPrompt: String, transcript: String) -> String {
    guard let chatTemplate else {
      return chatMLPrompt(systemPrompt: systemPrompt, transcript: transcript)
    }

    return systemPrompt.withCString { system in
      transcript.withCString { user in
        var messages = [
          llama_chat_message(role: strdup("system"), content: system),
          llama_chat_message(role: strdup("user"), content: user),
        ]
        defer {
          for message in messages { free(UnsafeMutablePointer(mutating: message.role)) }
        }

        var buffer = [CChar](repeating: 0, count: (systemPrompt.utf8.count + transcript.utf8.count) * 2 + 1024)
        let written = llama_chat_apply_template(
          chatTemplate,
          &messages,
          messages.count,
          true,
          &buffer,
          Int32(buffer.count)
        )

        guard written > 0, written <= buffer.count else {
          return chatMLPrompt(systemPrompt: systemPrompt, transcript: transcript)
        }

        return Self.decodeUTF8(buffer[..<Int(written)].map { UInt8(bitPattern: $0) })
      }
    }
  }

  private func chatMLPrompt(systemPrompt: String, transcript: String) -> String {
    """
    <|im_start|>system
    \(systemPrompt)<|im_end|>
    <|im_start|>user
    \(transcript)<|im_end|>
    <|im_start|>assistant

    """
  }

  /// Decodes accumulated bytes as UTF-8.
  ///
  /// Deliberately the non-failable initializer. The failable one returns nil on
  /// a single malformed sequence, which would throw away an entire rewrite over
  /// one bad byte; this substitutes a replacement character and keeps the text.
  private static func decodeUTF8(_ bytes: [UInt8]) -> String {
    // swiftlint:disable:next optional_data_string_conversion
    String(decoding: bytes, as: UTF8.self)
  }

  private func tokenize(_ text: String, addSpecial: Bool) throws -> [llama_token] {
    let byteCount = Int32(text.utf8.count)
    var tokens = [llama_token](repeating: 0, count: text.utf8.count + 8)

    var count = text.withCString { cString in
      llama_tokenize(vocab, cString, byteCount, &tokens, Int32(tokens.count), addSpecial, true)
    }

    if count < 0 {
      tokens = [llama_token](repeating: 0, count: Int(-count))
      count = text.withCString { cString in
        llama_tokenize(vocab, cString, byteCount, &tokens, Int32(tokens.count), addSpecial, true)
      }
    }

    guard count > 0 else { throw SessionError.tokenizationFailed }
    return Array(tokens[..<Int(count)])
  }

  private func piece(for token: llama_token) -> [UInt8] {
    var buffer = [CChar](repeating: 0, count: 64)
    var written = llama_token_to_piece(vocab, token, &buffer, Int32(buffer.count), 0, false)

    if written < 0 {
      buffer = [CChar](repeating: 0, count: Int(-written))
      written = llama_token_to_piece(vocab, token, &buffer, Int32(buffer.count), 0, false)
    }

    guard written > 0 else { return [] }
    return buffer[..<Int(written)].map { UInt8(bitPattern: $0) }
  }
}
