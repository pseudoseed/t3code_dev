import CoreML
import FluidAudio
import Foundation

struct ModelStatus: Equatable, Sendable {
  var installed: Bool
  var warm: Bool
  var downloading: Bool
  var sizeOnDiskBytes: UInt64
}

struct DownloadUpdate: Equatable, Sendable {
  enum Phase: String, Sendable {
    case downloading
    case preparing
  }

  var phase: Phase
  var fraction: Double

  /// FluidAudio spends the first half of its fraction on the download and the rest on compiling.
  init(_ progress: DownloadProgress) {
    switch progress.phase {
    case .listing:
      self.init(phase: .downloading, fraction: 0)
    case .downloading:
      self.init(phase: .downloading, fraction: min(max(progress.fractionCompleted * 2, 0), 1))
    case .compiling:
      self.init(phase: .preparing, fraction: 1)
    }
  }

  init(phase: Phase, fraction: Double) {
    self.phase = phase
    self.fraction = fraction
  }
}

/// Passes on a download's progress in whole percent steps and never backwards, so the bridge is not
/// flooded and a resumed file cannot make the bar jump back.
final class ProgressRelay: @unchecked Sendable {
  private let lock = NSLock()
  private var last: DownloadUpdate?
  private let emit: @Sendable (DownloadUpdate) -> Void

  init(emit: @escaping @Sendable (DownloadUpdate) -> Void) {
    self.emit = emit
  }

  func report(_ update: DownloadUpdate) {
    lock.lock()
    var next = update
    if let last {
      if last.phase == .preparing && update.phase == .downloading {
        lock.unlock()
        return
      }
      if last.phase == update.phase {
        next.fraction = max(last.fraction, update.fraction)
        // Whole percents, so a subtraction's rounding error cannot swallow a step or the final 100.
        if (next.fraction * 100).rounded() <= (last.fraction * 100).rounded() {
          lock.unlock()
          return
        }
      }
    }
    last = next
    lock.unlock()
    emit(next)
  }
}

struct FilterOutcome: Equatable, Sendable {
  var applied: Bool
  var keptSeconds: Double
  var droppedSeconds: Double
  var skipped: FilterSkip?

  static func skipped(_ reason: FilterSkip) -> FilterOutcome {
    FilterOutcome(applied: false, keptSeconds: 0, droppedSeconds: 0, skipped: reason)
  }
}

struct Transcript: Sendable {
  var text: String
  var audioSeconds: Double
  var processingSeconds: Double
  var filter: FilterOutcome?
}

struct ClipCheck: Equatable, Sendable {
  var speechSeconds: Double
  var problem: EnrollmentProblem?
}

struct VoiceProfileStatus: Equatable, Sendable {
  var enrolled: Bool
  var clipCount: Int
  var createdAt: Date?
}

/// The diarizer is a plain class. It is only ever used from the engine's queue, one job at a time.
private struct DiarizerBox: @unchecked Sendable {
  let manager: OfflineDiarizerManager
}

private struct HeardTurn: Sendable {
  var turn: SpeakerTurn
  var embedding: [Float]?
  var level: Float?
}

private struct EnrollmentClip: Sendable {
  var speechSeconds: Double
  var embedding: [Float]
  var problem: EnrollmentProblem?
}

