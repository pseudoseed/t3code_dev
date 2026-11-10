import AVFoundation
import FluidAudio
import XCTest

@testable import PseudoDictationCore

/// Runs the engine against the real models with voices from the Mac's speech synthesiser.
/// Skipped unless `PSEUDO_DICTATION_MODELS` names a directory to download into (about 2 GB):
///
///     PSEUDO_DICTATION_MODELS=/path/to/models swift test --filter RealModelTests
final class RealModelTests: XCTestCase {
  private static let me = "Samantha"
  private static let other = "Daniel"
  private static let enrollment = [
    "The quick brown fox jumps over the lazy dog while the sun sets behind the quiet hills.",
    "Please review the pull request and tell me whether the tests cover the new settings screen.",
    "I would like to schedule the release for Thursday afternoon after the team meeting ends.",
  ]
  private static let mine = "Open the settings screen and rename the project to umbrella."
  private static let theirs = "Yesterday we climbed the volcano and watched the lava glow at night."

  private var storage: DictationStorage!
  private var engine: DictationEngine!
  private var clips: URL!

  override func setUpWithError() throws {
    guard let root = ProcessInfo.processInfo.environment["PSEUDO_DICTATION_MODELS"], !root.isEmpty
    else {
      throw XCTSkip("Set PSEUDO_DICTATION_MODELS to a directory to run against the real models.")
    }
    storage = DictationStorage(root: URL(fileURLWithPath: root, isDirectory: true))
    try storage.prepare()
    // A voice profile left by another test must not leak into this one.
    try storage.deleteVoiceProfile()
    engine = DictationEngine(
      storage: storage,
      environment: DictationEnvironment(
        appBuild: "harness", osBuild: ProcessInfo.processInfo.operatingSystemVersionString,
        isSimulator: false, availableMemory: { 0 }, freeDisk: { _ in nil }))
    clips = FileManager.default.temporaryDirectory
      .appendingPathComponent("pseudo-dictation-clips-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: clips, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    if let clips { try? FileManager.default.removeItem(at: clips) }
  }

  // MARK: Fixtures

  private func speak(_ text: String, voice: String, name: String) throws -> URL {
    let url = clips.appendingPathComponent("\(name).wav")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    process.arguments = [
      "-v", voice, "-o", url.path, "--file-format=WAVE", "--data-format=LEI16@16000", text,
    ]
    try process.run()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0, "say failed for \(voice)")
    return url
  }

  private func write(_ samples: [Float], name: String) throws -> URL {
    let url = clips.appendingPathComponent("\(name).wav")
    try writeWav(samples, to: url)
    return url
  }

  private func silence(_ seconds: Double) -> [Float] {
    [Float](repeating: 0, count: Int(seconds * DictationEngine.sampleRate))
  }

  private func download(_ model: DictationModel) async throws {
    let started = Date()
    try await engine.download(model, processing: .auto, onProgress: { _ in })
    let megabytes = storage.sizeOnDisk(model) / 1_000_000
    print("MEASURE download \(model.rawValue): \(megabytes) MB on disk, \(Int(Date().timeIntervalSince(started))) s")
  }

  private func enroll(voice: String) async throws -> [URL] {
    try await download(.voiceFilter)
    let urls = try Self.enrollment.enumerated().map { index, text in
      try speak(text, voice: voice, name: "enroll-\(voice)-\(index)")
    }
    try await engine.saveVoiceProfile(urls)
    return urls
  }

  private func words(_ text: String) -> Set<String> {
    Set(text.lowercased().split(whereSeparator: { !$0.isLetter }).map(String.init))
  }

  // MARK: Speech models

  func testEveryModelDownloadsLoadsAndTranscribes() async throws {
    let url = try speak(Self.mine, voice: Self.me, name: "mine")
    for model in [DictationModel.fast, .balanced, .accurate] {
      try await download(model)
      let status = await engine.status(model, processing: .auto)
      XCTAssertTrue(status.installed, model.rawValue)
      XCTAssertTrue(status.warm, model.rawValue)
      XCTAssertGreaterThan(status.sizeOnDiskBytes, 50_000_000, model.rawValue)
      XCTAssertLessThanOrEqual(status.sizeOnDiskBytes, model.downloadDiskBytes, model.rawValue)

      let transcript = try await engine.transcribe(
        requestId: model.rawValue, url: url, model: model, processing: .auto, onlyMyVoice: false,
        language: "en-US")
      print(
        "MEASURE transcribe \(model.rawValue): \(transcript.audioSeconds) s audio in "
          + "\(transcript.processingSeconds) s: \(transcript.text)")
      let heard = words(transcript.text)
      for expected in ["settings", "rename", "project", "umbrella"] {
        XCTAssertTrue(heard.contains(expected), "\(model.rawValue) missed \(expected): \(transcript.text)")
      }
      XCTAssertNil(transcript.filter)
    }
  }

