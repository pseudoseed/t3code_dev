import XCTest

@testable import PseudoDictationCore

final class SpeakerFilterTests: XCTestCase {
  private func turn(_ speaker: String, _ start: Double, _ end: Double) -> SpeakerTurn {
    SpeakerTurn(speaker: speaker, start: start, end: end)
  }

  /// Unless a test says otherwise the user speaks at -20 dB and everyone else 15 dB under them.
  private func decide(
    _ turns: [SpeakerTurn], _ voices: [TurnVoice], levels: [Float?]? = nil
  ) -> SpeakerDecision {
    SpeakerFilter.decide(
      turns: turns, voices: voices, levels: levels ?? voices.map { $0 == .mine ? -20 : -35 })
  }

  func testAShortTurnMaySitFurtherFromTheProfile() {
    XCTAssertEqual(SpeakerFilter.judge(duration: 3, distance: 0.5), .mine)
    XCTAssertEqual(SpeakerFilter.judge(duration: 3, distance: 0.7), .other)
    XCTAssertEqual(SpeakerFilter.judge(duration: 1.5, distance: 0.7), .mine)
    XCTAssertEqual(SpeakerFilter.judge(duration: 1.5, distance: 0.8), .other)
    XCTAssertEqual(SpeakerFilter.judge(duration: 0.9, distance: 0.1), .unjudged)
  }

  /// A unit vector at `distance` from the profile `[1, 0, 0]`, leaning towards the second or third axis.
  private func voiceprint(_ distance: Float, stranger: Bool = false) -> [Float] {
    let along = 1 - distance
    let across = (1 - along * along).squareRoot()
    return stranger ? [along, 0, across] : [along, across, 0]
  }

  func testATurnTheProfileRejectsIsTheUsersWhenItSoundsLikeTheirOtherTurns() {
    let profile: [Float] = [1, 0, 0]
    // Noise or another microphone moves every turn away from the profile. The opening words pass
    // as a short turn; the half minute after them is the same voice and must not be cut.
    let turns = [turn("a", 0, 1.5), turn("a", 2, 30), turn("b", 30, 35), turn("b", 35, 35.5)]
    let voices = SpeakerFilter.voices(
      turns: turns,
      embeddings: [voiceprint(0.7), voiceprint(0.65), voiceprint(0.65, stranger: true), nil],
      profile: profile)
    XCTAssertEqual(voices, [.mine, .mine, .other, .unjudged])
    XCTAssertEqual(decide(turns, voices), .drop([30...35.5]))

    XCTAssertEqual(
      SpeakerFilter.voices(
        turns: [turn("a", 0, 5), turn("b", 5, 10)],
        embeddings: [voiceprint(0.9), voiceprint(0.9)], profile: profile),
      [.other, .other])
  }

  func testNothingIsCutUnlessTheUserAndSomeoneElseWereBothHeard() {
    let two = [turn("a", 0, 3), turn("b", 3, 6)]
    XCTAssertEqual(decide([], []), .unfiltered(.noSpeech))
    XCTAssertEqual(decide(two, [.unjudged, .unjudged]), .unfiltered(.tooShort))
    XCTAssertEqual(decide(two, [.other, .other]), .unfiltered(.noMatch))
    XCTAssertEqual(decide(two, [.other, .unjudged]), .unfiltered(.noMatch))
    XCTAssertEqual(decide(two, [.mine, .mine]), .unfiltered(.onlyYou))
    XCTAssertEqual(decide(two, [.mine, .unjudged]), .unfiltered(.onlyYou))
  }

  func testNothingIsCutWhenTheUserWasHeardForLessThanTheSpeechToCut() {
    // The profile took three words of a half-minute dictation for the user and the rest for
    // someone else. That is a missed match on their own voice, not a stranger talking for 28 s.
    XCTAssertEqual(
      decide([turn("a", 0, 1.5), turn("a", 2, 30)], [.mine, .other]), .unfiltered(.mostlyOther))
    XCTAssertEqual(
      decide([turn("a", 0, 5), turn("b", 5, 9.2)], [.mine, .other]), .unfiltered(.mostlyOther))
    XCTAssertEqual(decide([turn("a", 0, 5), turn("b", 5, 9)], [.mine, .other]), .drop([5...9]))
  }

