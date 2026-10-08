import XCTest

@testable import T3VoiceLogic

private func span(_ id: String, _ start: Double, _ end: Double, level: Double? = nil) -> SpeakerSpan
{
  SpeakerSpan(speakerId: id, startSeconds: start, endSeconds: end, levelDb: level)
}

private func decision(spans: [SpeakerSpan], duration: Double? = nil) -> SpeakerFilterDecision {
  SpeakerFilter.decide(
    spans: spans, audioDurationSeconds: duration ?? spans.map(\.endSeconds).max() ?? 0)
}

final class SpeakerFilterTests: XCTestCase {
  private func assertFiltered(
    _ spans: [SpeakerSpan], foreground: String = "A", ranges: [KeptRange], removed: Double,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    guard
      case .filter(let speakerId, let actualRanges, let removedSeconds) = decision(
        spans: spans)
    else {
      XCTFail("Expected background speech to be filtered", file: file, line: line)
      return
    }
    XCTAssertEqual(speakerId, foreground, file: file, line: line)
    XCTAssertEqual(actualRanges, ranges, file: file, line: line)
    XCTAssertEqual(removedSeconds, removed, accuracy: 0.001, file: file, line: line)
  }

  func testKeepsEverythingWhenOnlyOneVoiceIsPresent() {
    XCTAssertEqual(
      decision(spans: [span("A", 0, 3), span("A", 3.5, 6)]),
      .passThrough(reason: .singleSpeaker))
  }

  func testKeepsEverythingWhenThereIsNoSpeech() {
    XCTAssertEqual(decision(spans: []), .passThrough(reason: .noSpeech))
    XCTAssertEqual(decision(spans: [span("A", 2, 2)]), .passThrough(reason: .noSpeech))
  }

  func testDropsBackgroundSpeechAndCountsOnlyAudioActuallyRemoved() {
    assertFiltered(
      [
        span("A", 0, 4, level: -20), span("B", 4.25, 5, level: -32), span("A", 5, 9, level: -20),
      ],
      ranges: [
        KeptRange(startSeconds: 0, endSeconds: 4.45), KeptRange(startSeconds: 4.8, endSeconds: 9),
      ], removed: 0.35)
  }

  func testAbstainsWhenDurationAndLevelDisagree() {
    XCTAssertEqual(
      decision(spans: [
        span("TV", 0, 40, level: -32), span("A", 40, 60, level: -20),
      ]), .passThrough(reason: .ambiguousDominantSpeaker))
  }

  func testBriefLoudInterruptionCannotDeleteTheDictation() {
    XCTAssertEqual(
      decision(spans: [
        span("user", 0, 30, level: -28), span("interrupter", 30, 31, level: -12),
      ]), .passThrough(reason: .ambiguousDominantSpeaker))
  }

  func testRequiresTheForegroundGroupToClearTheDurationMargin() {
    XCTAssertEqual(
      decision(spans: [
        span("A", 0, 4.9, level: -20), span("B", 5, 9, level: -32),
      ]), .passThrough(reason: .ambiguousDominantSpeaker))
    assertFiltered(
      [
        span("A", 0, 5, level: -20), span("B", 5, 9, level: -32),
      ], ranges: [KeptRange(startSeconds: 0, endSeconds: 5.2), KeptRange(startSeconds: 8.8, endSeconds: 9)], removed: 3.6)
  }

  func testOverlappingForegroundClustersDoNotInflateTheDurationMargin() {
    XCTAssertEqual(
      decision(spans: [
        span("A", 0, 5, level: -20), span("A-split", 1, 5, level: -21),
        span("B", 5, 11, level: -32),
      ]), .passThrough(reason: .ambiguousDominantSpeaker))
  }

  func testKeepsBothClustersOfTheUserWhileRemovingBackgroundSpeech() {
    assertFiltered(
      [
        span("A", 0, 20, level: -20), span("B", 20, 35, level: -23), span("TV", 35, 45, level: -35),
      ], ranges: [KeptRange(startSeconds: 0, endSeconds: 35.2), KeptRange(startSeconds: 44.8, endSeconds: 45)], removed: 9.6)
  }

  func testKeepsSimilarVolumeVoicesIncludingBriefInterjections() {
    for duration in [0.3, 15.0] {
      XCTAssertEqual(
        decision(spans: [
          span("A", 0, 30, level: -20), span("B", 30, 30 + duration, level: -23),
        ]), .passThrough(reason: .similarVoices))
    }
  }

