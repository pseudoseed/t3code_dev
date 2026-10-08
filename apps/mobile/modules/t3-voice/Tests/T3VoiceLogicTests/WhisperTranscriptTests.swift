import XCTest

@testable import T3VoiceLogic

final class WhisperTranscriptTests: XCTestCase {
  func testSilenceAnnotationsAreNotDictation() {
    XCTAssertEqual(WhisperTranscript.normalize(" [BLANK_AUDIO]\n"), "")
    XCTAssertEqual(WhisperTranscript.normalize("[BLANK_AUDIO] [BLANK_AUDIO]"), "")
  }

  func testPreservesSpokenWordsAndEmbeddedAnnotations() {
    XCTAssertEqual(WhisperTranscript.normalize(" Explain [BLANK_AUDIO]. "), "Explain [BLANK_AUDIO].")
    XCTAssertEqual(WhisperTranscript.normalize("Blank audio"), "Blank audio")
  }
}