  func testAVoiceIsCutOnlyWhenItIsClearlyQuieterThanTheUsers() {
    let turns = [turn("a", 0, 10), turn("a", 10, 14), turn("b", 14, 17)]
    let voices: [TurnVoice] = [.mine, .other, .other]
    // A stretch as loud as the user is as close to the phone as they are, so it may be them.
    XCTAssertEqual(decide(turns, voices, levels: [-20, -22, -26]), .unfiltered(.similarLevel))
    XCTAssertEqual(decide(turns, voices, levels: [-20, -22, -27]), .drop([14...17]))
    XCTAssertEqual(decide(turns, voices, levels: [-20, -27, -27]), .drop([10...17]))
    XCTAssertEqual(decide(turns, voices, levels: [-20, nil, nil]), .unfiltered(.similarLevel))
    XCTAssertEqual(decide(turns, voices, levels: [nil, -40, -40]), .unfiltered(.similarLevel))
  }

  func testLevelIsHowLoudAStretchGetsNotItsMean() throws {
    let rate = 1000.0
    let loud = [Float](repeating: 0.1, count: 20)
    let pause = [Float](repeating: 0.001, count: 20)
    XCTAssertNil(SpeakerFilter.level([], sampleRate: rate))
    XCTAssertNil(SpeakerFilter.level(loud[..<19], sampleRate: rate))
    XCTAssertNil(SpeakerFilter.level([Float](repeating: 0, count: 40)[...], sampleRate: rate))
    // Two frames in ten are speech: the pauses between them do not pull the level down.
    let halting = (0..<10).flatMap { $0 % 5 == 0 ? loud : pause }
    XCTAssertEqual(try XCTUnwrap(SpeakerFilter.level(halting[...], sampleRate: rate)), -20, accuracy: 0.001)
    // One loud frame in twenty is a click, not the voice.
    let click = (0..<20).flatMap { $0 == 7 ? loud : pause }
    XCTAssertEqual(try XCTUnwrap(SpeakerFilter.level(click[...], sampleRate: rate)), -60, accuracy: 0.001)
    XCTAssertEqual(
      try XCTUnwrap(SpeakerFilter.level((pause + loud + pause)[20..<40], sampleRate: rate)), -20,
      accuracy: 0.001)
  }

  func testOnlyTheOtherVoiceIsCutWhateverTheDiarizerCalledIt() {
    let turns = [turn("a", 0, 3), turn("a", 3.5, 7), turn("a", 7.2, 9)]
    XCTAssertEqual(decide(turns, [.mine, .other, .mine]), .drop([3.5...7]))
  }

  func testAShortTurnIsCutOnlyWhenItsSpeakerWasAlwaysSomeoneElse() {
    let turns = [
      turn("a", 0, 5), turn("b", 5, 8), turn("b", 8.2, 8.8), turn("a", 9, 9.5), turn("c", 10, 10.6),
    ]
    let voices: [TurnVoice] = [.mine, .other, .unjudged, .unjudged, .unjudged]
    XCTAssertEqual(decide(turns, voices), .drop([5...8, 8.2...8.8]))
    XCTAssertEqual(decide(turns, voices, levels: [-20, -35, -22, -35, -35]), .drop([5...8]))

    let merged = [turn("a", 0, 4), turn("a", 4, 7), turn("a", 7.2, 7.8)]
    XCTAssertEqual(decide(merged, [.mine, .other, .unjudged]), .drop([4...7]))
  }

  private func assertClose(
    _ actual: [Double], _ expected: [Double], file: StaticString = #filePath, line: UInt = #line
  ) {
    XCTAssertEqual(actual.count, expected.count, "\(actual)", file: file, line: line)
    for (a, b) in zip(actual, expected) {
      XCTAssertEqual(a, b, accuracy: 0.001, "\(actual)", file: file, line: line)
    }
  }

