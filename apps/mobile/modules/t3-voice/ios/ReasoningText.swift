import Foundation

/// Cleanup output as the model actually emits it.
enum ReasoningText {
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
