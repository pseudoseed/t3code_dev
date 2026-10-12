import Foundation

enum WhisperTranscript {
  static func normalize(_ text: String) -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    // tiny.en can emit this literal annotation for silence despite skipping
    // special tokens. Only an annotation-only result means no speech.
    let withoutSilence = trimmed.replacingOccurrences(of: "[BLANK_AUDIO]", with: "")
    return withoutSilence.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : trimmed
  }
}
