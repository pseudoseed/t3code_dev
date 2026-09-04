import Foundation
import UIKit

/// Keeps a long native operation running for a few seconds after the app leaves
/// the foreground.
///
/// Transcription and cleanup both run for seconds against a model that cost
/// seconds to load. Without an assertion iOS suspends the process mid-inference,
/// the promise never settles, and the composer is left in a phase it cannot
/// leave. The assertion does not make the work unlimited; it makes the work
/// finish or stop cleanly instead of vanishing.
enum BackgroundActivity {
  static func begin(_ name: String) async -> UIBackgroundTaskIdentifier {
    await MainActor.run {
      UIApplication.shared.beginBackgroundTask(withName: name, expirationHandler: nil)
    }
  }

  static func end(_ identifier: UIBackgroundTaskIdentifier) async {
    guard identifier != .invalid else { return }
    await MainActor.run {
      UIApplication.shared.endBackgroundTask(identifier)
    }
  }
}
