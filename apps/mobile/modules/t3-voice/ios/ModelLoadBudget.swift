import Foundation

/// Capacity for cold model loads and temporary inference buffers.
enum ModelLoadBudget {
  // The 22 MB diarizer weights expand into lazy CoreML graphs and recording
  // buffers. A 15-minute replay used about 708 MB beyond its starting footprint;
  // reserve 1 GiB before processing, including when its models are already loaded.
  static func fitsSpeakerFiltering(availableBytes: UInt64) -> Bool {
    availableBytes >= 1 << 30
  }

  static func fits(modelBytes: Int64, availableBytes: UInt64, multiplier: Double = 1) -> Bool {
    guard modelBytes > 0 else { return false }
    return ceil(Double(modelBytes) * multiplier) <= Double(availableBytes)
  }
}
