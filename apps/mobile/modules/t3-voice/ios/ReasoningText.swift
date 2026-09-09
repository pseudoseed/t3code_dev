import Foundation

/// Cleanup output as the model actually emits it.
enum ReasoningText {
  /// Matches the model template's `enable_thinking=false` generation prefix.
  /// The legacy llama.cpp template API does not evaluate that Jinja option.
  /// Without the closed block, larger Qwen models can use the whole cleanup
  /// budget on reasoning and never emit the transcript.
  static func nonThinkingPrompt(_ prompt: String, template: String?) -> String {
    guard let template, template.contains("enable_thinking"), template.contains("<think>") else {
      return prompt
    }

    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.hasSuffix("</think>") { return prompt }
    if trimmed.hasSuffix("<think>") { return trimmed + "\n\n</think>\n\n" }
    return prompt + "<think>\n\n</think>\n\n"
  }

  /// Removes the reasoning block a thinking model writes before its answer.
  ///
  /// Qwen emits `<think>...</think>` ahead of the rewrite. The tokens are not
  /// special tokens, so nothing upstream filters them and they land in the
  /// composer. An unterminated block means generation stopped mid-thought, and
  /// everything after the opening tag goes with it.
  static func strip(_ text: String) -> String {
    var result = text
    while let open = result.range(of: "<think>") {
      guard let close = result.range(of: "</think>", range: open.upperBound..<result.endIndex)
      else {
        result = String(result[result.startIndex..<open.lowerBound])
        break
      }

      result =
        String(result[result.startIndex..<open.lowerBound])
        + String(result[close.upperBound..<result.endIndex])
    }

    return result.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
