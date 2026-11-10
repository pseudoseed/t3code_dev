import XCTest

@testable import PseudoDictationCore

/// Measures enrollment and the voice filter on recordings of real people, through the engine.
/// The synthetic voices in `RealModelTests` are far easier to tell apart than people are, so the
/// thresholds in `SpeakerFilter` are judged here.
///
/// Skipped unless `PSEUDO_DICTATION_MODELS` names the model directory and `PSEUDO_DICTATION_VOICES`
/// names a LibriSpeech-layout directory (`<speaker>/<chapter>/*.flac`), such as Mini LibriSpeech
/// `dev-clean-2` from https://www.openslr.org/31/:
///
///     PSEUDO_DICTATION_MODELS=/path/to/models PSEUDO_DICTATION_VOICES=/path/to/dev-clean-2 \
///       swift test --filter RealVoiceTests
final class RealVoiceTests: XCTestCase {
  private struct Speaker {
    var name: String
    var enrollment: [[Float]]
    var held: [[Float]]
  }

  private var storage: DictationStorage!
  private var engine: DictationEngine!
  private var clips: URL!
  private var speakers: [Speaker] = []
  private var written = 0

  override func setUpWithError() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let models = environment["PSEUDO_DICTATION_MODELS"], !models.isEmpty,
      let voices = environment["PSEUDO_DICTATION_VOICES"], !voices.isEmpty
    else {
      throw XCTSkip("Set PSEUDO_DICTATION_MODELS and PSEUDO_DICTATION_VOICES to run on real voices.")
    }
    storage = DictationStorage(root: URL(fileURLWithPath: models, isDirectory: true))
    try storage.prepare()
    try storage.deleteVoiceProfile()
    engine = DictationEngine(
      storage: storage,
      environment: DictationEnvironment(
        appBuild: "harness", osBuild: ProcessInfo.processInfo.operatingSystemVersionString,
        isSimulator: false, availableMemory: { 0 }, freeDisk: { _ in nil }))
    clips = FileManager.default.temporaryDirectory
      .appendingPathComponent("pseudo-dictation-voices-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: clips, withIntermediateDirectories: true)
    speakers = try Self.loadSpeakers(URL(fileURLWithPath: voices, isDirectory: true))
    XCTAssertGreaterThanOrEqual(speakers.count, 10, "Too few speakers with enough long utterances")
  }

  override func tearDownWithError() throws {
    if let clips { try? FileManager.default.removeItem(at: clips) }
    try storage?.deleteVoiceProfile()
  }

  // MARK: Fixtures

  /// Three utterances of at least 7 s to enroll with and at least three more to test on, taken
  /// from across the speaker's chapters so the sessions differ.
  private static func loadSpeakers(_ root: URL) throws -> [Speaker] {
    let files = FileManager.default
    var speakers: [Speaker] = []
    for name in try files.contentsOfDirectory(atPath: root.path).sorted() where Int(name) != nil {
      var utterances: [URL] = []
      let directory = root.appendingPathComponent(name)
      for chapter in try files.contentsOfDirectory(atPath: directory.path).sorted() {
        let chapterDirectory = directory.appendingPathComponent(chapter)
        utterances += try files.contentsOfDirectory(atPath: chapterDirectory.path).sorted()
          .filter { $0.hasSuffix(".flac") }.map { chapterDirectory.appendingPathComponent($0) }
      }
      var long: [[Float]] = []
      for index in stride(from: 0, to: utterances.count, by: max(1, utterances.count / 14)) {
        let samples = try DictationEngine.decode(utterances[index])
        if samples.count >= Int(7 * DictationEngine.sampleRate) { long.append(samples) }
        if long.count == 9 { break }
      }
      guard long.count >= 6 else { continue }
      speakers.append(
        Speaker(
          name: name, enrollment: long.prefix(3).map { cut($0, 8) }, held: Array(long.dropFirst(3))))
    }
    return speakers
  }

  private static func cut(_ samples: [Float], _ seconds: Double) -> [Float] {
    Array(samples.prefix(Int(seconds * DictationEngine.sampleRate)))
  }

  /// The voice 12 dB under `own`: about four times further from the phone than the person holding
  /// it. The corpus records each reader at a different level, so the gap is set, not assumed.
  private static func distant(_ samples: [Float], from own: [Float]) -> [Float] {
    func power(_ clip: [Float]) -> Float { clip.reduce(Float(0)) { $0 + $1 * $1 } / Float(clip.count) }
    let gain = 0.25 * (power(own) / power(samples)).squareRoot()
    return samples.map { $0 * gain }
  }

