import XCTest

@testable import T3VoiceLogic

private func span(_ id: String, _ start: Double, _ end: Double, level: Double? = nil) -> SpeakerSpan {
  SpeakerSpan(speakerId: id, startSeconds: start, endSeconds: end, levelDb: level)
}

final class SpeakerFilterTests: XCTestCase {
  func testKeepsEverythingWhenOnlyOneVoiceIsPresent() {
    let decision = SpeakerFilter.decide(spans: [span("A", 0, 3), span("A", 3.5, 6)])
    XCTAssertEqual(decision, .passThrough(reason: .singleSpeaker))
  }

  func testKeepsEverythingWhenThereIsNoSpeech() {
    XCTAssertEqual(SpeakerFilter.decide(spans: []), .passThrough(reason: .noSpeech))
    XCTAssertEqual(SpeakerFilter.decide(spans: [span("A", 2, 2)]), .passThrough(reason: .noSpeech))
  }

  func testDropsABackgroundVoiceFromTheDominantSpeaker() {
    let decision = SpeakerFilter.decide(spans: [
      span("A", 0, 4),
      span("B", 4.25, 5),
      span("A", 5, 9),
    ])

    XCTAssertEqual(
      decision,
      .filter(
        speakerId: "A",
        // Widened by the edge padding so boundary words survive.
        ranges: [
          KeptRange(startSeconds: 0, endSeconds: 4.2),
          KeptRange(startSeconds: 4.8, endSeconds: 9.2),
        ],
        removedSeconds: 0.75
      )
    )
  }

  func testKeepsEverythingWhenTwoPeopleSpokeAboutEqually() {
    let decision = SpeakerFilter.decide(spans: [span("A", 0, 5), span("B", 5, 9.5)])
    XCTAssertEqual(decision, .passThrough(reason: .ambiguousDominantSpeaker))
  }

  func testFiltersWhenTheDominantSpeakerClearsTheRatio() {
    // 6 seconds against 4 is 1.5x, past the 1.25x bar.
    let decision = SpeakerFilter.decide(spans: [span("A", 0, 6), span("B", 6, 10)])
    XCTAssertEqual(
      decision,
      .filter(speakerId: "A", ranges: [KeptRange(startSeconds: 0, endSeconds: 6.2)], removedSeconds: 4)
    )
  }

  func testKeepsAVoiceAsLoudAsTheDominantOne() {
    // The diarizer split one person at the same distance into two clusters.
    // Dropping B would silently lose the second half of their own dictation.
    let decision = SpeakerFilter.decide(spans: [
      span("A", 0, 30, level: -20),
      span("B", 30, 45, level: -23),
    ])
    XCTAssertEqual(decision, .passThrough(reason: .similarVoices))
  }

  func testDropsAVoiceClearlyFartherFromTheMicrophone() {
    let decision = SpeakerFilter.decide(spans: [
      span("A", 0, 30, level: -20),
      span("B", 30, 45, level: -31),
    ])
    XCTAssertEqual(
      decision,
      .filter(speakerId: "A", ranges: [KeptRange(startSeconds: 0, endSeconds: 30.2)], removedSeconds: 15)
    )
  }

  func testKeepsTheNearerVoiceWhenAFartherOneTalkedMore() {
    // A colleague across the table out-talked the phone's owner. Level says
    // who the owner is; dropping the quieter but shorter speaker would be wrong.
    let decision = SpeakerFilter.decide(spans: [
      span("A", 0, 40, level: -32),
      span("B", 40, 60, level: -20),
    ])
    XCTAssertEqual(decision, .passThrough(reason: .similarVoices))
  }

  func testFallsBackToDurationWhenLevelsAreUnknownForAnyVoice() {
    let decision = SpeakerFilter.decide(spans: [
      span("A", 0, 30, level: -20),
      span("B", 30, 45),
    ])
    XCTAssertEqual(decision, .passThrough(reason: .similarVoices))
  }

  func testWeightsLevelsByDuration() {
    let levels = SpeakerFilter.levelBySpeaker([
      span("A", 0, 9, level: -20),
      span("A", 9, 10, level: -40),
    ])
    XCTAssertEqual(levels["A"]!, -20.45, accuracy: 0.05)
  }

  func testKeepsEverythingWhenTooLittleAudioWouldSurvive() {
    // A wins the ratio but leaves under the minimum kept duration.
    let decision = SpeakerFilter.decide(spans: [
      span("A", 0, 0.7),
      span("B", 1, 1.5),
      span("C", 2, 2.5),
    ])
    XCTAssertEqual(decision, .passThrough(reason: .keptAudioTooShort))
  }

  func testMergesSpansSeparatedByLessThanTheGapTolerance() {
    XCTAssertEqual(
      SpeakerFilter.merge([span("A", 0, 2), span("A", 2.02, 4), span("A", 5, 6)]),
      [
        KeptRange(startSeconds: 0, endSeconds: 4),
        KeptRange(startSeconds: 5, endSeconds: 6),
      ]
    )
  }

  func testDecidesTheSameWayForTheSameAudioWhenSpeakersAreTied() {
    let spans = [span("B", 0, 2), span("A", 2, 4), span("C", 4, 4.2)]
    let first = SpeakerFilter.decide(spans: spans)
    XCTAssertEqual(first, SpeakerFilter.decide(spans: spans.reversed()))
  }
}
