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
@MainActor
final class BackgroundActivity {
  private var identifier: UIBackgroundTaskIdentifier = .invalid

  static func begin(
    _ name: String,
    onExpiration: @escaping @Sendable () -> Void
  ) -> BackgroundActivity {
    let activity = BackgroundActivity()
    activity.identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak activity] in
      // iOS requires ending the assertion when time expires. Keeping it open
      // until inference finishes can terminate the process and lose the draft.
      onExpiration()
      Task { @MainActor in activity?.end() }
    }
    return activity
  }

  func end() {
    guard identifier != .invalid else { return }
    UIApplication.shared.endBackgroundTask(identifier)
    identifier = .invalid
  }
}
