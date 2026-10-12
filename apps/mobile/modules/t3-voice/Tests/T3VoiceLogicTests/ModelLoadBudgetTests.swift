import XCTest

@testable import T3VoiceLogic

final class ModelLoadBudgetTests: XCTestCase {
  func testSpeakerFilteringRequiresWorkingMemoryBeyondItsSmallWeights() {
    XCTAssertFalse(ModelLoadBudget.fitsSpeakerFiltering(availableBytes: 22 << 20))
    XCTAssertFalse(ModelLoadBudget.fitsSpeakerFiltering(availableBytes: 708 << 20))
    XCTAssertFalse(ModelLoadBudget.fitsSpeakerFiltering(availableBytes: 0))
    XCTAssertFalse(ModelLoadBudget.fitsSpeakerFiltering(availableBytes: (1 << 30) - 1))
    XCTAssertTrue(ModelLoadBudget.fitsSpeakerFiltering(availableBytes: 1 << 30))
  }

  func testRejectsAColdParakeetLoadWhenOnly64MegabytesRemain() {
    XCTAssertFalse(ModelLoadBudget.fits(modelBytes: 461 << 20, availableBytes: 64 << 20))
  }

  func testCleanupIncludesAllocationOverhead() {
    XCTAssertFalse(
      ModelLoadBudget.fits(modelBytes: 2614 << 20, availableBytes: 3000 << 20, multiplier: 1.5))
    XCTAssertTrue(
      ModelLoadBudget.fits(modelBytes: 2614 << 20, availableBytes: 4000 << 20, multiplier: 1.5))
  }

  func testFitsAtTheBudgetBoundary() {
    XCTAssertTrue(ModelLoadBudget.fits(modelBytes: 100, availableBytes: 150, multiplier: 1.5))
    XCTAssertFalse(ModelLoadBudget.fits(modelBytes: 101, availableBytes: 150, multiplier: 1.5))
  }

  func testRejectsLoadsWhenTheProcessHasExceededItsMemoryLimit() {
    XCTAssertFalse(ModelLoadBudget.fits(modelBytes: 2614 << 20, availableBytes: 0, multiplier: 1.5))
    XCTAssertFalse(ModelLoadBudget.fits(modelBytes: 1, availableBytes: 0))
  }

  func testRequiresReadableModelWeights() {
    XCTAssertFalse(ModelLoadBudget.fits(modelBytes: 0, availableBytes: 4000 << 20))
    XCTAssertFalse(ModelLoadBudget.fits(modelBytes: 0, availableBytes: 0))
  }
}
