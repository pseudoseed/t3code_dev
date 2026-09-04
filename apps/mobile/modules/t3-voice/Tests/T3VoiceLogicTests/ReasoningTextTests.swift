import XCTest

@testable import T3VoiceLogic

final class ReasoningTextTests: XCTestCase {
  func testRemovesAThinkingBlockFromTheRewrite() {
    XCTAssertEqual(
      ReasoningText.strip("<think>The user said ghosty.</think>Open the Ghostty window."),
      "Open the Ghostty window."
    )
  }

  func testRemovesEveryThinkingBlock() {
    XCTAssertEqual(
      ReasoningText.strip("<think>one</think>Open <think>two</think>the window."),
      "Open the window."
    )
  }

  func testDiscardsAnUnterminatedBlockAndWhatFollowsIt() {
    XCTAssertEqual(
      ReasoningText.strip("Open the window.<think>I should also"),
      "Open the window."
    )
  }

  func testLeavesOutputWithNoThinkingBlockAlone() {
    XCTAssertEqual(ReasoningText.strip("  Open the window.  "), "Open the window.")
  }
}
