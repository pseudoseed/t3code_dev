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

/// What the app's recorder writes: AAC at 44.1 kHz in stereo.
func writePhoneRecording(_ samples: [Float], to url: URL) throws {
  let rate = 44_100.0
  let file = try AVAudioFile(
    forWriting: url,
    settings: [
      AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: rate, AVNumberOfChannelsKey: 2,
      AVEncoderBitRateKey: 128_000,
    ])
  let count = Int(Double(samples.count) * rate / DictationEngine.sampleRate)
  let buffer = try XCTUnwrap(
    AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(count)))
  buffer.frameLength = AVAudioFrameCount(count)
  for frame in 0..<count {
    let position = Double(frame) * DictationEngine.sampleRate / rate
    let index = min(Int(position), samples.count - 1)
    let next = min(index + 1, samples.count - 1)
    let value = samples[index] + (samples[next] - samples[index]) * Float(position - Double(index))
    buffer.floatChannelData![0][frame] = value
    buffer.floatChannelData![1][frame] = value
  }
  try file.write(from: buffer)
}