actor DictationEngine {
  static let sampleRate = 16_000.0
  static let idleReleaseSeconds = 300.0
  static let minimumEnrollmentSpeechSeconds = 3.0
  static let dominantSpeakerShare = 0.8
  static let enrollmentClipCount = 3
  static let rememberedCancels = 8

  private struct LoadKey: Equatable {
    var model: DictationModel
    var processing: DictationProcessing
  }

  private let storage: DictationStorage
  private let environment: DictationEnvironment
  private var asr: (key: LoadKey, task: Task<AsrManager, Error>)?
  private var diarizer: Task<DiarizerBox, Error>?
  private var downloads: [DictationModel: Task<Void, Error>] = [:]
  private var requests: [String: Task<Transcript, Error>] = [:]
  /// Cancels that arrived before their transcription did: each bridge call runs in its own task.
  private var cancelledEarly: [String] = []
  private var sizes: [DictationModel: UInt64] = [:]
  private var queueTail: Task<Void, Never>?
  private var queued = 0
  private var idleRelease: Task<Void, Never>?

  /// Dictation never reaches for the network. Only an explicit download lifts this. Set once, so
  /// a second engine cannot cut off a download the first one is running.
  private static let offlineByDefault: Void = { ModelHub.offlineMode = true }()

  init(storage: DictationStorage, environment: DictationEnvironment = .current) {
    self.storage = storage
    self.environment = environment
    _ = Self.offlineByDefault
  }

  // MARK: Models

  func status(_ model: DictationModel, processing: DictationProcessing) -> ModelStatus {
    let installed = storage.isInstalled(model)
    // Walking the model's files is too slow for a call made on every tap of the microphone.
    if installed, sizes[model] == nil { sizes[model] = storage.sizeOnDisk(model) }
    return ModelStatus(
      installed: installed,
      warm: installed && storage.isWarm(model, key: warmKey(processing)),
      downloading: downloads[model] != nil,
      sizeOnDiskBytes: installed ? sizes[model] ?? 0 : 0
    )
  }

  func download(
    _ model: DictationModel,
    processing: DictationProcessing,
    onProgress: @escaping @Sendable (DownloadUpdate) -> Void
  ) async throws {
    if let running = downloads[model] {
      do {
        return try await running.value
      } catch {
        throw running.isCancelled ? DictationError.cancelled : Self.describe(error)
      }
    }
    try storage.prepare()
    let free = storage.isInstalled(model) ? nil : environment.freeDisk(storage.root)
    if let free, free < model.downloadDiskBytes {
      throw DictationError.notEnoughDisk(requiredBytes: model.downloadDiskBytes, availableBytes: free)
    }

    let relay = ProgressRelay(emit: onProgress)
    let storage = storage
    let isSimulator = environment.isSimulator
    let units = processing.computeUnits(isSimulator: isSimulator)
    ModelHub.offlineMode = false
    let task = Task.detached(priority: .userInitiated) {
      let handler: ProgressHandler = { relay.report(DownloadUpdate($0)) }
      if let version = model.asrVersion {
        _ = try await AsrModels.download(
          to: storage.modelDirectory(model), version: version, encoderComputeUnits: units,
          progressHandler: handler)
      } else {
        _ = try await OfflineDiarizerModels.load(
          from: storage.modelsRoot,
          configuration: Self.diarizerConfiguration(isSimulator: isSimulator),
          progressHandler: handler)
      }
      try Task.checkCancellation()
      try storage.markInstalled(model)
    }
    downloads[model] = task
    let result = await task.result
    downloads[model] = nil
    sizes[model] = nil
    if downloads.isEmpty { ModelHub.offlineMode = true }

    do {
      try result.get()
    } catch {
      // A cancelled download gives its space back. A failed one keeps its files so a retry resumes.
      if task.isCancelled, !storage.isInstalled(model) { try? storage.delete(model) }
      throw task.isCancelled ? DictationError.cancelled : Self.describe(error)
    }
    if model.asrVersion != nil {
      relay.report(DownloadUpdate(phase: .preparing, fraction: 1))
      // The model is installed either way. A load that fails here is tried again by a dictation.
      try? await prepare(model, processing: processing)
    }
  }

  func cancelDownload(_ model: DictationModel) {
    downloads[model]?.cancel()
  }

  func delete(_ model: DictationModel) async throws {
    downloads[model]?.cancel()
    _ = await downloads[model]?.result
    let work = enqueue { try await self.deleteNow(model) }
    try await finish(work)
  }

  private func deleteNow(_ model: DictationModel) async throws {
    if model == .voiceFilter {
      diarizer = nil
    } else if asr?.key.model == model {
      await dropAsr()
    }
    sizes[model] = nil
    try storage.delete(model)
  }

  /// Loads a model and records that this build, OS and processing choice have compiled it.
  func prepare(_ model: DictationModel, processing: DictationProcessing) async throws {
    let key = LoadKey(model: model, processing: processing)
    let work = enqueue {
      _ = try await self.value(of: try await self.loadTask(key), key: key)
      try await self.storage.markWarm(model, key: self.warmKey(processing))
    }
    try await finish(work)
  }

  /// Frees the loaded models unless one is in use. Called when idle and on a memory warning.
  func releaseIfIdle() async {
    guard queued == 0 else { return }
    idleRelease?.cancel()
    idleRelease = nil
    diarizer = nil
    await dropAsr()
  }

  // MARK: Transcription

  func transcribe(
    requestId: String,
    url: URL,
    model: DictationModel,
    processing: DictationProcessing,
    onlyMyVoice: Bool,
    language: String?
  ) async throws -> Transcript {
    if let early = cancelledEarly.firstIndex(of: requestId) {
      cancelledEarly.remove(at: early)
      throw DictationError.cancelled
    }
    let work = enqueue {
      try await self.runTranscription(
        url: url, model: model, processing: processing, onlyMyVoice: onlyMyVoice, language: language)
    }
    requests[requestId] = work
    defer { requests[requestId] = nil }
    return try await withTaskCancellationHandler {
      try await finish(work)
    } onCancel: {
      work.cancel()
    }
  }

  func cancelTranscription(requestId: String) {
    if let request = requests[requestId] { return request.cancel() }
    cancelledEarly = Array((cancelledEarly + [requestId]).suffix(Self.rememberedCancels))
  }

  private func runTranscription(
    url: URL,
    model: DictationModel,
    processing: DictationProcessing,
    onlyMyVoice: Bool,
    language: String?
  ) async throws -> Transcript {
    let started = Date()
    let key = LoadKey(model: model, processing: processing)
    // The load starts before decoding so the two overlap.
    let loading = try await loadTask(key)
    let samples = try await Self.decodeOffActor(url)
    let audioSeconds = Double(samples.count) / Self.sampleRate
    guard AudioGate.hasSpeech(samples: samples, sampleRate: Self.sampleRate) else {
      return Transcript(
        text: "", audioSeconds: audioSeconds,
        processingSeconds: Date().timeIntervalSince(started),
        filter: onlyMyVoice ? .skipped(.noSpeech) : nil)
    }

    var input = samples
    var filter: FilterOutcome?
    if onlyMyVoice {
      let filtered = await filterToEnrolledVoice(samples)
      input = filtered.samples
      filter = filtered.outcome
    }
    try Task.checkCancellation()

    let manager = try await value(of: loading, key: key)
    var decoderState = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
    let result = try await manager.transcribe(
      input, decoderState: &decoderState, language: Self.languageHint(language))
    try Task.checkCancellation()
    try? storage.markWarm(model, key: warmKey(processing))
    return Transcript(
      text: result.text.trimmingCharacters(in: .whitespacesAndNewlines),
      audioSeconds: audioSeconds,
      processingSeconds: Date().timeIntervalSince(started),
      filter: filter)
  }

  // MARK: Voice profile

  func voiceProfileStatus() -> VoiceProfileStatus {
    let profile = storage.loadVoiceProfile()
    return VoiceProfileStatus(
      enrolled: profile != nil, clipCount: profile?.clipCount ?? 0, createdAt: profile?.createdAt)
  }

  func checkEnrollmentClip(_ url: URL) async throws -> ClipCheck {
    let work = enqueue { try await self.enrollmentClip(url) }
    let clip = try await finish(work)
    return ClipCheck(speechSeconds: clip.speechSeconds, problem: clip.problem)
  }

  func saveVoiceProfile(_ urls: [URL]) async throws {
    guard urls.count >= Self.enrollmentClipCount else {
      throw DictationError.enrollmentRejected(.tooFewClips)
    }
    let work = enqueue { () async throws -> [[Float]] in
      var embeddings: [[Float]] = []
      for url in urls {
        let clip = try await self.enrollmentClip(url)
        if let problem = clip.problem { throw DictationError.enrollmentRejected(problem) }
        embeddings.append(clip.embedding)
      }
      return embeddings
    }
    let embeddings = try await finish(work)
    // Pair by pair: against their mean, one stranger's clip pulls the mean far enough to pass.
    let agree = embeddings.indices.allSatisfy { first in
      embeddings.indices.allSatisfy { second in
        SpeakerFilter.cosineDistance(embeddings[first], embeddings[second])
          <= SpeakerFilter.agreementDistance
      }
    }
    guard agree, let mean = SpeakerFilter.meanEmbedding(embeddings) else {
      throw DictationError.enrollmentRejected(.clipsDisagree)
    }
    try storage.saveVoiceProfile(
      VoiceProfile(
        extractor: VoiceProfile.currentExtractor, embedding: mean, clipCount: embeddings.count,
        createdAt: Date()))
  }

  func deleteVoiceProfile() throws {
    try storage.deleteVoiceProfile()
  }

  private func enrollmentClip(_ url: URL) async throws -> EnrollmentClip {
    let samples = try await Self.decodeOffActor(url)
    guard AudioGate.hasSpeech(samples: samples, sampleRate: Self.sampleRate) else {
      return EnrollmentClip(speechSeconds: 0, embedding: [], problem: .tooQuiet)
    }
    let heard = try await heardTurns(samples).compactMap { turn in
      turn.embedding.map { (seconds: turn.turn.duration, embedding: $0) }
    }
    guard let longest = heard.max(by: { $0.seconds < $1.seconds }) else {
      return EnrollmentClip(speechSeconds: 0, embedding: [], problem: .tooShort)
    }
    // The longest turn is taken to be the speaker; the rest of the clip has to sound like it.
    let same = heard.filter {
      let distance = SpeakerFilter.cosineDistance($0.embedding, longest.embedding)
      return SpeakerFilter.judge(duration: $0.seconds, distance: distance) == .mine
    }
    let speechSeconds = same.reduce(0) { $0 + $1.seconds }
    let heardSeconds = heard.reduce(0) { $0 + $1.seconds }
    if speechSeconds / heardSeconds < Self.dominantSpeakerShare {
      return EnrollmentClip(speechSeconds: speechSeconds, embedding: [], problem: .multipleVoices)
    }
    guard speechSeconds >= Self.minimumEnrollmentSpeechSeconds,
      let embedding = SpeakerFilter.meanEmbedding(
        same.map(\.embedding), weights: same.map { Float($0.seconds) })
    else {
      return EnrollmentClip(speechSeconds: speechSeconds, embedding: [], problem: .tooShort)
    }
    return EnrollmentClip(speechSeconds: speechSeconds, embedding: embedding, problem: nil)
  }

  /// Any failure here leaves the recording whole: the filter may be skipped, never the dictation.
  private func filterToEnrolledVoice(_ samples: [Float]) async -> (samples: [Float], outcome: FilterOutcome) {
    guard let profile = storage.loadVoiceProfile() else { return (samples, .skipped(.noProfile)) }
    guard storage.isInstalled(.voiceFilter) else { return (samples, .skipped(.notInstalled)) }
    guard let heard = try? await heardTurns(samples, splitAgainst: profile.embedding) else {
      return (samples, .skipped(.failed))
    }
    let turns = heard.map(\.turn)
    let voices = SpeakerFilter.voices(
      turns: turns, embeddings: heard.map(\.embedding), profile: profile.embedding)
    switch SpeakerFilter.decide(turns: turns, voices: voices, levels: heard.map(\.level)) {
    case .unfiltered(let reason):
      return (samples, .skipped(reason))
    case .drop(let ranges):
      let droppedSeconds = SpeakerFilter.seconds(ranges)
      return (
        SpeakerFilter.remove(samples: samples, ranges: ranges, sampleRate: Self.sampleRate),
        FilterOutcome(
          applied: true, keptSeconds: Double(samples.count) / Self.sampleRate - droppedSeconds,
          droppedSeconds: droppedSeconds, skipped: nil)
      )
    }
  }

  /// The recording's speaker turns, with a voiceprint for each one long enough to judge.
  ///
  /// The diarizer finds the turns well, but in a recording of a few seconds it labels every turn
  /// as one speaker. So its labels are not trusted: each turn gets its own voiceprint. It also
  /// joins a short interjection to the turn beside it, so with a voice profile to compare against,
  /// long turns are split where the voice changes.
  private func heardTurns(_ samples: [Float], splitAgainst profile: [Float]? = nil) async throws -> [HeardTurn] {
    let manager = try await diarizerManager()
    let segments: [TimedSpeakerSegment]
    do {
      segments = try await manager.process(audio: samples).segments
    } catch OfflineDiarizationError.noSpeechDetected {
      return []
    }
    let totalSeconds = Double(samples.count) / Self.sampleRate
    let source = ArrayAudioSampleSource(samples: samples)
    var turns = segments.map {
      SpeakerTurn(
        speaker: $0.speakerId, start: max(Double($0.startTimeSeconds), 0),
        end: min(Double($0.endTimeSeconds), totalSeconds))
    }
    let scans = turns.map(SpeakerFilter.scanWindows)
    if let profile, scans.contains(where: { !$0.isEmpty }) {
      var distances = try await manager.embedSpans(audioSource: source, spans: scans.flatMap { $0 })
        .map { SpeakerFilter.cosineDistance($0, profile) }[...]
      turns = zip(turns, scans).flatMap { turn, windows in
        defer { distances = distances.dropFirst(windows.count) }
        return SpeakerFilter.split(
          turn, windows: windows, distances: Array(distances.prefix(windows.count)))
      }
    }
    var heard = turns.map { turn in
      let from = min(Int(turn.start * Self.sampleRate), samples.count)
      let to = min(max(Int(turn.end * Self.sampleRate), from), samples.count)
      return HeardTurn(
        turn: turn, embedding: nil,
        level: SpeakerFilter.level(samples[from..<to], sampleRate: Self.sampleRate))
    }
    let judged = heard.indices.filter {
      heard[$0].turn.duration >= SpeakerFilter.minimumJudgedSeconds
    }
    guard !judged.isEmpty else { return heard }
    let embeddings = try await manager.embedSpans(
      audioSource: source, spans: judged.map { heard[$0].turn.start..<heard[$0].turn.end })
    for (index, embedding) in zip(judged, embeddings) {
      heard[index].embedding = SpeakerFilter.normalized(embedding)
    }
    return heard
  }

  // MARK: Queue

  /// Model work runs one job at a time, in order: a phone has room for one model in use, and the
  /// diarizer is not safe to share.
  private func enqueue<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) -> Task<T, Error> {
    let previous = queueTail
    queued += 1
    idleRelease?.cancel()
    let task = Task<T, Error> {
      await previous?.value
      try Task.checkCancellation()
      return try await work()
    }
    queueTail = Task { _ = await task.result }
    return task
  }

  @discardableResult
  private func finish<T: Sendable>(_ task: Task<T, Error>) async throws -> T {
    let result = await task.result
    queued -= 1
    if queued == 0 { scheduleIdleRelease() }
    do {
      return try result.get()
    } catch {
      throw task.isCancelled ? DictationError.cancelled : Self.describe(error)
    }
  }

  private func scheduleIdleRelease() {
    idleRelease?.cancel()
    idleRelease = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(Self.idleReleaseSeconds * 1_000_000_000))
      guard !Task.isCancelled else { return }
      await self?.releaseIfIdle()
    }
  }

  // MARK: Loading

  private func warmKey(_ processing: DictationProcessing) -> WarmKey {
    WarmKey(
      appBuild: environment.appBuild, osBuild: environment.osBuild,
      processing: String(processing.computeUnits(isSimulator: environment.isSimulator).rawValue))
  }

  private func value(of task: Task<AsrManager, Error>, key: LoadKey) async throws -> AsrManager {
    do {
      return try await task.value
    } catch {
      if asr?.key == key { asr = nil }
      throw error
    }
  }

  /// Only called from queued work, so the suspension below cannot interleave two loads.
  private func loadTask(_ key: LoadKey) async throws -> Task<AsrManager, Error> {
    if let asr, asr.key == key { return asr.task }
    guard let version = key.model.asrVersion else {
      throw DictationError.unknownModel(key.model.rawValue)
    }
    guard storage.isInstalled(key.model) else { throw DictationError.notInstalled(key.model) }
    // The old model goes first: two at once would double the memory the gate below allows for.
    await dropAsr()
    let available = environment.availableMemory()
    guard hasEnoughMemory(available: available, required: key.model.loadMemoryBytes) else {
      throw DictationError.notEnoughMemory(
        requiredBytes: key.model.loadMemoryBytes, availableBytes: available)
    }
    let directory = storage.modelDirectory(key.model)
    let units = key.processing.computeUnits(isSimulator: environment.isSimulator)
    let task = Task.detached(priority: .userInitiated) { () throws -> AsrManager in
      let configuration = AsrModels.defaultConfiguration()
      configuration.computeUnits = units
      let models = try AsrModels.loadLocal(
        from: directory, version: version, configuration: configuration,
        encoderComputeUnits: units)
      let manager = AsrManager(config: .default)
      try await manager.loadModels(models)
      return manager
    }
    asr = (key, task)
    return task
  }

  private func dropAsr() async {
    guard let current = asr else { return }
    asr = nil
    await (try? current.task.value)?.cleanup()
  }

  private func diarizerManager() async throws -> OfflineDiarizerManager {
    if let diarizer { return try await diarizer.value.manager }
    guard storage.isInstalled(.voiceFilter) else { throw DictationError.notInstalled(.voiceFilter) }
    let available = environment.availableMemory()
    guard hasEnoughMemory(available: available, required: DictationModel.voiceFilter.loadMemoryBytes)
    else {
      throw DictationError.notEnoughMemory(
        requiredBytes: DictationModel.voiceFilter.loadMemoryBytes, availableBytes: available)
    }
    let root = storage.modelsRoot
    let isSimulator = environment.isSimulator
    let task = Task.detached(priority: .userInitiated) { () throws -> DiarizerBox in
      let models = try await OfflineDiarizerModels.load(
        from: root, configuration: Self.diarizerConfiguration(isSimulator: isSimulator))
      var config = OfflineDiarizerConfig.default
      // Dictations are short, and smaller batches keep the peak memory down on a phone.
      config.segmentation.batchSize = min(config.segmentation.batchSize, 8)
      config.embedding.batchSize = min(config.embedding.batchSize, 8)
      let manager = OfflineDiarizerManager(config: config)
      manager.initialize(models: models)
      return DiarizerBox(manager: manager)
    }
    diarizer = task
    do {
      return try await task.value.manager
    } catch {
      diarizer = nil
      throw error
    }
  }

  /// Never the GPU: iOS refuses GPU work in the background, where a dictation may finish.
  private static func diarizerConfiguration(isSimulator: Bool) -> MLModelConfiguration {
    let configuration = MLModelConfiguration()
    configuration.computeUnits = isSimulator ? .cpuOnly : .cpuAndNeuralEngine
    return configuration
  }

  // MARK: Helpers

  static func decode(_ url: URL) throws -> [Float] {
    do {
      return try AudioConverter().resampleAudioFile(url)
    } catch {
      throw DictationError.audioUnreadable(error.localizedDescription)
    }
  }

  /// Decoding and resampling a recording takes long enough to hold up a cancel on the actor.
  private static func decodeOffActor(_ url: URL) async throws -> [Float] {
    try await Task.detached(priority: .userInitiated) { try decode(url) }.value
  }

  /// The hint only steers the multilingual models away from the wrong script; an unknown language
  /// means no hint.
  static func languageHint(_ locale: String?) -> Language? {
    guard let code = locale?.split(whereSeparator: { $0 == "-" || $0 == "_" }).first else {
      return nil
    }
    return Language(rawValue: code.lowercased())
  }

  static func describe(_ error: Error) -> DictationError {
    if let error = error as? DictationError { return error }
    if error is CancellationError { return .cancelled }
    return .failed(error.localizedDescription)
  }
}
