import Foundation

struct SpeakerTurn: Equatable, Sendable {
  var speaker: String
  var start: Double
  var end: Double

  var duration: Double { end - start }
}

enum TurnVoice: Equatable, Sendable {
  case mine
  case other
  case unjudged
}

enum FilterSkip: String, Sendable {
  case noSpeech
  case noMatch
  case onlyYou
  case tooShort
  case overlapping
  case noProfile
  case notInstalled
  case failed
}

enum SpeakerDecision: Equatable {
  case drop([ClosedRange<Double>])
  case unfiltered(FilterSkip)
}

enum SpeakerFilter {
  // Set from 19 Mini LibriSpeech speakers; RealVoiceTests measures the result. They lean towards
  // keeping a stranger's turn, because cutting the user's own words is the worse error.
  /// Cosine distance to the voice profile at or under which a turn is the enrolled voice.
  static let matchDistance: Float = 0.6
  /// A turn under `shortTurnSeconds` gives a noisier voiceprint, so it has to be further off.
  static let shortTurnMatchDistance: Float = 0.75
  static let shortTurnSeconds = 2.0
  /// Under this a turn says too little about its voice to be judged at all.
  static let minimumJudgedSeconds = 1.0
  /// Enrollment clips further apart than this are not one voice.
  static let agreementDistance: Float = 0.45
  static let minimumDropSeconds = 0.2
  static let joinSilenceSeconds = 0.15
  /// The diarizer joins a short interjection to the turn beside it, so a turn this long is
  /// scanned for a change of voice inside it.
  static let scanSeconds = 3.0
  static let scanWindowSeconds = 1.5
  static let scanHopSeconds = 0.5

  static func normalized(_ vector: [Float]) -> [Float] {
    let length = vector.reduce(Float(0)) { $0 + $1 * $1 }.squareRoot()
    guard length > 0, length.isFinite else { return vector }
    return vector.map { $0 / length }
  }

  /// The unit-length mean of the vectors' directions. Nil when they differ in size or cancel out.
  static func meanEmbedding(_ vectors: [[Float]], weights: [Float]? = nil) -> [Float]? {
    guard let size = vectors.first?.count, size > 0, vectors.allSatisfy({ $0.count == size }),
      weights == nil || weights?.count == vectors.count
    else {
      return nil
    }
    var sum = [Float](repeating: 0, count: size)
    for (position, vector) in vectors.enumerated() {
      let weight = weights?[position] ?? 1
      for (index, value) in normalized(vector).enumerated() { sum[index] += value * weight }
    }
    let mean = normalized(sum)
    return mean.contains(where: { $0 != 0 }) ? mean : nil
  }

  static func cosineDistance(_ a: [Float], _ b: [Float]) -> Float {
    guard a.count == b.count, !a.isEmpty else { return .infinity }
    var dot: Float = 0
    var lengthA: Float = 0
    var lengthB: Float = 0
    for index in a.indices {
      dot += a[index] * b[index]
      lengthA += a[index] * a[index]
      lengthB += b[index] * b[index]
    }
    guard lengthA > 0, lengthB > 0 else { return .infinity }
    return 1 - dot / (lengthA.squareRoot() * lengthB.squareRoot())
  }

  static func judge(duration: Double, distance: Float) -> TurnVoice {
    if duration < minimumJudgedSeconds { return .unjudged }
    let limit = duration < shortTurnSeconds ? shortTurnMatchDistance : matchDistance
    return distance <= limit ? .mine : .other
  }

  /// The windows that scan a turn, evenly spaced, the last one ending where the turn does.
  static func scanWindows(_ turn: SpeakerTurn) -> [Range<Double>] {
    guard turn.duration >= scanSeconds else { return [] }
    let lastStart = turn.end - scanWindowSeconds
    var starts: [Double] = []
    var start = turn.start
    while start < lastStart - scanHopSeconds / 2 {
      starts.append(start)
      start += scanHopSeconds
    }
    starts.append(lastStart)
    return starts.map { $0..<($0 + scanWindowSeconds) }
  }

  /// The turn cut where its voice changes: where the windows' distances to the voice profile
  /// cross `matchDistance`, placed between the two window centres on either side. A stretch
  /// between two changes that is too short to judge is taken for noise and left in place.
  static func split(_ turn: SpeakerTurn, windows: [Range<Double>], distances: [Float]) -> [SpeakerTurn] {
    precondition(windows.count == distances.count)
    var changes: [Double] = []
    for index in windows.indices.dropLast() {
      let (near, far) = (distances[index], distances[index + 1])
      guard (near <= matchDistance) != (far <= matchDistance) else { continue }
      let from = (windows[index].lowerBound + windows[index].upperBound) / 2
      let to = (windows[index + 1].lowerBound + windows[index + 1].upperBound) / 2
      changes.append(from + Double((matchDistance - near) / (far - near)) * (to - from))
    }
    while let closest = changes.indices.dropLast().min(by: {
      changes[$0 + 1] - changes[$0] < changes[$1 + 1] - changes[$1]
    }), changes[closest + 1] - changes[closest] < minimumJudgedSeconds {
      changes.removeSubrange(closest...closest + 1)
    }
    let edges = [turn.start] + changes.filter { $0 > turn.start && $0 < turn.end } + [turn.end]
    return zip(edges, edges.dropFirst()).map { SpeakerTurn(speaker: turn.speaker, start: $0, end: $1) }
  }

