import Foundation
import os

/// Memory facts used to decide which models a device can actually run.
///
/// `availableBytes` is what iOS will still hand this process before it starts
/// killing it, and it moves constantly. Read it at the moment a decision is
/// made, never cache it: a value read when the picker rendered says nothing
/// about what is free when a model loads.
enum DeviceMemory {
  static func hasSpeakerFilteringCapacity() -> Bool {
    ModelLoadBudget.fitsSpeakerFiltering(availableBytes: availableMemory().bytes)
  }

  static func requireSpeakerFilteringCapacity() throws {
    guard hasSpeakerFilteringCapacity() else {
      throw VoiceEngineError.modelUnavailable("Not enough free memory to filter speakers.")
    }
  }

  /// Check immediately before allocation, after the engine's resident fast path.
  /// Use logical weight sizes: APFS compression must not shrink the memory estimate.
  static func requireLoadCapacity(modelFolder: URL, multiplier: Double = 1) throws {
    let keys: Set<URLResourceKey> = [.fileSizeKey, .isRegularFileKey]
    guard
      let files = FileManager.default.enumerator(
        at: modelFolder, includingPropertiesForKeys: Array(keys)
      )
    else {
      throw VoiceEngineError.modelUnavailable("The model's size could not be read.")
    }
    var bytes: Int64 = 0
    for case let url as URL in files {
      let values = try url.resourceValues(forKeys: keys)
      if values.isRegularFile == true { bytes += Int64(values.fileSize ?? 0) }
    }
    guard
      ModelLoadBudget.fits(
        modelBytes: bytes, availableBytes: availableMemory().bytes,
        multiplier: multiplier
      )
    else {
      throw VoiceEngineError.modelUnavailable("Not enough free memory to load this voice model.")
    }
  }

  static func snapshot() -> [String: Any] {
    let physical = ProcessInfo.processInfo.physicalMemory

    let available = availableMemory()

    return [
      "availableBytes": Double(available.bytes),
      "physicalBytes": Double(physical),
      // False when the value above is the machine's memory rather than a real
      // per-process budget, so callers can say the number is not a device one.
      "isProcessLimited": available.isProcessLimited,
      "footprintBytes": Double(footprint()),
    ]
  }

  private static func availableMemory() -> (bytes: UInt64, isProcessLimited: Bool) {
    let available = UInt64(os_proc_available_memory())
    // Zero also means a real app has exceeded its limit. Only the Simulator
    // may substitute host RAM for a process without an iOS memory budget.
    #if targetEnvironment(simulator)
      if available == 0 {
        return (ProcessInfo.processInfo.physicalMemory, false)
      }
    #endif
    return (available, true)
  }

  /// Bytes this process is currently charged for.
  ///
  /// `phys_footprint` is the figure iOS itself uses to decide whether to kill
  /// the app, so it is the one that matters. Resident size is not: it counts
  /// clean file-backed pages the system can reclaim for free.
  ///
  /// Sampled around model loads to turn the catalog's per-model memory numbers
  /// into measurements instead of estimates.
  static func footprint() -> UInt64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(
      MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)

    let result = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), rebound, &count)
      }
    }

    return result == KERN_SUCCESS ? UInt64(info.phys_footprint) : 0
  }
}
