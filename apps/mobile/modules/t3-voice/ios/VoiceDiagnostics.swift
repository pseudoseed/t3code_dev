import Foundation
import os

/// Measurements the module reports about itself.
///
/// These exist so the catalog's per-model memory figures and the speaker
/// filter's decisions are observable on a real device instead of inferred.
/// They go to the unified log, and in a debug build also to standard output,
/// because `devicectl`'s console carries stdout and not the unified log.
enum VoiceDiagnostics {
  static func report(_ category: String, _ message: String) {
    Logger(subsystem: "codes.t3.voice", category: category)
      .info("\(message, privacy: .public)")

    #if DEBUG
      print("[codes.t3.voice:\(category)] \(message)")
    #endif
  }
}