  func testALongTurnIsScannedFromItsStartToItsEnd() {
    XCTAssertEqual(SpeakerFilter.scanWindows(turn("a", 0, 2.9)), [])
    let even = SpeakerFilter.scanWindows(turn("a", 1, 4))
    assertClose(even.map(\.lowerBound), [1, 1.5, 2, 2.5])
    assertClose(even.map(\.upperBound), [2.5, 3, 3.5, 4])
    let uneven = SpeakerFilter.scanWindows(turn("a", 0, 3.2))
    assertClose(uneven.map(\.lowerBound), [0, 0.5, 1, 1.7])
    assertClose(uneven.map(\.upperBound), [1.5, 2, 2.5, 3.2])
  }

  func testATurnIsSplitWhereItsVoiceChanges() {
    let long = turn("a", 0, 6)
    let windows = SpeakerFilter.scanWindows(long)
    XCTAssertEqual(windows.count, 10)
    XCTAssertEqual(
      SpeakerFilter.split(long, windows: windows, distances: [Float](repeating: 0.2, count: 10)), [long])
    XCTAssertEqual(SpeakerFilter.split(turn("a", 0, 2), windows: [], distances: []), [turn("a", 0, 2)])

    // Windows centred at 0.75, 1.25 ... 5.25. The voice changes between 1.75 and 2.25, and back
    // between 3.75 and 4.25, nearer the window that sits closer to the limit of 0.6.
    let pieces = SpeakerFilter.split(
      long, windows: windows, distances: [0.2, 0.2, 0.4, 0.8, 0.9, 0.9, 0.7, 0.3, 0.2, 0.2])
    XCTAssertEqual(pieces.map(\.speaker), ["a", "a", "a"])
    assertClose(pieces.map(\.start), [0, 2, 3.875])
    assertClose(pieces.map(\.end), [2, 3.875, 6])
  }

  func testABlipTooShortToJudgeDoesNotSplitATurn() {
    let long = turn("a", 0, 6)
    let windows = SpeakerFilter.scanWindows(long)
    XCTAssertEqual(
      SpeakerFilter.split(
        long, windows: windows, distances: [0.2, 0.2, 0.2, 0.7, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]),
      [long])
    // The blip inside the other voice is ignored too, so that stretch stays one piece.
    let pieces = SpeakerFilter.split(
      long, windows: windows, distances: [0.2, 0.2, 1.0, 1.0, 0.5, 1.0, 1.0, 1.0, 0.2, 0.2])
    assertClose(pieces.map(\.start), [0, 1.5, 4.5])
    // Of three changes close together, the closest two are the blip.
    let late = SpeakerFilter.split(
      long, windows: windows, distances: [0.2, 0.2, 1.0, 0.5, 1.0, 1.0, 1.0, 1.0, 0.2, 0.2])
    assertClose(late.map(\.start), [0, 1.5, 4.5])
  }

  func testSpeechOverTheUsersOwnTurnIsNotCut() {
    XCTAssertEqual(decide([turn("a", 0, 4), turn("b", 3, 6)], [.mine, .other]), .drop([4...6]))
    XCTAssertEqual(decide([turn("a", 0, 3), turn("b", 2, 8)], [.other, .mine]), .drop([0...2]))
    XCTAssertEqual(
      decide([turn("a", 0, 4), turn("b", 1, 3)], [.mine, .other]), .unfiltered(.overlapping))
    XCTAssertEqual(
      decide([turn("a", 0, 4), turn("b", 3.9, 4.1)], [.mine, .other]), .unfiltered(.overlapping))
  }

  func testTouchingTurnsBecomeOneCut() {
    let turns = [turn("a", 0, 6), turn("b", 6, 8), turn("c", 8, 10), turn("b", 7.5, 8.5)]
    XCTAssertEqual(decide(turns, [.mine, .other, .other, .other]), .drop([6...10]))
  }

