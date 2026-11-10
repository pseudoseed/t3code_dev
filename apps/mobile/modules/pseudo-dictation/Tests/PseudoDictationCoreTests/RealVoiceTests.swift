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

  private func write(_ samples: [Float]) throws -> URL {
    written += 1
    let url = clips.appendingPathComponent("clip-\(written).wav")
    try writeWav(samples, to: url)
    return url
  }

  private func words(_ samples: [Float], onlyMyVoice: Bool) async throws -> (Set<String>, FilterOutcome?) {
    let transcript = try await engine.transcribe(
      requestId: UUID().uuidString, url: try write(samples), model: .fast, processing: .auto,
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

        let own = Self.cut(speaker.held[0], 5)
        let ownSecond = Self.cut(speaker.held[1], 4)
        let theirs = Self.cut(stranger.held[0], 5)
        let theirsShort = Self.cut(stranger.held[1], 2)
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
