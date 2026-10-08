import Foundation

/// One stretch of audio attributed to one speaker by the diarizer.
struct SpeakerSpan: Equatable {
  let speakerId: String
  let startSeconds: Double
  let endSeconds: Double
  /// Mean level of the span in dBFS, or nil when the audio was not measured.
  let levelDb: Double?

  init(speakerId: String, startSeconds: Double, endSeconds: Double, levelDb: Double? = nil) {
    self.speakerId = speakerId
    self.startSeconds = startSeconds
    self.endSeconds = endSeconds
    self.levelDb = levelDb
  }

  var duration: Double { max(0, endSeconds - startSeconds) }
}

/// A stretch of audio to keep, after adjacent kept spans have been merged.
struct KeptRange: Equatable {
  let startSeconds: Double
  let endSeconds: Double

  var duration: Double { max(0, endSeconds - startSeconds) }
}

/// Why a dictation was transcribed unfiltered even though filtering was on.
///
/// `singleSpeaker` is not a failure: there was one voice, so nothing was
/// dropped and there is nothing to tell the user. The others mean other
/// voices may be in the transcript, and the composer says so. A silent
/// behaviour change is worse than no feature.
enum SpeakerFilterFallback: String {
  case singleSpeaker
  case noSpeech
  case ambiguousDominantSpeaker
  case keptAudioTooShort
  /// Another voice was about as loud as the dominant one, so it was either
  /// someone equally close to the phone or the user's own voice split in two
  /// by the diarizer. Neither is safe to drop.
  case similarVoices
}

enum SpeakerFilterDecision: Equatable {
  /// Keep these ranges, including foreground speech and unassigned audio.
  /// `removedSeconds` is how much other-speaker audio was dropped, for the
  /// composer to disclose.
  case filter(speakerId: String, ranges: [KeptRange], removedSeconds: Double)
  /// Transcribe everything. The reason is reportable to the user.
  case passThrough(reason: SpeakerFilterFallback)
}

/// Removes clearly quieter speech while preserving possible foreground clusters.
///
/// Dictation has an owner: the person holding the phone. Diarization only says
/// how many voices there were and when, so the rule that turns that into "this
/// one is the user" is here, and it is deliberately conservative. When it
/// cannot tell, it keeps everything and says so, because dropping the user's
/// own words is a far worse failure than leaving a stray voice in.
enum SpeakerFilter {
  /// Require this much speech before using a cluster as the foreground reference.
  static let substantialSpeakerSeconds = 0.5

  /// A loud interjection must not displace the person doing the dictating.
  static let foregroundDurationRatio = 1.25

  /// Kept audio shorter than this is not worth transcribing on its own.
  static let minimumKeptSeconds = 0.75

  /// Kept spans closer together than this merge into one range, so the filtered
  /// audio does not gain artificial cuts inside a single sentence.
  static let mergeGapSeconds = 0.05

  /// Kept spans are widened by this much on each side. Diarizer boundaries land
  /// a fraction of a second inside a word, and the recognizer drops a word it
  /// only hears half of; a sliver of another voice at the edge costs nothing.
  static let edgePaddingSeconds = 0.2

  /// Preserve clusters within this margin of the foreground level. Loudness
  /// is evidence of background speech, not proof of identity or distance.
  /// Keeping similar levels also protects a user's voice split into clusters.
  static let foregroundMarginDb = 6.0