  private func write(_ samples: [Float]) throws -> URL {
    written += 1
    let url = clips.appendingPathComponent("clip-\(written).wav")
    try writeWav(samples, to: url)
    return url
  }

  private func words(
    _ samples: [Float], onlyMyVoice: Bool, model: DictationModel = .fast, asPhoneRecording: Bool = false
  ) async throws -> (Set<String>, FilterOutcome?) {
    var url = try write(samples)
    if asPhoneRecording {
      url = url.deletingPathExtension().appendingPathExtension("m4a")
      try writePhoneRecording(samples, to: url)
    }
    let transcript = try await engine.transcribe(
      requestId: UUID().uuidString, url: url, model: model, processing: .auto,
      onlyMyVoice: onlyMyVoice, language: "en-US")
    let words = transcript.text.lowercased().split(whereSeparator: { !$0.isLetter }).map(String.init)
    return (Set(words), transcript.filter)
  }

  private func seconds(_ samples: [Float]) -> Double {
    Double(samples.count) / DictationEngine.sampleRate
  }

  private func percent(_ part: Int, _ whole: Int) -> String {
    String(format: "%d of %d (%.1f%%)", part, whole, whole == 0 ? 0 : 100 * Double(part) / Double(whole))
  }

  // MARK: Enrollment

  func testEnrollmentAcceptsOnePersonAndRejectsAMixOfTwo() async throws {
    try await engine.download(.voiceFilter, processing: .auto, onProgress: { _ in })
    var ownRejected: [String] = []
    var mixAccepted: [String] = []
    var mixes = 0
    for (index, speaker) in speakers.enumerated() {
      do {
        try await engine.saveVoiceProfile(try speaker.enrollment.map(write))
      } catch {
        ownRejected.append("\(speaker.name): \(error)")
      }
      for offset in [1, speakers.count / 2] {
        let stranger = speakers[(index + offset) % speakers.count]
        mixes += 1
        do {
          try await engine.saveVoiceProfile(
            try [speaker.enrollment[0], speaker.enrollment[1], stranger.enrollment[2]].map(write))
          mixAccepted.append("\(speaker.name) with \(stranger.name)")
        } catch {
          XCTAssertEqual(error as? DictationError, .enrollmentRejected(.clipsDisagree))
        }
      }
    }
    print("MEASURE enrollment, one person rejected: \(percent(ownRejected.count, speakers.count)) \(ownRejected)")
    print("MEASURE enrollment, two people accepted: \(percent(mixAccepted.count, mixes)) \(mixAccepted)")
    XCTAssertEqual(ownRejected, [])
    XCTAssertLessThanOrEqual(Double(mixAccepted.count) / Double(mixes), 0.05)
  }

  // MARK: Long recordings

  /// People dictate for longer than any other clip here, and the phone hands over AAC, not WAV.
  func testAHalfMinuteOfSpeechFromThePhoneIsTranscribedInFull() async throws {
    try await engine.download(.voiceFilter, processing: .auto, onProgress: { _ in })
    var lost: [String] = []
    for model in [DictationModel.fast, .balanced, .accurate] {
      try await engine.download(model, processing: .auto, onProgress: { _ in })
      for speaker in speakers.prefix(4) {
        try await engine.saveVoiceProfile(try speaker.enrollment.map(write))
        var recording: [Float] = []
        var expected: Set<String> = []
        for utterance in speaker.held where seconds(recording) < 30 {
          recording += utterance
          expected.formUnion(try await words(utterance, onlyMyVoice: false, model: model).0)
        }
        XCTAssertGreaterThanOrEqual(seconds(recording), 30)
        for onlyMyVoice in [false, true] {
          let (heard, outcome) = try await words(
            recording, onlyMyVoice: onlyMyVoice, model: model, asPhoneRecording: true)
          let missing = expected.subtracting(heard).count
          print(
            "MEASURE long, \(model.rawValue) \(speaker.name) \(Int(seconds(recording))) s, filter "
              + "\(onlyMyVoice): lost \(percent(missing, expected.count)), "
              + "cut \(outcome?.droppedSeconds ?? 0) s")
          if Double(missing) / Double(expected.count) > 0.05 {
            lost.append("\(model.rawValue) \(speaker.name) filter \(onlyMyVoice): \(percent(missing, expected.count))")
          }
        }
      }
    }
    XCTAssertEqual(lost, [])
  }

  // MARK: Sound unlike enrollment

  /// White noise under the speech, `snr` decibels below it. The seed is fixed so runs agree.
  private static func noisy(_ samples: [Float], snr: Float) -> [Float] {
    let power = samples.reduce(Float(0)) { $0 + $1 * $1 } / Float(samples.count)
    let peak = (3 * power).squareRoot() / pow(10, snr / 20)
    var state: UInt64 = 0x9E37_79B9_7F4A_7C15
    return samples.map { sample in
      state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
      return sample + peak * (Float(state >> 40) / Float(1 << 24) * 2 - 1)
    }
  }

