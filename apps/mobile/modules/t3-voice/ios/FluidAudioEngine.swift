import AVFoundation
import FluidAudio
import Foundation

/// What speaker filtering did to a dictation.
///
/// Reported on every transcription so the composer can say when other voices
/// may still be in the transcript. Filtering that quietly did nothing is worse
/// than filtering that is switched off.
struct SpeakerFilteringOutcome {
  let requested: Bool
  let applied: Bool
  /// A `SpeakerFilterFallback` raw value when filtering was asked for and did
  /// not happen.
  let fallbackReason: String?

  static let notRequested = SpeakerFilteringOutcome(
    requested: false,
    applied: false,
    fallbackReason: nil
  )
}

struct VoiceTranscriptionOutput {
  let text: String
  let speakerFiltering: SpeakerFilteringOutcome
}

/// Speech recognition and speaker diarization through FluidAudio.
///
/// Two models, loaded and evicted independently: the recognizer, and the
/// diarizer that speaker filtering needs. Filtering is off for most users, so
/// the diarizer is only ever loaded when it is on.
actor FluidAudioEngine {
  /// The rate FluidAudio's models expect. Audio is resampled to it on the way in.
  private static let sampleRate = 16_000

  /// The store id of the diarizer.
  ///
  /// Not a user-selectable model. It is a dependency of speaker filtering, so
  /// it is downloaded when that is switched on and deleted with it.
  static let diarizerModelId = "fluid-diarizer"

  private var loadedModelId: String?
  private var asrManager: AsrManager?
  private var diarizer: DiarizerManager?

  /// Maps a catalog id to the FluidAudio recognizer behind it.
  static func asrVersion(forModelId modelId: String) -> AsrModelVersion? {
    switch modelId {
    case "parakeet-v3": return .v3
    default: return nil
    }
  }

  /// Where inside our model folder FluidAudio actually puts the files.
  ///
  /// Its download and load APIs both treat the directory they are given as the
  /// repository folder and write to its parent, so pointing them straight at
  /// our folder would scatter files beside it. Handing them a subfolder named
  /// after the repository keeps everything inside the folder the store owns,
  /// which is what deletion, sizing, and the completion marker all assume.
  ///
  /// The name comes from `Repo.folderName` rather than a literal. FluidAudio
  /// strips the `-coreml` suffix for most repositories and keeps it for a few,
  /// and a hand-written copy of that rule is one release away from being wrong.
  private static func repositoryFolder(forModelId modelId: String, in folder: URL) -> URL? {
    let repo: Repo
    switch modelId {
    case diarizerModelId: repo = .diarizer
    case "parakeet-v3": repo = .parakeetV3
    default: return nil
    }

    return folder.appendingPathComponent(repo.folderName, isDirectory: true)
  }

  func prepare(modelId: String, modelFolder: URL) async throws {
    if asrManager != nil, loadedModelId == modelId { return }

    guard
      let version = Self.asrVersion(forModelId: modelId),
      let directory = Self.repositoryFolder(forModelId: modelId, in: modelFolder)
    else {
      throw VoiceEngineError.modelUnavailable("\(modelId) is not a FluidAudio model.")
    }

    let models = try await AsrModels.load(from: directory, version: version)
    let manager = AsrManager(config: .default, models: models)
    // Replaced only once the new one is loaded, so a failed switch leaves
    // dictation working on the previous model rather than on nothing.
    asrManager = manager
    loadedModelId = modelId
  }

  func prepareDiarizer(modelFolder: URL) async throws {
    if diarizer != nil { return }

    guard let directory = Self.repositoryFolder(forModelId: Self.diarizerModelId, in: modelFolder)
    else {
      throw VoiceEngineError.modelUnavailable("The voice separation model is not installed.")
    }

    let models = try await DiarizerModels.load(from: directory)
    let manager = DiarizerManager()
    manager.initialize(models: models)
    diarizer = manager
  }

  /// Downloads a FluidAudio model into our store.
  ///
  /// FluidAudio fetches its own files because it, not us, knows which ones a
  /// version needs. It writes into the same directory as every other model so
  /// storage accounting, deletion, and the completion marker all still work.
  ///
  /// `onProgress` receives a fraction. FluidAudio reports one but never a byte
  /// count, so the caller has no total to show; a download of several hundred
  /// megabytes with no visible progress reads as a hang.
  static func download(
    modelId: String,
    to folder: URL,
    onProgress: @escaping @Sendable (Double) -> Void
  ) async throws {
    guard let directory = repositoryFolder(forModelId: modelId, in: folder) else {
      throw VoiceEngineError.modelUnavailable("\(modelId) is not a FluidAudio model.")
    }

    let handler: ProgressHandler = { progress in onProgress(progress.fractionCompleted) }

    if modelId == diarizerModelId {
      _ = try await DiarizerModels.download(to: directory, progressHandler: handler)
      return
    }

    guard let version = asrVersion(forModelId: modelId) else {
      throw VoiceEngineError.modelUnavailable("\(modelId) is not a FluidAudio model.")
    }

    _ = try await AsrModels.download(to: directory, version: version, progressHandler: handler)
  }

  func transcribe(
    audioPath: String,
    locale: String?,
    speakerFiltering: Bool
  ) async throws -> VoiceTranscriptionOutput {
    guard let asrManager else {
      throw VoiceEngineError.modelUnavailable("No speech model is loaded.")
    }

    let samples = try AudioConverter().resampleAudioFile(URL(fileURLWithPath: audioPath))
    try Task.checkCancellation()

    guard speakerFiltering, let diarizer else {
      let text = try await Self.transcribe(samples, with: asrManager, locale: locale)
      return VoiceTranscriptionOutput(text: text, speakerFiltering: .notRequested)
    }

    let decision = try Self.decideSpeaker(for: samples, using: diarizer)
    try Task.checkCancellation()

    switch decision {
    case let .filter(_, ranges):
      let filtered = Self.slice(samples, to: ranges)
      let text = try await Self.transcribe(filtered, with: asrManager, locale: locale)
      return VoiceTranscriptionOutput(
        text: text,
        speakerFiltering: SpeakerFilteringOutcome(
          requested: true,
          applied: true,
          fallbackReason: nil
        )
      )
    case let .passThrough(reason):
      let text = try await Self.transcribe(samples, with: asrManager, locale: locale)
      return VoiceTranscriptionOutput(
        text: text,
        speakerFiltering: SpeakerFilteringOutcome(
          requested: true,
          applied: false,
          fallbackReason: reason.rawValue
        )
      )
    }
  }

  func evict() {
    asrManager = nil
    diarizer = nil
    loadedModelId = nil
  }

  func isLoaded(modelId: String) -> Bool {
    if modelId == Self.diarizerModelId { return diarizer != nil }
    return asrManager != nil && loadedModelId == modelId
  }

  private static func transcribe(
    _ samples: [Float],
    with manager: AsrManager,
    locale: String?
  ) async throws -> String {
    var decoderState = try TdtDecoderState()
    let language = locale.flatMap { Language(rawValue: String($0.prefix(2)).lowercased()) }
    let result = try await manager.transcribe(
      samples,
      decoderState: &decoderState,
      language: language
    )
    return result.text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func decideSpeaker(
    for samples: [Float],
    using diarizer: DiarizerManager
  ) throws -> SpeakerFilterDecision {
    let result = try diarizer.performCompleteDiarization(samples, sampleRate: sampleRate)
    let spans = result.segments.map { segment in
      SpeakerSpan(
        speakerId: segment.speakerId,
        startSeconds: Double(segment.startTimeSeconds),
        endSeconds: Double(segment.endTimeSeconds)
      )
    }

    let decision = SpeakerFilter.decide(spans: spans)
    // What the diarizer heard, so a filter that quietly did nothing can be told
    // apart from one that decided not to.
    let speakers = Set(spans.map(\.speakerId)).count
    VoiceDiagnostics.report(
      "speakers",
      "spans=\(spans.count) speakers=\(speakers) decision=\(String(describing: decision))"
    )

    return decision
  }

  /// Concatenates the kept ranges into one buffer.
  ///
  /// The recognizer sees a shorter recording with the other voices removed
  /// rather than silence in their place; silence of the original length only
  /// costs inference time and invites the model to hallucinate through it.
  private static func slice(_ samples: [Float], to ranges: [KeptRange]) -> [Float] {
    var filtered: [Float] = []
    filtered.reserveCapacity(samples.count)

    for range in ranges {
      let start = max(0, Int(range.startSeconds * Double(sampleRate)))
      let end = min(samples.count, Int(range.endSeconds * Double(sampleRate)))
      guard start < end else { continue }
      filtered.append(contentsOf: samples[start..<end])
    }

    return filtered
  }
}