  static func decide(spans: [SpeakerSpan], audioDurationSeconds: Double) -> SpeakerFilterDecision {
    let usable = spans.filter { $0.duration > 0 }.sorted { left, right in
      left.startSeconds == right.startSeconds
        ? left.endSeconds < right.endSeconds
        : left.startSeconds < right.startSeconds
    }

    guard !usable.isEmpty else { return .passThrough(reason: .noSpeech) }

    let grouped = Dictionary(grouping: usable, by: \.speakerId)
    guard grouped.count > 1 else { return .passThrough(reason: .singleSpeaker) }

    // Overlapping diarizer windows must not count the same speech twice.
    let durationBySpeaker = grouped.mapValues { merge($0).reduce(0) { $0 + $1.duration } }
    let levels = levelBySpeaker(usable)
    let candidates = durationBySpeaker.keys.filter {
      durationBySpeaker[$0, default: 0] >= substantialSpeakerSeconds && levels[$0] != nil
    }
    let ranked = candidates.sorted {
      let left = levels[$0, default: -.infinity]
      let right = levels[$1, default: -.infinity]
      return left == right ? $0 < $1 : left > right
    }
    guard let foreground = ranked.first, let foregroundLevel = levels[foreground] else {
      return .passThrough(reason: .ambiguousDominantSpeaker)
    }

    // Duration is not identity: a television can talk longer than the person
    // dictating. Keep every similarly loud cluster (including self-splits),
    // and remove only clusters with clear evidence that they are quieter.
    // Unknown levels never authorize dropping speech, even a brief interjection.
    let removedIds = Set(
      grouped.keys.filter { id in
        guard let level = levels[id] else { return false }
        return foregroundLevel - level > foregroundMarginDb
      })
    guard !removedIds.isEmpty else { return .passThrough(reason: .similarVoices) }

    let foregroundSpans = usable.filter { span in
      guard let level = levels[span.speakerId] else { return false }
      return foregroundLevel - level <= foregroundMarginDb
    }
    let foregroundDuration = merge(foregroundSpans).reduce(0) { $0 + $1.duration }
    guard
      removedIds.allSatisfy({
        foregroundDuration >= durationBySpeaker[$0, default: 0] * foregroundDurationRatio
      })
    else {
      return .passThrough(reason: .ambiguousDominantSpeaker)
    }

    let shouldRemove = { (span: SpeakerSpan) in
      removedIds.contains(span.speakerId) && isQuieter(span, than: foregroundLevel)
    }
    let kept = usable.filter { !shouldRemove($0) }
    let total = merge(kept).reduce(0) { $0 + $1.duration }
    guard total >= minimumKeptSeconds else {
      return .passThrough(reason: .keptAudioTooShort)
    }

    let protectedRanges = merge(
      kept.map { span in
        SpeakerSpan(
          speakerId: span.speakerId,
          startSeconds: max(0, span.startSeconds - edgePaddingSeconds),
          endSeconds: span.endSeconds + edgePaddingSeconds,
          levelDb: span.levelDb
        )
      })

    // Missing diarizer segments are not proof of silence: short foreground
    // phrases can be unassigned. Remove only confirmed quiet intervals, with
    // protected edges; preserve every other sample, including gaps and tails.
    let quiet = usable.filter(shouldRemove)
    let removable = merge(quiet, gapSeconds: 0).compactMap { range -> KeptRange? in
      let start = max(0, range.startSeconds + edgePaddingSeconds)
      let end = min(audioDurationSeconds, range.endSeconds - edgePaddingSeconds)
      return start < end ? KeptRange(startSeconds: start, endSeconds: end) : nil
    }
    let removedRanges = subtract(removable, excluding: protectedRanges)
    let removed = removedRanges.reduce(0) { $0 + $1.duration }
    guard removed > 0 else { return .passThrough(reason: .similarVoices) }
    let ranges = subtract(
      [KeptRange(startSeconds: 0, endSeconds: audioDurationSeconds)], excluding: removedRanges)
    return .filter(speakerId: foreground, ranges: ranges, removedSeconds: removed)
  }

  /// Restore locally foreground audio hidden inside a longer quiet segment.
  /// Diarizer boundaries can cross a word; a segment average hides that word's
  /// level. This safeguard only restores audio and never authorizes a deletion.
  static func protectingLoudAudio(
    _ decision: SpeakerFilterDecision, samples: [Float], sampleRate: Int, foregroundLevel: Double
  ) -> SpeakerFilterDecision {
    guard case .filter(let speakerId, let kept, _) = decision else { return decision }
    let duration = Double(samples.count) / Double(sampleRate)
    let whole = [KeptRange(startSeconds: 0, endSeconds: duration)]
    let removed = subtract(whole, excluding: kept)
    let threshold = pow(10, (foregroundLevel - foregroundMarginDb) / 10)
    // Use the same 100 ms minimum as solo-level measurement, with the same
    // 200 ms edge protection for softer consonants and word endings.
    let window = max(1, sampleRate / 10)
    var protected: [KeptRange] = []
    for start in stride(from: 0, to: samples.count, by: window) {
      let end = min(samples.count, start + window)
      var power = 0.0
      for sample in samples[start..<end] { power += Double(sample) * Double(sample) }
      guard power / Double(end - start) >= threshold else { continue }
      let range = KeptRange(
        startSeconds: max(0, Double(start) / Double(sampleRate) - edgePaddingSeconds),
        endSeconds: min(duration, Double(end) / Double(sampleRate) + edgePaddingSeconds))
      if let last = protected.last, range.startSeconds <= last.endSeconds {
        protected[protected.count - 1] = KeptRange(
          startSeconds: last.startSeconds, endSeconds: range.endSeconds)
      } else {
        protected.append(range)
      }
    }
    let stillRemoved = subtract(removed, excluding: protected)
    let removedSeconds = stillRemoved.reduce(0) { $0 + $1.duration }
    guard removedSeconds > 0 else { return .passThrough(reason: .similarVoices) }
    return .filter(
      speakerId: speakerId, ranges: subtract(whole, excluding: stillRemoved),
      removedSeconds: removedSeconds)
  }