  /// Roughly a telephone headset: the top and the bottom of the voice are gone.
  private static func narrowband(_ samples: [Float]) -> [Float] {
    var output = samples
    var low: Float = 0
    var lower: Float = 0
    var rumble: Float = 0
    for index in samples.indices {
      low += 0.72 * (samples[index] - low)
      lower += 0.72 * (low - lower)
      rumble = 0.89 * rumble + 0.11 * lower
      output[index] = index % 2 == 0 ? lower - rumble : output[index - 1]
    }
    return output
  }

  /// A small room with hard walls.
  private static func echoing(_ samples: [Float]) -> [Float] {
    var output = samples
    for (delay, gain) in [(464, Float(0.55)), (592, 0.5), (688, 0.45), (1104, 0.4)] {
      var echo = [Float](repeating: 0, count: samples.count)
      for index in samples.indices.dropFirst(delay) {
        echo[index] = gain * (samples[index - delay] + echo[index - delay])
        output[index] += 0.35 * echo[index]
      }
    }
    return output
  }

  /// The profile is recorded once, somewhere quiet. People then dictate in a car, in a kitchen or
  /// over a headset, where their voice sits further from it, and that must not cost them words.
  func testTheFilterKeepsTheSpeakersWordsWhereTheSoundIsUnlikeEnrollment() async throws {
    try await engine.download(.fast, processing: .auto, onProgress: { _ in })
    try await engine.download(.voiceFilter, processing: .auto, onProgress: { _ in })
    let conditions: [(name: String, change: ([Float]) -> [Float])] = [
      ("noise at 5 dB", { Self.noisy($0, snr: 5) }),
      ("narrowband", Self.narrowband),
      ("narrowband with noise at 5 dB", { Self.noisy(Self.narrowband($0), snr: 5) }),
      ("echo with noise at 10 dB", { Self.noisy(Self.echoing($0), snr: 10) }),
    ]
    var tallies = conditions.map { _ in (own: 0, ownLost: 0, stranger: 0, strangerKept: 0) }

    for (index, speaker) in speakers.prefix(8).enumerated() {
      try await engine.saveVoiceProfile(try speaker.enrollment.map(write))
      let stranger = speakers[(index + speakers.count / 2) % speakers.count]
      var alone: [Float] = []
      for utterance in speaker.held where seconds(alone) < 30 { alone += utterance }

      for (position, condition) in conditions.enumerated() {
        let recording = condition.change(alone)
        let spoken = try await words(recording, onlyMyVoice: false).0
        let (kept, outcome) = try await words(recording, onlyMyVoice: true)
        tallies[position].own += spoken.count
        tallies[position].ownLost += spoken.subtracting(kept).count
        print(
          "MEASURE unlike enrollment, \(condition.name), \(speaker.name) alone for "
            + "\(Int(seconds(alone))) s: lost \(percent(spoken.subtracting(kept).count, spoken.count)), "
            + "cut \(outcome?.droppedSeconds ?? 0) s")

        // The other voice is across the room, under the same noise or through the same headset.
        let own = Self.cut(speaker.held[0], 8)
        let theirs = Self.distant(Self.cut(stranger.held[0], 4), from: own)
        let unwanted = try await words(condition.change(own + theirs), onlyMyVoice: false).0
          .subtracting(try await words(condition.change(own), onlyMyVoice: false).0)
        let heard = try await words(condition.change(own + theirs), onlyMyVoice: true).0
        tallies[position].stranger += unwanted.count
        tallies[position].strangerKept += unwanted.intersection(heard).count
      }
    }

    for (condition, tally) in zip(conditions, tallies) {
      print(
        "MEASURE unlike enrollment, \(condition.name): speaker's words lost "
          + "\(percent(tally.ownLost, tally.own)), stranger's words kept "
          + "\(percent(tally.strangerKept, tally.stranger))")
      XCTAssertLessThanOrEqual(Double(tally.ownLost) / Double(tally.own), 0.05, condition.name)
      XCTAssertLessThanOrEqual(
        Double(tally.strangerKept) / Double(tally.stranger), 0.15, condition.name)
    }
  }

  // MARK: Voice filter

