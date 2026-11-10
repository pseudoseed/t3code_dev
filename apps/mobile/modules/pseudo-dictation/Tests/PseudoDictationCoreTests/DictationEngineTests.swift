import FluidAudio
import XCTest

@testable import PseudoDictationCore

private final class Recorder: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: [DownloadUpdate] = []

  var updates: [DownloadUpdate] {
    lock.lock()
    defer { lock.unlock() }
    return stored
  }

  func add(_ update: DownloadUpdate) {
    lock.lock()
    stored.append(update)
    lock.unlock()
  }
}

private func environment(freeDisk: UInt64? = nil, availableMemory: UInt64 = 0) -> DictationEnvironment {
  DictationEnvironment(
    appBuild: "1.0(1)", osBuild: "test", isSimulator: true,
    availableMemory: { availableMemory }, freeDisk: { _ in freeDisk })
}

final class ProgressRelayTests: XCTestCase {
  func testLibraryProgressMapsDownloadToTheWholeBar() {
    XCTAssertEqual(
      DownloadUpdate(DownloadProgress(fractionCompleted: 0, phase: .listing)),
      DownloadUpdate(phase: .downloading, fraction: 0))
    XCTAssertEqual(
      DownloadUpdate(
        DownloadProgress(
          fractionCompleted: 0.25, phase: .downloading(completedFiles: 1, totalFiles: 2))),
      DownloadUpdate(phase: .downloading, fraction: 0.5))
    XCTAssertEqual(
      DownloadUpdate(
        DownloadProgress(
          fractionCompleted: 0.5, phase: .downloading(completedFiles: 0, totalFiles: 0))),
      DownloadUpdate(phase: .downloading, fraction: 1))
    XCTAssertEqual(
      DownloadUpdate(
        DownloadProgress(fractionCompleted: 0.75, phase: .compiling(modelName: "Encoder"))),
      DownloadUpdate(phase: .preparing, fraction: 1))
  }

  func testProgressNeverMovesBackwardsAndSkipsSmallSteps() {
    let recorder = Recorder()
    let relay = ProgressRelay(emit: { recorder.add($0) })
    for fraction in [0, 0.004, 0.2, 0.1, 0.204, 0.21, 0.996, 1] {
      relay.report(DownloadUpdate(phase: .downloading, fraction: fraction))
    }
    XCTAssertEqual(recorder.updates.map(\.fraction), [0, 0.2, 0.21, 0.996])
  }

  func testACachedLaterComponentDoesNotReopenTheDownloadPhase() {
    let recorder = Recorder()
    let relay = ProgressRelay(emit: { recorder.add($0) })
    relay.report(DownloadUpdate(phase: .downloading, fraction: 0.9))
    relay.report(DownloadUpdate(phase: .preparing, fraction: 1))
    relay.report(DownloadUpdate(phase: .downloading, fraction: 1))
    relay.report(DownloadUpdate(phase: .preparing, fraction: 1))
    XCTAssertEqual(recorder.updates.map(\.phase), [.downloading, .preparing])
  }
}

final class DictationEngineTests: XCTestCase {
  private var storage: DictationStorage!

  override func setUpWithError() throws {
    storage = try makeTemporaryStorage()
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: storage.root)
  }

  private func assertThrows<T>(
    _ expected: DictationError, _ body: () async throws -> T, file: StaticString = #filePath,
    line: UInt = #line
  ) async {
    do {
      _ = try await body()
      XCTFail("Expected \(expected)", file: file, line: line)
    } catch {
      XCTAssertEqual(error as? DictationError, expected, file: file, line: line)
    }
  }

  func testDownloadIsRefusedBeforeAnyNetworkUseWhenStorageIsShort() async {
    let engine = DictationEngine(storage: storage, environment: environment(freeDisk: 10 << 20))
    await assertThrows(
      .notEnoughDisk(requiredBytes: DictationModel.fast.downloadDiskBytes, availableBytes: 10 << 20)
    ) {
      try await engine.download(.fast, processing: .auto, onProgress: { _ in })
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: storage.modelDirectory(.fast).path))
  }

  func testPrepareAndTranscribeRefuseAModelThatIsNotDownloaded() async {
    let engine = DictationEngine(storage: storage, environment: environment())
    await assertThrows(.notInstalled(.fast)) {
      try await engine.prepare(.fast, processing: .auto)
    }
    await assertThrows(.notInstalled(.balanced)) {
      try await engine.transcribe(
        requestId: "1", url: URL(fileURLWithPath: "/dev/null"), model: .balanced,
        processing: .auto, onlyMyVoice: false, language: "en-US")
    }
  }

  func testACancelThatArrivesFirstStopsItsTranscriptionAndNoOther() async {
    let engine = DictationEngine(storage: storage, environment: environment())
    let transcribe = { (requestId: String) in
      try await engine.transcribe(
        requestId: requestId, url: URL(fileURLWithPath: "/dev/null"), model: .fast,
        processing: .auto, onlyMyVoice: false, language: "en-US")
    }
    await engine.cancelTranscription(requestId: "early")
    await assertThrows(.notInstalled(.fast)) { try await transcribe("other") }
    await assertThrows(.cancelled) { try await transcribe("early") }
    await assertThrows(.notInstalled(.fast)) { try await transcribe("early") }
  }

  func testTheVoiceFilterIsNotASpeechModel() async {
    let engine = DictationEngine(storage: storage, environment: environment())
    await assertThrows(.unknownModel("voice-filter")) {
      try await engine.prepare(.voiceFilter, processing: .auto)
    }
  }

  func testStatusOfAModelThatIsNotDownloaded() async {
    let engine = DictationEngine(storage: storage, environment: environment())
    let status = await engine.status(.fast, processing: .auto)
    XCTAssertEqual(
      status, ModelStatus(installed: false, warm: false, downloading: false, sizeOnDiskBytes: 0))
  }

  func testAWarmMarkerDoesNotOutliveTheModelFiles() async throws {
    try storage.markWarm(
      .fast, key: WarmKey(appBuild: "1.0(1)", osBuild: "test", processing: "0"))
    let engine = DictationEngine(storage: storage, environment: environment())
    let status = await engine.status(.fast, processing: .auto)
    XCTAssertFalse(status.warm)
  }

  func testSavingAProfileNeedsEveryClip() async {
    let engine = DictationEngine(storage: storage, environment: environment())
    await assertThrows(.enrollmentRejected(.tooFewClips)) {
      try await engine.saveVoiceProfile([URL(fileURLWithPath: "/dev/null")])
    }
    let status = await engine.voiceProfileStatus()
    XCTAssertFalse(status.enrolled)
  }

  func testLanguageHintComesFromTheLocalePrefix() {
    XCTAssertEqual(DictationEngine.languageHint("en-US"), .english)
    XCTAssertEqual(DictationEngine.languageHint("de_DE"), .german)
    XCTAssertEqual(DictationEngine.languageHint("FR"), .french)
    XCTAssertNil(DictationEngine.languageHint("ja-JP"))
    XCTAssertNil(DictationEngine.languageHint(nil))
    XCTAssertNil(DictationEngine.languageHint(""))
  }

  func testForeignErrorsAreDescribedAsCodedDictationErrors() {
    XCTAssertEqual(DictationEngine.describe(CancellationError()), .cancelled)
    XCTAssertEqual(DictationEngine.describe(DictationError.noVoiceProfile), .noVoiceProfile)
    XCTAssertEqual(DictationEngine.describe(DictationError.notInstalled(.fast)).code, "not-installed")
    XCTAssertEqual(DictationEngine.describe(URLError(.timedOut)).code, "failed")
  }
}