  func testKeepsUnmeasuredSpeechWhileRemovingKnownBackgroundSpeech() {
    assertFiltered(
      [
        span("A", 0, 10, level: -20), span("B", 10, 15), span("TV", 15, 20, level: -35),
      ], ranges: [KeptRange(startSeconds: 0, endSeconds: 15.2), KeptRange(startSeconds: 19.8, endSeconds: 20)], removed: 4.6)
  }

  func testProtectsAForegroundPhraseMisassignedToAQuieterCluster() {
    let spans = [
      span("A", 0, 40, level: -22), span("B", 40, 50, level: -35),
      span("B", 55, 57, level: -23), span("B", 60, 70, level: -35),
    ]
    guard case .filter(_, let ranges, let removed) = decision(spans: spans, duration: 75) else {
      return XCTFail("The clearly quieter parts should still be removed")
    }
    XCTAssertEqual(ranges, [
      KeptRange(startSeconds: 0, endSeconds: 40.2),
      KeptRange(startSeconds: 49.8, endSeconds: 60.2),
      KeptRange(startSeconds: 69.8, endSeconds: 75),
    ])
    XCTAssertEqual(removed, 19.2, accuracy: 0.001)
  }

  func testPreservesUnassignedAudioBeforeBetweenAndAfterRecognizedSpeech() {
    guard case .filter(_, let ranges, _) = decision(
      spans: [span("A", 10, 30, level: -20), span("B", 40, 45, level: -35)],
      duration: 60)
    else {
      return XCTFail("The measured background should be removed")
    }
    XCTAssertEqual(ranges, [
      KeptRange(startSeconds: 0, endSeconds: 40.2),
      KeptRange(startSeconds: 44.8, endSeconds: 60),
    ])
  }

  func testAnUnmeasuredFragmentInAQuietClusterCannotAuthorizeADrop() {
    guard case .filter(_, let ranges, _) = decision(
      spans: [
        span("A", 0, 20, level: -20), span("B", 20, 25, level: -35),
        span("B", 25, 25.05), span("C", 30, 35, level: -35),
      ], duration: 40)
    else {
      return XCTFail("The independently measured background should still be removed")
    }
    XCTAssertEqual(ranges, [
      KeptRange(startSeconds: 0, endSeconds: 30.2),
      KeptRange(startSeconds: 34.8, endSeconds: 40),
    ])
  }

  func testDoesNotMergeUnassignedGapsIntoRemovableBackground() {
    guard case .filter(_, let ranges, _) = decision(
      spans: [
        span("A", 0, 20, level: -20), span("B", 20, 23, level: -35),
        span("B", 23.02, 26, level: -35),
      ], duration: 30)
    else {
      return XCTFail("The measured background should be removed")
    }
    XCTAssertTrue(ranges.contains { $0.startSeconds <= 23 && $0.endSeconds >= 23.02 })
    XCTAssertTrue(ranges.contains { $0.startSeconds <= 26 && $0.endSeconds == 30 })
  }

  func testLocalAudioProtectsAWordAndItsSoftEndingInsideALongQuietSegment() {
    var samples = [Float](repeating: 0.001, count: 2500)
    for index in 1240..<1270 { samples[index] = 0.06 }
    for index in 1270..<1285 { samples[index] = 0.01 }
    let proposed = SpeakerFilterDecision.filter(
      speakerId: "A", ranges: [
        KeptRange(startSeconds: 0, endSeconds: 10),
        KeptRange(startSeconds: 20, endSeconds: 25),
      ], removedSeconds: 10)
    guard case .filter(_, let ranges, let removed) = SpeakerFilter.protectingLoudAudio(
      proposed, samples: samples, sampleRate: 100, foregroundLevel: -20)
    else {
      return XCTFail("The distant speech around the foreground word should still be removed")
    }
    XCTAssertEqual(ranges.count, 3)
    XCTAssertEqual(ranges[0], KeptRange(startSeconds: 0, endSeconds: 10))
    XCTAssertEqual(ranges[1].startSeconds, 12.2, accuracy: 0.001)
    XCTAssertEqual(ranges[1].endSeconds, 12.9, accuracy: 0.001)
    XCTAssertEqual(ranges[2], KeptRange(startSeconds: 20, endSeconds: 25))
    XCTAssertEqual(removed, 9.3, accuracy: 0.001)
  }

