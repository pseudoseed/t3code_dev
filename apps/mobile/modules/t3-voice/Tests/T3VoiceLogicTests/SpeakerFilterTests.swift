import XCTest

@testable import T3VoiceLogic

private func span(_ id: String, _ start: Double, _ end: Double) -> SpeakerSpan {
  SpeakerSpan(speakerId: id, startSeconds: start, endSeconds: end)
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
      span("B", 4.2, 4.9),
      span("A", 5, 9),
    ])

    XCTAssertEqual(
      decision,
      .filter(
        speakerId: "A",
        ranges: [
          KeptRange(startSeconds: 0, endSeconds: 4),
          KeptRange(startSeconds: 5, endSeconds: 9),
        ]
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
      .filter(speakerId: "A", ranges: [KeptRange(startSeconds: 0, endSeconds: 6)])
    )
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