  func testAModelLoadsWithTheNetworkOff() async throws {
    try await download(.fast)
    await engine.releaseIfIdle()
    XCTAssertTrue(ModelHub.offlineMode)
    let url = try speak(Self.mine, voice: Self.me, name: "mine")
    let transcript = try await engine.transcribe(
      requestId: "offline", url: url, model: .fast, processing: .cpu, onlyMyVoice: false,
      language: nil)
    XCTAssertTrue(words(transcript.text).contains("umbrella"), transcript.text)
  }

  func testSilenceIsNotSentToTheModel() async throws {
    try await download(.fast)
    let url = try write(silence(2), name: "silence")
    let transcript = try await engine.transcribe(
      requestId: "silence", url: url, model: .fast, processing: .auto, onlyMyVoice: true,
      language: "en-US")
    XCTAssertEqual(transcript.text, "")
    XCTAssertEqual(transcript.filter, .skipped(.noSpeech))
  }

  func testACancelledTranscriptionReportsCancelled() async throws {
    try await download(.fast)
    let url = try speak(Self.enrollment.joined(separator: " "), voice: Self.me, name: "long")
    let engine = try XCTUnwrap(self.engine)
    let running = Task {
      try await engine.transcribe(
        requestId: "cancel", url: url, model: .fast, processing: .auto, onlyMyVoice: false,
        language: "en-US")
    }
    running.cancel()
    do {
      _ = try await running.value
      XCTFail("Expected the transcription to be cancelled")
    } catch {
      XCTAssertEqual(error as? DictationError, .cancelled)
    }
    let after = try await engine.transcribe(
      requestId: "after", url: url, model: .fast, processing: .auto, onlyMyVoice: false,
      language: "en-US")
    XCTAssertTrue(words(after.text).contains("fox"), after.text)
  }

