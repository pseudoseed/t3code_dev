import CoreML
import FluidAudio
import Foundation

enum DictationModel: String, CaseIterable, Sendable {
  case fast = "parakeet-110m"
  case balanced = "parakeet-v3"
  case accurate = "parakeet-ultra"
  case voiceFilter = "voice-filter"

  var asrVersion: AsrModelVersion? {
    switch self {
    case .fast: return .tdtCtc110m
    case .balanced: return .v3
    case .accurate: return .ultra
    case .voiceFilter: return nil
    }
  }

  var repo: Repo {
    switch self {
    case .fast: return .parakeetTdtCtc110m
    case .balanced: return .parakeetV3
    case .accurate: return .parakeetUltra
    case .voiceFilter: return .diarizer
    }
  }

  /// Free memory a load needs before it starts. Lower bounds, not measured peaks: a load attempted
  /// with less than this is expected to end in the system killing the app.
  var loadMemoryBytes: UInt64 {
    switch self {
    case .fast: return 150 << 20
    case .balanced: return 350 << 20
    case .accurate: return 450 << 20
    case .voiceFilter: return 120 << 20
    }
  }

  /// Disk needed to start a download, with room for the compiled copies Core ML keeps.
  var downloadDiskBytes: UInt64 {
    switch self {
    case .fast: return 600 << 20
    case .balanced: return 1200 << 20
    case .accurate: return 1500 << 20
    case .voiceFilter: return 200 << 20
    }
  }
}

enum DictationProcessing: String, Sendable {
  case auto
  case neuralEngine
  case gpu
  case cpu

  func computeUnits(isSimulator: Bool) -> MLComputeUnits {
    if isSimulator { return .cpuOnly }
    switch self {
    case .auto, .neuralEngine: return .cpuAndNeuralEngine
    case .gpu: return .cpuAndGPU
    case .cpu: return .cpuOnly
    }
  }
}

enum DictationError: Error, Equatable {
  case unknownModel(String)
  case notInstalled(DictationModel)
  case notEnoughMemory(requiredBytes: UInt64, availableBytes: UInt64)
  case notEnoughDisk(requiredBytes: UInt64, availableBytes: UInt64)
  case noVoiceProfile
  case enrollmentRejected(EnrollmentProblem)
  case audioUnreadable(String)
  case cancelled
  case failed(String)

  var code: String {
    switch self {
    case .unknownModel: return "unknown-model"
    case .notInstalled: return "not-installed"
    case .notEnoughMemory: return "not-enough-memory"
    case .notEnoughDisk: return "not-enough-disk"
    case .noVoiceProfile: return "no-voice-profile"
    case .enrollmentRejected: return "enrollment-rejected"
    case .audioUnreadable: return "audio-unreadable"
    case .cancelled: return "cancelled"
    case .failed: return "failed"
    }
  }

  var message: String {
    switch self {
    case .unknownModel(let id): return "Unknown dictation model \(id)."
    case .notInstalled: return "This dictation model is not downloaded."
    case .notEnoughMemory: return "Not enough free memory to load this dictation model."
    case .notEnoughDisk(let required, _):
      return "Not enough free storage. This download needs about \(required >> 20) MB free."
    case .noVoiceProfile: return "No voice profile is saved."
    case .enrollmentRejected(let problem): return problem.message
    case .audioUnreadable(let detail): return "The recording could not be read. \(detail)"
    case .cancelled: return "Cancelled."
    case .failed(let detail): return detail
    }
  }
}

enum EnrollmentProblem: String, Sendable {
  case tooQuiet
  case tooShort
  case multipleVoices
  case clipsDisagree
  case tooFewClips

  var message: String {
    switch self {
    case .tooQuiet: return "No speech was heard. Move closer to the microphone and try again."
    case .tooShort: return "Not enough speech. Read the whole prompt."
    case .multipleVoices: return "More than one voice was heard. Record somewhere quieter."
    case .clipsDisagree: return "The recordings do not sound like the same voice. Record them again."
    case .tooFewClips: return "Record every sample before saving."
    }
  }
}

/// `available` of 0 means the system gave no reading, which is what the simulator and macOS return.
func hasEnoughMemory(available: UInt64, required: UInt64) -> Bool {
  available == 0 || available >= required
}

struct DictationEnvironment: Sendable {
  var appBuild: String
  var osBuild: String
  var isSimulator: Bool
  var availableMemory: @Sendable () -> UInt64
  var freeDisk: @Sendable (URL) -> UInt64?

  static var current: DictationEnvironment {
    let info = Bundle.main.infoDictionary
    #if targetEnvironment(simulator)
      let isSimulator = true
    #else
      let isSimulator = false
    #endif
    return DictationEnvironment(
      appBuild: "\(info?["CFBundleShortVersionString"] ?? "0")(\(info?["CFBundleVersion"] ?? "0"))",
      osBuild: ProcessInfo.processInfo.operatingSystemVersionString,
      isSimulator: isSimulator,
      availableMemory: {
        #if os(iOS) && !targetEnvironment(simulator)
          return UInt64(os_proc_available_memory())
        #else
          return 0
        #endif
      },
      freeDisk: { url in
        let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage.map { UInt64(max($0, 0)) }
      }
    )
  }
}
