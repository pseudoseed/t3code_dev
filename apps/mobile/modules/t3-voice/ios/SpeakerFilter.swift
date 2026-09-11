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
  /// Keep only these ranges, which all belong to the dominant speaker.
  /// `removedSeconds` is how much other-speaker audio was dropped, for the
  /// composer to disclose.
  case filter(speakerId: String, ranges: [KeptRange], removedSeconds: Double)
  /// Transcribe everything. The reason is reportable to the user.
  case passThrough(reason: SpeakerFilterFallback)
}

/// Picks the one voice a dictation belongs to.
///
/// Dictation has an owner: the person holding the phone. Diarization only says
/// how many voices there were and when, so the rule that turns that into "this
/// one is the user" is here, and it is deliberately conservative. When it
/// cannot tell, it keeps everything and says so, because dropping the user's
/// own words is a far worse failure than leaving a stray voice in.
enum SpeakerFilter {
  /// A speaker under this much total speech is background, not a participant.
  static let substantialSpeakerSeconds = 0.5

  /// How far ahead of the runner-up the dominant speaker has to be.
  ///
  /// Two people talking roughly equally is a conversation, not a dictation with
  /// background noise, and guessing which one to keep would be a coin flip.
  static let dominantSpeakerRatio = 1.25

  /// Kept audio shorter than this is not worth transcribing on its own.
  static let minimumKeptSeconds = 0.75

  /// Kept spans closer together than this merge into one range, so the filtered
  /// audio does not gain artificial cuts inside a single sentence.
  static let mergeGapSeconds = 0.05

  /// Kept spans are widened by this much on each side. Diarizer boundaries land
  /// a fraction of a second inside a word, and the recognizer drops a word it
  /// only hears half of; a sliver of another voice at the edge costs nothing.
  static let edgePaddingSeconds = 0.2

  /// A voice within this much of the dominant speaker's level is as close to
  /// the microphone as they are. The person holding the phone is the loudest
  /// voice in a dictation, and a diarizer that splits one person into two
  /// clusters produces two voices at the same level; a voice across the room
  /// is 10 dB or more down. Six decibels is a doubling of distance.
  static let sameDistanceDb = 6.0

  static func decide(spans: [SpeakerSpan]) -> SpeakerFilterDecision {
    let usable = spans.filter { $0.duration > 0 }.sorted { left, right in
      left.startSeconds == right.startSeconds
        ? left.endSeconds < right.endSeconds
        : left.startSeconds < right.startSeconds
    }

    guard !usable.isEmpty else { return .passThrough(reason: .noSpeech) }

    var durationBySpeaker: [String: Double] = [:]
    for span in usable {
      durationBySpeaker[span.speakerId, default: 0] += span.duration
    }

    if durationBySpeaker.count == 1 {
      return .passThrough(reason: .singleSpeaker)
    }

    // Ties broken by id so the same audio always produces the same decision.
    let ranked = durationBySpeaker
      .sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
      .filter { $0.value >= substantialSpeakerSeconds }

    guard let dominant = ranked.first else {
      return .passThrough(reason: .noSpeech)
    }

    if ranked.count == 1 {
      // Everyone else was brief enough to be background. Filter to the one
      // speaker who actually said something.
      return filtered(speakerId: dominant.key, spans: usable)
    }

    guard let runnerUp = ranked.dropFirst().first,
      dominant.value >= runnerUp.value * dominantSpeakerRatio
    else {
      return .passThrough(reason: .ambiguousDominantSpeaker)
    }

    // Talking the most is not proof of being the user: the diarizer can split
    // one person in two, and a colleague can out-talk the phone's owner. Only
    // a voice that is clearly farther from the microphone is dropped.
    let levels = levelBySpeaker(usable)
    if let dominantLevel = levels[dominant.key] {
      let near = ranked.dropFirst().contains { speaker in
        guard let level = levels[speaker.key] else { return true }
        return level >= dominantLevel - sameDistanceDb
      }
      if near { return .passThrough(reason: .similarVoices) }
    }

    return filtered(speakerId: dominant.key, spans: usable)
  }

  private static func filtered(speakerId: String, spans: [SpeakerSpan]) -> SpeakerFilterDecision {
    let kept = spans.filter { $0.speakerId == speakerId }
    let total = merge(kept).reduce(0) { $0 + $1.duration }
    guard total >= minimumKeptSeconds else {
      return .passThrough(reason: .keptAudioTooShort)
    }

    let ranges = merge(
      kept.map { span in
        SpeakerSpan(
          speakerId: span.speakerId,
          startSeconds: max(0, span.startSeconds - edgePaddingSeconds),
          endSeconds: span.endSeconds + edgePaddingSeconds,
          levelDb: span.levelDb
        )
      })

    let removed = spans.filter { $0.speakerId != speakerId }.reduce(0) { $0 + $1.duration }
    return .filter(speakerId: speakerId, ranges: ranges, removedSeconds: removed)
  }

  /// Duration-weighted mean level per speaker, in dBFS. Speakers with no
  /// measured span are absent, which the caller treats as "cannot tell".
  static func levelBySpeaker(_ spans: [SpeakerSpan]) -> [String: Double] {
    var power: [String: (weighted: Double, duration: Double)] = [:]
    for span in spans {
      guard let level = span.levelDb, span.duration > 0 else { continue }
      let linear = pow(10, level / 10)
      let current = power[span.speakerId, default: (0, 0)]
      power[span.speakerId] = (current.weighted + linear * span.duration, current.duration + span.duration)
    }
    return power.compactMapValues { entry in
      entry.duration > 0 ? 10 * log10(entry.weighted / entry.duration) : nil
    }
  }

  static func merge(_ spans: [SpeakerSpan]) -> [KeptRange] {
    var merged: [KeptRange] = []

    for span in spans.sorted(by: { $0.startSeconds < $1.startSeconds }) {
      guard let last = merged.last else {
        merged.append(KeptRange(startSeconds: span.startSeconds, endSeconds: span.endSeconds))
        continue
      }

      if span.startSeconds - last.endSeconds <= mergeGapSeconds {
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