  func testTheFilterKeepsTheSpeakersWordsAndDropsTheStrangers() async throws {
    try await engine.download(.fast, processing: .auto, onProgress: { _ in })
    try await engine.download(.voiceFilter, processing: .auto, onProgress: { _ in })

    var recordings = 0
    var unfilteredRecordings: [String] = []
    var ownWords = 0
    var ownWordsLost = 0
    var strangerWords = 0
    var strangerWordsKept = 0
    var cutError: [Double] = []
    var layouts: [String: (ownWords: Int, ownLost: Int, strangerWords: Int, strangerKept: Int)] = [:]
    var soloRecordings = 0
    var soloCut: [String] = []
    var strangerSolo = 0
    var strangerSoloCut: [String] = []

    for (index, speaker) in speakers.enumerated() {
      try await engine.saveVoiceProfile(try speaker.enrollment.map(write))

      for utterance in speaker.held.prefix(3) {
        soloRecordings += 1
        let (_, outcome) = try await words(Self.cut(utterance, 6), onlyMyVoice: true)
        if outcome?.applied == true {
          soloCut.append("\(speaker.name) lost \(outcome?.droppedSeconds ?? 0) s")
        }
      }

      for offset in [1, speakers.count / 2] {
        let stranger = speakers[(index + offset) % speakers.count]
        strangerSolo += 1
        let (_, soloOutcome) = try await words(Self.cut(stranger.held[2], 6), onlyMyVoice: true)
        if soloOutcome?.applied == true { strangerSoloCut.append("\(stranger.name) as \(speaker.name)") }

        // A dictation is mostly its owner, and anyone else is further from the phone.
        let own = Self.cut(speaker.held[0], 8)
        let ownSecond = Self.cut(speaker.held[1], 4)
        let theirs = Self.distant(Self.cut(stranger.held[0], 4), from: own)
        let theirsShort = Self.distant(Self.cut(stranger.held[1], 2), from: own)
        let cases: [(name: String, mine: [[Float]], theirs: [Float], samples: [Float])] = [
          ("mine then theirs", [own], theirs, own + theirs),
          ("theirs then mine", [own], theirs, theirs + own),
          ("theirs between mine", [own, ownSecond], theirsShort, own + theirsShort + ownSecond),
        ]
        for recording in cases {
          recordings += 1
          var expected: Set<String> = []
          for piece in recording.mine {
            expected.formUnion(try await words(piece, onlyMyVoice: false).0)
          }
          let unwanted = try await words(recording.theirs, onlyMyVoice: false).0.subtracting(expected)
          let (heard, outcome) = try await words(recording.samples, onlyMyVoice: true)
          ownWords += expected.count
          ownWordsLost += expected.subtracting(heard).count
          strangerWords += unwanted.count
          strangerWordsKept += unwanted.intersection(heard).count
          var layout = layouts[recording.name] ?? (0, 0, 0, 0)
          layout.ownWords += expected.count
          layout.ownLost += expected.subtracting(heard).count
          layout.strangerWords += unwanted.count
          layout.strangerKept += unwanted.intersection(heard).count
          layouts[recording.name] = layout
          if let outcome, outcome.applied {
            cutError.append(abs(outcome.droppedSeconds - seconds(recording.theirs)))
          } else {
            unfilteredRecordings.append(
              "\(speaker.name)/\(stranger.name) \(recording.name): \(String(describing: outcome?.skipped))")
          }
        }
      }
    }

    let sortedError = cutError.sorted()
    print("MEASURE filter, speakers: \(speakers.count), mixed recordings: \(recordings)")
    print("MEASURE filter, mixed recordings left whole: \(percent(unfilteredRecordings.count, recordings)) \(unfilteredRecordings)")
    print("MEASURE filter, speaker's words lost: \(percent(ownWordsLost, ownWords))")
    print("MEASURE filter, stranger's words kept: \(percent(strangerWordsKept, strangerWords))")
    for (name, layout) in layouts.sorted(by: { $0.key < $1.key }) {
      print(
        "MEASURE filter, \(name): speaker's words lost \(percent(layout.ownLost, layout.ownWords)), "
          + "stranger's words kept \(percent(layout.strangerKept, layout.strangerWords))")
    }
    print(
      "MEASURE filter, cut length error: median \(sortedError[sortedError.count / 2]) s, "
        + "worst \(sortedError.last ?? -1) s")
    print("MEASURE filter, speaker alone and cut: \(percent(soloCut.count, soloRecordings)) \(soloCut)")
    print("MEASURE filter, stranger alone and cut: \(percent(strangerSoloCut.count, strangerSolo)) \(strangerSoloCut)")

    XCTAssertLessThanOrEqual(Double(ownWordsLost) / Double(ownWords), 0.05)
    XCTAssertLessThanOrEqual(Double(strangerWordsKept) / Double(strangerWords), 0.15)
    XCTAssertLessThanOrEqual(Double(soloCut.count) / Double(soloRecordings), 0.02)
  }
}