  func testCosineDistance() {
    XCTAssertEqual(SpeakerFilter.cosineDistance([1, 0], [2, 0]), 0, accuracy: 1e-6)
    XCTAssertEqual(SpeakerFilter.cosineDistance([1, 0], [0, 3]), 1, accuracy: 1e-6)
    XCTAssertEqual(SpeakerFilter.cosineDistance([1, 0], [-1, 0]), 2, accuracy: 1e-6)
    XCTAssertEqual(SpeakerFilter.cosineDistance([1, 0], [1, 0, 0]), .infinity)
    XCTAssertEqual(SpeakerFilter.cosineDistance([0, 0], [1, 0]), .infinity)
  }

  func testMeanEmbeddingWeighsClipsEquallyWhateverTheirLength() throws {
    let mean = try XCTUnwrap(SpeakerFilter.meanEmbedding([[10, 0], [0, 0.1]]))
    XCTAssertEqual(mean[0], mean[1], accuracy: 1e-6)
    XCTAssertEqual(mean[0] * mean[0] + mean[1] * mean[1], 1, accuracy: 1e-6)
  }

  func testMeanEmbeddingRejectsVectorsItCannotAverage() {
    XCTAssertNil(SpeakerFilter.meanEmbedding([]))
    XCTAssertNil(SpeakerFilter.meanEmbedding([[1, 0], [1, 0, 0]]))
    XCTAssertNil(SpeakerFilter.meanEmbedding([[1, 0], [-1, 0]]))
  }

  func testMeanEmbeddingFollowsItsWeights() throws {
    let mean = try XCTUnwrap(SpeakerFilter.meanEmbedding([[5, 0], [0, 0.2]], weights: [3, 1]))
    XCTAssertEqual(mean[0] / mean[1], 3, accuracy: 1e-5)
    XCTAssertNil(SpeakerFilter.meanEmbedding([[1, 0], [0, 1]], weights: [1]))
  }

  func testRemoveCutsTheRangesAndLeavesASilenceAtEachCut() {
    let samples = (0..<100).map(Float.init)
    let output = SpeakerFilter.remove(samples: samples, ranges: [2...4, 6...7], sampleRate: 10)
    let silence = [Float](repeating: 0, count: Int(SpeakerFilter.joinSilenceSeconds * 10))
    XCTAssertEqual(
      output,
      Array(samples[0..<20]) + silence + Array(samples[40..<60]) + silence + Array(samples[70..<100]))
  }

  func testRemoveAddsNoSilenceAtTheEndsOfTheRecording() {
    let samples = (0..<100).map(Float.init)
    let output = SpeakerFilter.remove(samples: samples, ranges: [0...1, 9...12], sampleRate: 10)
    XCTAssertEqual(output, Array(samples[10..<90]))
  }

  func testAudioGate() {
    let rate = 16_000.0
    let silence = [Float](repeating: 0, count: 16_000)
    let hiss = (0..<16_000).map { _ in Float.random(in: -0.0005...0.0005) }
    let tone = (0..<16_000).map { Float(sin(Double($0) * 2 * .pi * 220 / rate)) * 0.1 }
    XCTAssertFalse(AudioGate.hasSpeech(samples: silence, sampleRate: rate))
    XCTAssertFalse(AudioGate.hasSpeech(samples: hiss, sampleRate: rate))
    XCTAssertTrue(AudioGate.hasSpeech(samples: tone, sampleRate: rate))
    XCTAssertTrue(AudioGate.hasSpeech(samples: silence + Array(tone.prefix(1600)), sampleRate: rate))
    XCTAssertFalse(AudioGate.hasSpeech(samples: Array(tone.prefix(3200)), sampleRate: rate))
  }

  func testMemoryGateTreatsNoReadingAsEnough() {
    XCTAssertTrue(hasEnoughMemory(available: 0, required: 100))
    XCTAssertTrue(hasEnoughMemory(available: 100, required: 100))
    XCTAssertFalse(hasEnoughMemory(available: 99, required: 100))
  }
}
