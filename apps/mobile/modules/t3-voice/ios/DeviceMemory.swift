import Foundation
import os

/// Memory facts used to decide which models a device can actually run.
///
/// `availableBytes` is what iOS will still hand this process before it starts
/// killing it, and it moves constantly. Read it at the moment a decision is
/// made, never cache it: a value read when the picker rendered says nothing
/// about what is free when a model loads.
enum DeviceMemory {
  static func snapshot() -> [String: Any] {
    let physical = ProcessInfo.processInfo.physicalMemory

    // `os_proc_available_memory` returns 0 for a process with no memory limit,
    // which is every process on the Simulator. Reporting that verbatim gates
    // out every model and makes the picker look broken, so an unlimited process
    // reports the machine's memory instead. On a real device the process is
    // always limited and this branch never runs.
    let available = os_proc_available_memory()
    let availableBytes = available > 0 ? UInt64(available) : physical

    return [
      "availableBytes": Double(availableBytes),
      "physicalBytes": Double(physical),
      // False when the value above is the machine's memory rather than a real
      // per-process budget, so callers can say the number is not a device one.
      "isProcessLimited": available > 0,
      "footprintBytes": Double(footprint()),
    ]
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
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)

    let result = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), rebound, &count)
      }
    }

    return result == KERN_SUCCESS ? UInt64(info.phys_footprint) : 0
  }
}
