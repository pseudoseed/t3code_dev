import Foundation

/// A stop flag that inference polls between tokens.
///
/// A single `llama_decode` cannot be interrupted, so cancellation lands at the
/// next token boundary rather than immediately. That is a few milliseconds on
/// any model we ship.
private final class CancellationFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var stopped = false

  func reset() {
    lock.lock()
    stopped = false
    lock.unlock()
  }

  func stop() {
    lock.lock()
    stopped = true
    lock.unlock()
  }

  var isStopped: Bool {
    lock.lock()
    defer { lock.unlock() }
    return stopped
  }
}

/// Owns the loaded cleanup model.
///
/// Loading a GGUF costs seconds, so the model stays resident and every rewrite
/// reuses it. Inference is synchronous and CPU-bound, so it runs on a dedicated
/// serial queue rather than on the cooperative pool, where a multi-second
/// decode would hold a thread the rest of the app needs. The queue also gives
/// the serialization the model requires: a load and a rewrite cannot overlap,
/// and a rewrite requested while a model is still loading simply waits for it.
///
/// `@unchecked Sendable` because every mutable property below is touched only
/// on `queue`.
final class CleanupEngine: @unchecked Sendable {
  /// Enough for a five-minute dictation plus the prompt and its hints, clamped
  /// down to whatever the model was actually trained on.
  private static let contextLength: Int32 = 4096

  /// A rewrite is about as long as its input. A model still going well past
  /// that has stopped rewriting and started talking.
  private static let maximumOutputTokens = 1_024

  private typealias TextContinuation = CheckedContinuation<String, Error>

  private let queue = DispatchQueue(label: "codes.t3.voice.cleanup", qos: .userInitiated)
  private let cancellation = CancellationFlag()

  private var loadedModelId: String?
  private var session: LlamaCleanupSession?

  func prepare(modelId: String, modelFolder: URL) async throws {
    guard let weights = ModelStore.ggufFile(in: modelFolder) else {
      throw VoiceEngineError.modelUnavailable("Cleanup model \(modelId) has no weights file.")
    }

    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      queue.async {
        if self.session != nil, self.loadedModelId == modelId {
          continuation.resume()
          return
        }

        do {
          let loaded = try LlamaCleanupSession(
            weights: weights,
            contextLength: Self.contextLength
          )
          // Replaced only once the new model is in hand, so a failed switch
          // leaves the previous model working instead of leaving nothing.
          self.session = loaded
          self.loadedModelId = modelId
          continuation.resume()
        } catch {
          continuation.resume(
            throwing: VoiceEngineError.modelUnavailable(
              "Cleanup model \(modelId) could not be loaded."
            )
          )
        }
      }
    }
  }

  func clean(transcript: String, systemPrompt: String, timeout: TimeInterval) async throws -> String {
    cancellation.reset()
    let deadline = Date().addingTimeInterval(timeout)

    let output = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: TextContinuation) in
        queue.async {
          guard let session = self.session else {
            continuation.resume(
              throwing: VoiceEngineError.modelUnavailable("No cleanup model is loaded.")
            )
            return
          }

          do {
            let text = try session.generate(
              systemPrompt: systemPrompt,
              transcript: transcript,
              maximumOutputTokens: Self.maximumOutputTokens,
              deadline: deadline,
              shouldStop: { self.cancellation.isStopped }
            )
            continuation.resume(returning: text)
          } catch {
            continuation.resume(throwing: error)
          }
        }
      }
    } onCancel: {
      cancellation.stop()
    }

    try Task.checkCancellation()
    return output.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Releases the resident model. This is the larger of the two models we hold,
  /// so it is the first thing to drop when memory gets tight.
  func evict() async {
    cancellation.stop()
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      queue.async {
        self.session = nil
        self.loadedModelId = nil
        continuation.resume()
      }
    }
  }

  func isLoaded(modelId: String) async -> Bool {
    await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
      queue.async {
        continuation.resume(returning: self.session != nil && self.loadedModelId == modelId)
      }
    }
  }
}