  private static func isQuieter(_ span: SpeakerSpan, than foregroundLevel: Double) -> Bool {
    guard let level = span.levelDb, level.isFinite else { return false }
    return foregroundLevel - level > foregroundMarginDb
  }

  /// Duration-weighted mean level per speaker, in dBFS. Speakers with no
  /// measured span are absent, which the caller treats as "cannot tell".
  static func levelBySpeaker(_ spans: [SpeakerSpan]) -> [String: Double] {
    var power: [String: (weighted: Double, duration: Double)] = [:]
    for span in spans {
      guard let level = span.levelDb, level.isFinite, span.duration > 0 else { continue }
      let linear = pow(10, level / 10)
      let current = power[span.speakerId, default: (0, 0)]
      power[span.speakerId] = (
        current.weighted + linear * span.duration, current.duration + span.duration
      )
    }
    let unmeasured = Set(spans.filter { $0.levelDb?.isFinite != true }.map(\.speakerId))
    return power.filter { !unmeasured.contains($0.key) }.compactMapValues { entry in
      entry.duration > 0 ? 10 * log10(entry.weighted / entry.duration) : nil
    }
  }

  /// Only solo speech can tell us a speaker's level. Measuring a quiet voice
  /// while the foreground speaker overlaps it would assign both the same level.
  static func soloRanges(speakerId: String, spans: [SpeakerSpan]) -> [KeptRange] {
    let own = merge(spans.filter { $0.speakerId == speakerId }, gapSeconds: 0)
    let others = merge(spans.filter { $0.speakerId != speakerId }, gapSeconds: 0)
    return subtract(own, excluding: others)
  }

  /// Subtracts sorted, disjoint intervals without treating unassigned gaps as speech.
  private static func subtract(_ ranges: [KeptRange], excluding excluded: [KeptRange]) -> [KeptRange] {
    var result: [KeptRange] = []
    for range in ranges {
      var start = range.startSeconds
      for other in excluded {
        if other.endSeconds <= start { continue }
        if other.startSeconds >= range.endSeconds { break }
        if other.startSeconds > start {
          result.append(KeptRange(startSeconds: start, endSeconds: other.startSeconds))
        }
        start = max(start, other.endSeconds)
        if start >= range.endSeconds { break }
      }
      if start < range.endSeconds {
        result.append(KeptRange(startSeconds: start, endSeconds: range.endSeconds))
      }
    }
    return result
  }

  static func merge(_ spans: [SpeakerSpan], gapSeconds: Double = mergeGapSeconds) -> [KeptRange] {
    var merged: [KeptRange] = []

    for span in spans.sorted(by: { $0.startSeconds < $1.startSeconds }) {
      guard let last = merged.last else {
        merged.append(KeptRange(startSeconds: span.startSeconds, endSeconds: span.endSeconds))
        continue
      }

      if span.startSeconds - last.endSeconds <= gapSeconds {
        merged[merged.count - 1] = KeptRange(
          startSeconds: last.startSeconds,
          endSeconds: max(last.endSeconds, span.endSeconds)
        )
      } else {
        merged.append(KeptRange(startSeconds: span.startSeconds, endSeconds: span.endSeconds))
      }
    }

    return merged
  }
}