  func testLocalAudioProtectionNeverRemovesAdditionalQuietOrUnassignedSamples() {
    let proposed = SpeakerFilterDecision.filter(
      speakerId: "A", ranges: [
        KeptRange(startSeconds: 0, endSeconds: 10),
        KeptRange(startSeconds: 20, endSeconds: 25),
      ], removedSeconds: 10)
    XCTAssertEqual(
      SpeakerFilter.protectingLoudAudio(
        proposed, samples: [Float](repeating: 0.001, count: 2500),
        sampleRate: 100, foregroundLevel: -20), proposed)
  }

  func testLocalAudioProtectionDoesNotClaimFilteringWhenNothingCanSafelyBeRemoved() {
    XCTAssertEqual(
      SpeakerFilter.protectingLoudAudio(
        .filter(
          speakerId: "A", ranges: [KeptRange(startSeconds: 0, endSeconds: 1)],
          removedSeconds: 1),
        samples: [Float](repeating: 0.1, count: 200), sampleRate: 100, foregroundLevel: -20),
      .passThrough(reason: .similarVoices))
  }

  func testDurationAloneDoesNotAuthorizeRemovingWords() {
    XCTAssertEqual(
      decision(spans: [span("A", 0, 30), span("B", 30, 40)]),
      .passThrough(reason: .ambiguousDominantSpeaker))
  }

  func testBriefLoudNoiseDoesNotBecomeTheForegroundReference() {
    XCTAssertEqual(
      decision(spans: [
        span("A", 0, 30, level: -20), span("noise", 30, 30.2, level: -2),
      ]), .passThrough(reason: .similarVoices))
  }

  func testDoesNotClaimToRemoveSimultaneousSpeech() {
    XCTAssertEqual(
      decision(spans: [
        span("A", 0, 30, level: -20), span("B", 10, 20, level: -35),
      ]), .passThrough(reason: .similarVoices))
  }

  func testOverlappingWindowsDoNotDoubleCountRemovedAudio() {
    assertFiltered(
      [
        span("A", 0, 20, level: -20), span("B", 20, 30, level: -35), span("B", 25, 35, level: -35),
      ], ranges: [KeptRange(startSeconds: 0, endSeconds: 20.2), KeptRange(startSeconds: 34.8, endSeconds: 35)], removed: 14.6)
  }

  func testKeepsEverythingWhenTooLittleAudioWouldSurvive() {
    XCTAssertEqual(
      decision(spans: [
        span("A", 0, 0.7, level: -20), span("B", 1, 1.5, level: -35),
      ]), .passThrough(reason: .keptAudioTooShort))
  }

  func testWeightsLevelsByDurationAndRejectsIncompleteMeasurements() {
    let levels = SpeakerFilter.levelBySpeaker([
      span("A", 0, 9, level: -20), span("A", 9, 10, level: -40),
      span("B", 0, 2, level: -40), span("B", 2, 3), span("C", 0, 2, level: .nan),
    ])
    XCTAssertEqual(levels["A"]!, -20.45, accuracy: 0.05)
    XCTAssertNil(levels["B"])
    XCTAssertNil(levels["C"])
  }

  func testMergesSpansSeparatedByLessThanTheGapTolerance() {
    XCTAssertEqual(
      SpeakerFilter.merge([span("A", 0, 2), span("A", 2.02, 4), span("A", 5, 6)]),
      [
        KeptRange(startSeconds: 0, endSeconds: 4), KeptRange(startSeconds: 5, endSeconds: 6),
      ])
  }

  func testMeasuresOnlySoloSpeechAcrossOverlappingWindows() {
    let spans = [
      span("A", 0, 10), span("A", 5, 15), span("B", 2, 4), span("C", 8, 12),
    ]
    XCTAssertEqual(
      SpeakerFilter.soloRanges(speakerId: "A", spans: spans),
      [
        KeptRange(startSeconds: 0, endSeconds: 2),
        KeptRange(startSeconds: 4, endSeconds: 8),
        KeptRange(startSeconds: 12, endSeconds: 15),
      ])
    XCTAssertEqual(SpeakerFilter.soloRanges(speakerId: "B", spans: spans), [])
  }

  func testOrderingDoesNotChangeTheDecision() {
    let spans = [
      span("A", 0, 10, level: -20), span("B", 10, 20, level: -20), span("C", 20, 25, level: -35),
    ]
    XCTAssertEqual(
      decision(spans: spans), decision(spans: spans.reversed()))
  }
}
