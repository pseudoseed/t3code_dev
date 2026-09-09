import XCTest

@testable import T3VoiceLogic

final class ReasoningTextTests: XCTestCase {
  private let thinkingTemplate = "{% if enable_thinking %}<think>{% endif %}"

  func testDisablesThinkingForTheLegacyChatMLGenerationPrefix() {
    XCTAssertEqual(
      ReasoningText.nonThinkingPrompt("<|im_start|>assistant\n", template: thinkingTemplate),
      "<|im_start|>assistant\n<think>\n\n</think>\n\n"
    )
  }

  func testClosesAnAlreadyOpenedThinkingPrefix() {
    XCTAssertEqual(
      ReasoningText.nonThinkingPrompt(
        "<|im_start|>assistant\n<think>\n", template: thinkingTemplate),
      "<|im_start|>assistant\n<think>\n\n</think>\n\n"
    )
  }

  func testLeavesAnAlreadyDisabledThinkingPrefixAlone() {
    let prompt = "<|im_start|>assistant\n<think>\n\n</think>\n\n"
    XCTAssertEqual(ReasoningText.nonThinkingPrompt(prompt, template: thinkingTemplate), prompt)
  }

  func testDoesNotAddThinkingTokensToOtherModels() {
    let prompt = "<|im_start|>assistant\n"
    XCTAssertEqual(ReasoningText.nonThinkingPrompt(prompt, template: nil), prompt)
    XCTAssertEqual(ReasoningText.nonThinkingPrompt(prompt, template: "chatml"), prompt)
  }

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
