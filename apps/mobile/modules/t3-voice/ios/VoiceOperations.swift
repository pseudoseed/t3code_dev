import Foundation

/// Tracks in-flight voice operations so JS can cancel one by id.
///
/// The shared contract is that cancellation is cooperative and a cancelled
/// operation settles only after the underlying work has actually stopped. That
/// is why `cancel` marks and cancels but never resolves anything itself: the
/// operation's own continuation settles when its task unwinds.
actor VoiceOperations {
  private var tasks: [String: Task<Void, Never>] = [:]

  func register(_ operationId: String, task: Task<Void, Never>) {
    tasks[operationId]?.cancel()
    tasks[operationId] = task
  }

  func finish(_ operationId: String) {
    tasks[operationId] = nil
  }

  func cancel(_ operationId: String) {
    tasks[operationId]?.cancel()
  }

  func cancelAll() {
    for task in tasks.values {
      task.cancel()
    }
  }
}