  /// What to cut from a recording. Only turns judged to be another voice go, and only where no
  /// kept turn overlaps them. A turn too short to judge goes when its speaker's judged turns were
  /// all another voice. With no turn judged to be the user, nothing is cut: a missed match on
  /// their own voice must not lose the dictation.
  static func decide(turns: [SpeakerTurn], voices: [TurnVoice]) -> SpeakerDecision {
    precondition(turns.count == voices.count)
    if turns.isEmpty { return .unfiltered(.noSpeech) }
    if voices.allSatisfy({ $0 == .unjudged }) { return .unfiltered(.tooShort) }
    if !voices.contains(.mine) { return .unfiltered(.noMatch) }
    if !voices.contains(.other) { return .unfiltered(.onlyYou) }

    var judgedBySpeaker: [String: Set<TurnVoice>] = [:]
    for (turn, voice) in zip(turns, voices) where voice != .unjudged {
      judgedBySpeaker[turn.speaker, default: []].insert(voice)
    }
    var dropped: [ClosedRange<Double>] = []
    var kept: [ClosedRange<Double>] = []
    for (turn, voice) in zip(turns, voices) where turn.end > turn.start {
      let isOther = voice == .other || (voice == .unjudged && judgedBySpeaker[turn.speaker] == [.other])
      if isOther { dropped.append(turn.start...turn.end) } else { kept.append(turn.start...turn.end) }
    }
    let ranges = subtract(merged(dropped), merged(kept)).filter {
      $0.upperBound - $0.lowerBound >= minimumDropSeconds
    }
    return ranges.isEmpty ? .unfiltered(.overlapping) : .drop(ranges)
  }

  static func merged(_ ranges: [ClosedRange<Double>]) -> [ClosedRange<Double>] {
    var output: [ClosedRange<Double>] = []
    for range in ranges.sorted(by: { $0.lowerBound < $1.lowerBound }) {
      if let last = output.last, range.lowerBound <= last.upperBound {
        output[output.count - 1] = last.lowerBound...max(last.upperBound, range.upperBound)
      } else {
        output.append(range)
      }
    }
    return output
  }

  /// `ranges` with every part inside a hole removed. Both lists are sorted and merged.
  static func subtract(_ ranges: [ClosedRange<Double>], _ holes: [ClosedRange<Double>]) -> [ClosedRange<Double>] {
    var output: [ClosedRange<Double>] = []
    for range in ranges {
      var start = range.lowerBound
      for hole in holes where hole.upperBound > start && hole.lowerBound < range.upperBound {
        if hole.lowerBound > start { output.append(start...hole.lowerBound) }
        start = max(start, hole.upperBound)
      }
      if start < range.upperBound { output.append(start...range.upperBound) }
    }
    return output
  }

  /// The recording without `ranges`, with a short silence at each cut so words do not run together.
  static func remove(samples: [Float], ranges: [ClosedRange<Double>], sampleRate: Double) -> [Float] {
    let silence = [Float](repeating: 0, count: Int(joinSilenceSeconds * sampleRate))
    var output: [Float] = []
    var cursor = 0
    func keep(upTo end: Int) {
      guard end > cursor else { return }
      if !output.isEmpty { output.append(contentsOf: silence) }
      output.append(contentsOf: samples[cursor..<end])
    }
    for range in ranges {
      let start = min(max(Int(range.lowerBound * sampleRate), cursor), samples.count)
      keep(upTo: start)
      cursor = min(max(Int(range.upperBound * sampleRate), start), samples.count)
    }
    keep(upTo: samples.count)
    return output
  }

  static func seconds(_ ranges: [ClosedRange<Double>]) -> Double {
    ranges.reduce(0) { $0 + ($1.upperBound - $1.lowerBound) }
  }
}

enum AudioGate {
  static let minimumSeconds = 0.3
  static let floorDecibels: Float = -55
  private static let frameSeconds = 0.02

  /// False for recordings too short or too quiet to hold speech. Speech models write plausible
  /// words for silence, so those recordings never reach one.
  static func hasSpeech(samples: [Float], sampleRate: Double) -> Bool {
    guard Double(samples.count) >= minimumSeconds * sampleRate else { return false }
    let frame = max(Int(frameSeconds * sampleRate), 1)
    var loudest: Float = 0
    var index = 0
    while index + frame <= samples.count {
      var energy: Float = 0
      for sample in samples[index..<(index + frame)] { energy += sample * sample }
      loudest = max(loudest, energy / Float(frame))
      index += frame
    }
    guard loudest > 0 else { return false }
    return 10 * log10(loudest) >= floorDecibels
  }
}
