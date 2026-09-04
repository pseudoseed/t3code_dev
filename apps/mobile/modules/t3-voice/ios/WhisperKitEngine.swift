import Foundation
import WhisperKit

enum VoiceEngineError: Error {
  case modelUnavailable(String)
  case cancelled
}

/// Owns the loaded WhisperKit model.
///
/// Loading a model costs seconds, so the loaded one is kept resident and reused
/// across dictations. An actor gives us that cache plus serialized access to it
/// without a lock, and keeps every load and inference off the main thread.
actor WhisperKitEngine {
  private var loadedModelId: String?
  private var whisperKit: WhisperKit?

  /// Set while a load is in flight so concurrent callers await the same work
  /// instead of loading a second copy of the same multi-hundred-megabyte model.
  private var loadTask: Task<WhisperKit, Error>?

  func prepare(modelId: String, modelFolder: URL) async throws -> WhisperKit {
    if let whisperKit, loadedModelId == modelId {
      return whisperKit
    }

    if let loadTask, loadedModelId == modelId {
      return try await loadTask.value
    }

    // A different model was asked for. Drop the old one only once the new one
    // is in hand, so a failed switch leaves dictation working rather than
    // leaving the user with nothing loaded.
    let task = Task<WhisperKit, Error> {
      // WhisperKit's tokenizer loader runs through swift-transformers' Hub,
      // which wants a writable base and defaults to the app's Documents
      // directory. Point it at our models directory instead: Documents is
      // user-visible and backed up, and this scratch space is neither.
      let hubBase = try? ModelStore.modelsDirectory()

      let config = WhisperKitConfig(
        modelFolder: modelFolder.path,
        tokenizerFolder: hubBase,
        verbose: false,
        logLevel: .error,
        prewarm: true,
        load: true,
        download: false
      )
      return try await WhisperKit(config)
    }

    loadedModelId = modelId
    loadTask = task

    do {
      let loaded = try await task.value
      whisperKit = loaded
      loadTask = nil
      return loaded
    } catch {
      loadTask = nil
      if whisperKit == nil {
        loadedModelId = nil
      }
      throw error
    }
  }

  func transcribe(audioPath: String, locale: String?) async throws -> String {
    guard let whisperKit else {
      throw VoiceEngineError.modelUnavailable("No speech model is loaded.")
    }

    let options = DecodingOptions(
      task: .transcribe,
      language: locale,
      skipSpecialTokens: true
    )

    let results = try await whisperKit.transcribe(audioPath: audioPath, decodeOptions: options)
    try Task.checkCancellation()

    return results
      .map(\.text)
      .joined(separator: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Releases the resident model under memory pressure. The next dictation
  /// reloads it, which costs one slower transcription and nothing else.
  func evict() {
    whisperKit = nil
    loadedModelId = nil
  }

  func isLoaded(modelId: String) -> Bool {
    whisperKit != nil && loadedModelId == modelId
  }
}