  func testACancelledDownloadLeavesNothingBehind() async throws {
    let storage = DictationStorage(
      root: clips.appendingPathComponent("cancelled-download", isDirectory: true))
    let engine = DictationEngine(
      storage: storage,
      environment: DictationEnvironment(
        appBuild: "harness", osBuild: ProcessInfo.processInfo.operatingSystemVersionString,
        isSimulator: false, availableMemory: { 0 }, freeDisk: { _ in nil }))
    let (progress, continuation) = AsyncStream<DownloadUpdate>.makeStream()
    let running = Task {
      defer { continuation.finish() }
      try await engine.download(.fast, processing: .auto, onProgress: { continuation.yield($0) })
    }
    for await update in progress where update.fraction > 0 { break }
    XCTAssertTrue(FileManager.default.fileExists(atPath: storage.modelDirectory(.fast).path))
    await engine.cancelDownload(.fast)
    do {
      try await running.value
      XCTFail("Expected the download to be cancelled")
    } catch {
      XCTAssertEqual(error as? DictationError, .cancelled)
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: storage.modelDirectory(.fast).path))
    let status = await engine.status(.fast, processing: .auto)
    XCTAssertEqual(
      status, ModelStatus(installed: false, warm: false, downloading: false, sizeOnDiskBytes: 0))
  }

  // MARK: Voice filter

  func testOnlyMyVoiceDropsTheOtherSpeaker() async throws {
    try await download(.fast)
    _ = try await enroll(voice: Self.me)
    // The user does most of the talking, and the other voice is further from the phone.
    let mine =
      try DictationEngine.decode(speak(Self.enrollment[1], voice: Self.me, name: "opening"))
      + silence(0.6) + DictationEngine.decode(speak(Self.mine, voice: Self.me, name: "mine"))
    let theirs = try DictationEngine.decode(speak(Self.theirs, voice: Self.other, name: "theirs"))
      .map { $0 * 0.25 }
    let url = try write(mine + silence(0.6) + theirs, name: "both")

    let unfiltered = try await engine.transcribe(
      requestId: "unfiltered", url: url, model: .fast, processing: .auto, onlyMyVoice: false,
      language: "en-US")
    XCTAssertTrue(words(unfiltered.text).contains("umbrella"), unfiltered.text)
    XCTAssertTrue(words(unfiltered.text).contains("volcano"), unfiltered.text)

    let filtered = try await engine.transcribe(
      requestId: "filtered", url: url, model: .fast, processing: .auto, onlyMyVoice: true,
      language: "en-US")
    print("MEASURE filter: \(String(describing: filtered.filter)) -> \(filtered.text)")
    XCTAssertTrue(words(filtered.text).contains("umbrella"), filtered.text)
    XCTAssertFalse(words(filtered.text).contains("volcano"), filtered.text)
    XCTAssertFalse(words(filtered.text).contains("lava"), filtered.text)
    let outcome = try XCTUnwrap(filtered.filter)
    XCTAssertTrue(outcome.applied)
    XCTAssertEqual(outcome.keptSeconds, Double(mine.count) / DictationEngine.sampleRate, accuracy: 1)
    XCTAssertEqual(
      outcome.droppedSeconds, Double(theirs.count) / DictationEngine.sampleRate, accuracy: 1)
  }

  func testOnlyMyVoiceKeepsEverythingWhenIAmTheOnlySpeaker() async throws {
    try await download(.fast)
    _ = try await enroll(voice: Self.me)
    let url = try speak(Self.mine, voice: Self.me, name: "mine")
    let transcript = try await engine.transcribe(
      requestId: "solo", url: url, model: .fast, processing: .auto, onlyMyVoice: true,
      language: "en-US")
    XCTAssertEqual(transcript.filter, .skipped(.onlyYou))
    XCTAssertTrue(words(transcript.text).contains("umbrella"), transcript.text)
  }

  func testOnlyMyVoiceKeepsEverythingWhenNoSpeakerMatches() async throws {
    try await download(.fast)
    _ = try await enroll(voice: Self.me)
    let url = try speak(Self.theirs, voice: Self.other, name: "theirs")
    let transcript = try await engine.transcribe(
      requestId: "stranger", url: url, model: .fast, processing: .auto, onlyMyVoice: true,
      language: "en-US")
    XCTAssertEqual(transcript.filter, .skipped(.noMatch))
    XCTAssertTrue(words(transcript.text).contains("volcano"), transcript.text)
  }

  func testOnlyMyVoiceWithoutAProfileStillTranscribes() async throws {
    try await download(.fast)
    let url = try speak(Self.mine, voice: Self.me, name: "mine")
    let transcript = try await engine.transcribe(
      requestId: "no-profile", url: url, model: .fast, processing: .auto, onlyMyVoice: true,
      language: "en-US")
    XCTAssertEqual(transcript.filter, .skipped(.noProfile))
    XCTAssertTrue(words(transcript.text).contains("umbrella"), transcript.text)
  }

  // MARK: Enrollment

  func testEnrollmentAcceptsOneVoiceAndSavesAProfile() async throws {
    let urls = try await enroll(voice: Self.me)
    let check = try await engine.checkEnrollmentClip(urls[0])
    XCTAssertNil(check.problem)
    XCTAssertGreaterThan(check.speechSeconds, DictationEngine.minimumEnrollmentSpeechSeconds)
    let status = await engine.voiceProfileStatus()
    XCTAssertTrue(status.enrolled)
    XCTAssertEqual(status.clipCount, 3)
    XCTAssertEqual(storage.loadVoiceProfile()?.embedding.count, 256)
  }

  func testEnrollmentRejectsClipsItCannotUse() async throws {
    try await download(.voiceFilter)
    let quiet = try await engine.checkEnrollmentClip(write(silence(4), name: "quiet"))
    XCTAssertEqual(quiet.problem, .tooQuiet)

    let short = try await engine.checkEnrollmentClip(speak("Hello there.", voice: Self.me, name: "short"))
    XCTAssertEqual(short.problem, .tooShort)

    let mine = try DictationEngine.decode(speak(Self.enrollment[0], voice: Self.me, name: "a"))
    let theirs = try DictationEngine.decode(speak(Self.enrollment[1], voice: Self.other, name: "b"))
    let shared = try await engine.checkEnrollmentClip(
      write(mine + silence(0.5) + theirs, name: "shared"))
    XCTAssertEqual(shared.problem, .multipleVoices)
  }

  func testEnrollmentRejectsClipsFromDifferentPeople() async throws {
    try await download(.voiceFilter)
    let urls = [
      try speak(Self.enrollment[0], voice: Self.me, name: "c0"),
      try speak(Self.enrollment[1], voice: Self.me, name: "c1"),
      try speak(Self.enrollment[2], voice: Self.other, name: "c2"),
    ]
    do {
      try await engine.saveVoiceProfile(urls)
      XCTFail("Expected the clips to disagree")
    } catch {
      XCTAssertEqual(error as? DictationError, .enrollmentRejected(.clipsDisagree))
    }
    let status = await engine.voiceProfileStatus()
    XCTAssertFalse(status.enrolled)
  }
}
