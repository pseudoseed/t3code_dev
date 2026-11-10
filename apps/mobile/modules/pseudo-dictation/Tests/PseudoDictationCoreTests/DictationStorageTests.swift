import FluidAudio
import XCTest

@testable import PseudoDictationCore

func makeTemporaryStorage() throws -> DictationStorage {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("pseudo-dictation-tests", isDirectory: true)
    .appendingPathComponent(UUID().uuidString, isDirectory: true)
  let storage = DictationStorage(root: root)
  try storage.prepare()
  return storage
}

/// Writes the files a finished voice filter download leaves behind, without real model weights.
func writeVoiceFilterFiles(_ storage: DictationStorage) throws {
  let manager = FileManager.default
  let directory = storage.modelDirectory(.voiceFilter)
  for name in ModelNames.OfflineDiarizer.requiredModels {
    let url = directory.appendingPathComponent(name)
    if name.hasSuffix(".mlmodelc") {
      try manager.createDirectory(at: url, withIntermediateDirectories: true)
      try Data([1]).write(to: url.appendingPathComponent("coremldata.bin"))
    } else {
      try manager.createDirectory(at: directory, withIntermediateDirectories: true)
      try Data([1]).write(to: url)
    }
  }
}

final class DictationStorageTests: XCTestCase {
  private var storage: DictationStorage!

  override func setUpWithError() throws {
    storage = try makeTemporaryStorage()
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: storage.root)
  }

  func testModelsStayOutOfBackups() throws {
    let values = try storage.root.resourceValues(forKeys: [.isExcludedFromBackupKey])
    XCTAssertEqual(values.isExcludedFromBackup, true)
  }

  func testFilesWithoutTheMarkerAreNotInstalled() throws {
    try writeVoiceFilterFiles(storage)
    XCTAssertFalse(storage.isInstalled(.voiceFilter))
    try storage.markInstalled(.voiceFilter)
    XCTAssertTrue(storage.isInstalled(.voiceFilter))
  }

  func testTheMarkerWithoutFilesIsNotInstalled() throws {
    try storage.markInstalled(.voiceFilter)
    try storage.markInstalled(.fast)
    XCTAssertFalse(storage.isInstalled(.voiceFilter))
    XCTAssertFalse(storage.isInstalled(.fast))
  }

  func testAnInterruptedFileIsNotInstalled() throws {
    try writeVoiceFilterFiles(storage)
    try storage.markInstalled(.voiceFilter)
    let partial = storage.modelDirectory(.voiceFilter)
      .appendingPathComponent("Embedding.mlmodelc/weights/weight.bin.partial")
    try FileManager.default.createDirectory(
      at: partial.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data([1]).write(to: partial)
    XCTAssertFalse(storage.isInstalled(.voiceFilter))
  }

  func testAModelMissingItsCompiledDataIsNotInstalled() throws {
    try writeVoiceFilterFiles(storage)
    try storage.markInstalled(.voiceFilter)
    try FileManager.default.removeItem(
      at: storage.modelDirectory(.voiceFilter).appendingPathComponent("FBank.mlmodelc/coremldata.bin"))
    XCTAssertFalse(storage.isInstalled(.voiceFilter))
  }

  func testDeleteRemovesFilesAndBothMarkers() throws {
    let key = WarmKey(appBuild: "1(1)", osBuild: "os", processing: "2")
    try writeVoiceFilterFiles(storage)
    try storage.markInstalled(.voiceFilter)
    try storage.markWarm(.voiceFilter, key: key)
    XCTAssertGreaterThan(storage.sizeOnDisk(.voiceFilter), 0)

    try storage.delete(.voiceFilter)

    XCTAssertFalse(FileManager.default.fileExists(atPath: storage.modelDirectory(.voiceFilter).path))
    XCTAssertEqual(storage.sizeOnDisk(.voiceFilter), 0)
    XCTAssertFalse(storage.isWarm(.voiceFilter, key: key))
    try writeVoiceFilterFiles(storage)
    XCTAssertFalse(storage.isInstalled(.voiceFilter))
  }

  func testWarmOnlyForTheBuildOsAndProcessingItWasLoadedUnder() throws {
    let key = WarmKey(appBuild: "1.0(7)", osBuild: "Version 18.0", processing: "2")
    XCTAssertFalse(storage.isWarm(.fast, key: key))
    try storage.markWarm(.fast, key: key)
    XCTAssertTrue(storage.isWarm(.fast, key: key))
    XCTAssertFalse(storage.isWarm(.balanced, key: key))
    XCTAssertFalse(storage.isWarm(.fast, key: WarmKey(appBuild: "1.0(8)", osBuild: "Version 18.0", processing: "2")))
    XCTAssertFalse(storage.isWarm(.fast, key: WarmKey(appBuild: "1.0(7)", osBuild: "Version 18.1", processing: "2")))
    XCTAssertFalse(storage.isWarm(.fast, key: WarmKey(appBuild: "1.0(7)", osBuild: "Version 18.0", processing: "0")))
  }

  func testVoiceProfileRoundTrip() throws {
    let profile = VoiceProfile(
      extractor: VoiceProfile.currentExtractor, embedding: [0.6, 0.8], clipCount: 3,
      createdAt: Date(timeIntervalSince1970: 1_700_000_000))
    XCTAssertNil(storage.loadVoiceProfile())
    try storage.saveVoiceProfile(profile)
    XCTAssertEqual(storage.loadVoiceProfile(), profile)
    try storage.deleteVoiceProfile()
    XCTAssertNil(storage.loadVoiceProfile())
    XCTAssertNoThrow(try storage.deleteVoiceProfile())
  }

  func testAProfileThisBuildCannotCompareReadsAsAbsent() throws {
    let url = storage.root.appendingPathComponent("voice-profile.json")
    try storage.saveVoiceProfile(
      VoiceProfile(extractor: "another-extractor", embedding: [1, 0], clipCount: 3, createdAt: Date()))
    XCTAssertNil(storage.loadVoiceProfile())
    try storage.saveVoiceProfile(
      VoiceProfile(
        extractor: VoiceProfile.currentExtractor, embedding: [], clipCount: 3, createdAt: Date()))
    XCTAssertNil(storage.loadVoiceProfile())
    try Data("{ not json".utf8).write(to: url)
    XCTAssertNil(storage.loadVoiceProfile())
  }
}
