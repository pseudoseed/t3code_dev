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
  /// Audio dropped as other voices, so the composer can say how much went.
  let removedSeconds: Double

  static let notRequested = SpeakerFilteringOutcome(
    requested: false,
    applied: false,
    fallbackReason: nil,
    removedSeconds: 0
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
  static let diarizerModelId = "fluid-diarizer-offline"
  static let legacyDiarizerModelId = "fluid-diarizer"

  private enum LoadedDiarizer {
    case offline(OfflineDiarizerModels)
    case legacy(DiarizerManager)

    var modelId: String {
      switch self {
      case .offline: return FluidAudioEngine.diarizerModelId
      case .legacy: return FluidAudioEngine.legacyDiarizerModelId
      }
    }
  }

  private var loadedModelId: String?
  private var asrManager: AsrManager?
  private var diarizer: LoadedDiarizer?

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
    case diarizerModelId, legacyDiarizerModelId: repo = .diarizer
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

    try DeviceMemory.requireLoadCapacity(modelFolder: modelFolder)
    let models = try await AsrModels.load(from: directory, version: version)
    let manager = AsrManager(config: .default, models: models)
    // Replaced only once the new one is loaded, so a failed switch leaves
    // dictation working on the previous model rather than on nothing.
    asrManager = manager
    loadedModelId = modelId
  }

  func prepareDiarizer(modelFolder: URL) async throws {
    let modelId = modelFolder.lastPathComponent
    if diarizer?.modelId == modelId { return }

    guard let directory = Self.repositoryFolder(forModelId: modelId, in: modelFolder),
      modelId == Self.diarizerModelId || modelId == Self.legacyDiarizerModelId
    else {
      throw VoiceEngineError.modelUnavailable("The voice separation model is not installed.")
    }

    try DeviceMemory.requireLoadCapacity(modelFolder: modelFolder)
    if modelId == Self.diarizerModelId {
      try DeviceMemory.requireSpeakerFilteringCapacity()
      // Completed recordings benefit from clustering the whole file. The online
      // diarizer can merge alternating voices before it has enough context.
      // Unlike the older load API, this one takes the repository's parent.
      let models = try await OfflineDiarizerModels.load(from: modelFolder)
      diarizer = .offline(models)
    } else {
      // Keep existing filtering available until the user downloads the update.
      let models = try await DiarizerModels.load(from: directory)
      let manager = DiarizerManager()
      manager.initialize(models: models)
      diarizer = .legacy(manager)
    }
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
      try await ModelHub.download(.diarizer, to: folder, variant: "offline", progressHandler: handler)
      return
    }
    if modelId == legacyDiarizerModelId {
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
    speakerFiltering: Bool,
    model: (id: String, folder: URL),
    diarizerFolder: URL?
  ) async throws -> VoiceTranscriptionOutput {
    // Preparation may have finished minutes ago, before a memory warning.
    try await prepare(modelId: model.id, modelFolder: model.folder)
    if speakerFiltering, let diarizerFolder {
      try await prepareDiarizer(modelFolder: diarizerFolder)
    }
    guard let asrManager else {
      throw VoiceEngineError.modelUnavailable("No speech model is loaded.")
    }

    let samples = try AudioConverter().resampleAudioFile(URL(fileURLWithPath: audioPath))
    try Task.checkCancellation()

    guard speakerFiltering, let diarizer else {
      let text = try await Self.transcribe(samples, with: asrManager, locale: locale)
      return VoiceTranscriptionOutput(text: text, speakerFiltering: .notRequested)
    }

    let decision = try await decideSpeaker(for: samples, using: diarizer)
    try Task.checkCancellation()

    switch decision {
    case .filter(_, let ranges, let removedSeconds):
      let filtered = Self.slice(samples, to: ranges)
      let text = try await Self.transcribe(filtered, with: asrManager, locale: locale)
      return VoiceTranscriptionOutput(
        text: text,
        speakerFiltering: SpeakerFilteringOutcome(
          requested: true,
          applied: true,
          fallbackReason: nil,
          removedSeconds: removedSeconds
        )
      )
    case .passThrough(let reason):
      let text = try await Self.transcribe(samples, with: asrManager, locale: locale)
      return VoiceTranscriptionOutput(
        text: text,
        speakerFiltering: SpeakerFilteringOutcome(
          requested: true,
          applied: false,
          fallbackReason: reason.rawValue,
          removedSeconds: 0
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
    if modelId == Self.diarizerModelId || modelId == Self.legacyDiarizerModelId {
      return diarizer?.modelId == modelId
    }
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

  private func decideSpeaker(
    for samples: [Float],
    using diarizer: LoadedDiarizer
  ) async throws -> SpeakerFilterDecision {
    let result: DiarizationResult
    switch diarizer {
    case .offline(let models):
      try DeviceMemory.requireSpeakerFilteringCapacity()
      // The resident models are Sendable; each call owns its clustering manager.
      let manager = OfflineDiarizerManager()
      manager.initialize(models: models)
      result = try await manager.process(audio: samples)
    case .legacy(let manager):
      // Keep the expensive models resident, not the previous recording's
      // embeddings. The offline manager already clusters each file separately.
      manager.speakerManager.reset()
      defer { manager.speakerManager.reset() }
      result = try manager.performCompleteDiarization(samples, sampleRate: Self.sampleRate)
    }
    let unmeasured = result.segments.map { segment in
      let start = Double(segment.startTimeSeconds)
      let end = Double(segment.endTimeSeconds)
      return SpeakerSpan(
        speakerId: segment.speakerId,
        startSeconds: start,
        endSeconds: end
      )
    }

    let soloRanges = Dictionary(
      uniqueKeysWithValues: Set(unmeasured.map(\.speakerId)).map { id in
        (id, SpeakerFilter.soloRanges(speakerId: id, spans: unmeasured))
      })
    let spans = unmeasured.map { span in
      // A foreground phrase can land in an otherwise quiet cluster. Its local
      // level must still protect it; the cluster average is not its volume.
      let ranges = (soloRanges[span.speakerId] ?? []).compactMap { range -> KeptRange? in
        let start = max(span.startSeconds, range.startSeconds)
        let end = min(span.endSeconds, range.endSeconds)
        return start < end ? KeptRange(startSeconds: start, endSeconds: end) : nil
      }
      return SpeakerSpan(
        speakerId: span.speakerId, startSeconds: span.startSeconds, endSeconds: span.endSeconds,
        levelDb: Self.level(of: samples, ranges: ranges)
      )
    }

    let levels = SpeakerFilter.levelBySpeaker(spans)
    var decision = SpeakerFilter.decide(
      spans: spans, audioDurationSeconds: Double(samples.count) / Double(Self.sampleRate))
    if case .filter(let id, _, _) = decision, let level = levels[id] {
      decision = SpeakerFilter.protectingLoudAudio(
        decision, samples: samples, sampleRate: Self.sampleRate, foregroundLevel: level)
    }
    // What the diarizer heard, per voice, so a wrong drop can be traced to the
    // duration or level that caused it and the thresholds tuned from a real
    // recording rather than a guess.
    var seconds: [String: Double] = [:]
    for span in spans { seconds[span.speakerId, default: 0] += span.duration }
    let voices = seconds.keys.sorted().map { id in
      let level = levels[id].map { String(format: "%.1fdB", $0) } ?? "?"
      return "\(id)=\(String(format: "%.1fs", seconds[id] ?? 0))@\(level)"
    }
    VoiceDiagnostics.report(
      "speakers",
      "spans=\(spans.count) voices=[\(voices.joined(separator: " "))] decision=\(String(describing: decision))"
    )

    return decision
  }

  /// Mean level across solo speech, without double-counting overlapping windows.
  private static func level(
    of samples: [Float], ranges: [KeptRange]
  ) -> Double? {
    var power = 0.0
    var count = 0
    for range in ranges {
      let start = max(0, Int(range.startSeconds * Double(sampleRate)))
      let end = min(samples.count, Int(range.endSeconds * Double(sampleRate)))
      guard start < end else { continue }
      for sample in samples[start..<end] {
        power += Double(sample) * Double(sample)
      }
      count += end - start
    }
    // Tiny solo fragments give unreliable levels and must not authorize a drop.
    guard count >= sampleRate / 10 else { return nil }
    let mean = power / Double(count)
    return 10 * log10(max(mean, 1e-12))
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
