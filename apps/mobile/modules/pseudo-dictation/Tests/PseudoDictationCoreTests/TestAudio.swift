import AVFoundation
import XCTest

@testable import PseudoDictationCore

func writeWav(_ samples: [Float], to url: URL) throws {
  let format = try XCTUnwrap(
    AVAudioFormat(
      commonFormat: .pcmFormatFloat32, sampleRate: DictationEngine.sampleRate, channels: 1,
      interleaved: false))
  let buffer = try XCTUnwrap(
    AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)))
  buffer.frameLength = AVAudioFrameCount(samples.count)
  samples.withUnsafeBufferPointer { source in
    buffer.floatChannelData![0].update(from: source.baseAddress!, count: samples.count)
  }
  let file = try AVAudioFile(
    forWriting: url,
    settings: [
      AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: DictationEngine.sampleRate,
      AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
    ])
  try file.write(from: buffer)
}
