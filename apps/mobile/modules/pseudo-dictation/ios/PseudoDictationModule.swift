import ExpoModulesCore
import Foundation
import UIKit

/// The JavaScript face of `DictationEngine`. It decodes arguments, calls one engine method, and
/// turns `DictationError` into a coded exception. Behaviour belongs in `Core`.
public final class PseudoDictationModule: Module {
  private let engine = DictationEngine(storage: .applicationSupport)
  private var observers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    let engine = self.engine
    let reportProgress: @Sendable (String, DownloadUpdate) -> Void = { [weak self] id, update in
      self?.sendEvent(
        "onDownloadProgress",
        ["modelId": id, "phase": update.phase.rawValue, "fraction": update.fraction])
    }

    Name("PseudoDictation")

    Events("onDownloadProgress")

    OnCreate {
      // A loaded model in a suspended app is the first thing iOS reclaims the whole app for.
      self.observers = [
        UIApplication.didReceiveMemoryWarningNotification,
        UIApplication.didEnterBackgroundNotification,
      ].map { name in
        NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { _ in
          Task { await engine.releaseIfIdle() }
        }
      }
    }

    OnDestroy {
      for observer in self.observers { NotificationCenter.default.removeObserver(observer) }
      self.observers = []
    }

    Function("deviceInfo") { () -> [String: Any] in
      let environment = DictationEnvironment.current
      return [
        "physicalMemoryBytes": Double(ProcessInfo.processInfo.physicalMemory),
        "isSimulator": environment.isSimulator,
      ]
    }

    Function("sampleClipUri") { () -> String? in
      Self.sampleClip?.absoluteString
    }

    AsyncFunction("modelStatus") { (id: String, processing: String) -> [String: Any] in
      let status = await engine.status(try Self.model(id), processing: Self.processing(processing))
      return [
        "installed": status.installed,
        "warm": status.warm,
        "downloading": status.downloading,
        "sizeOnDiskBytes": Double(status.sizeOnDiskBytes),
      ]
    }

    AsyncFunction("downloadModel") { (id: String, processing: String) in
      try await Self.coded {
        try await engine.download(
          try Self.model(id), processing: Self.processing(processing),
          onProgress: { reportProgress(id, $0) })
      }
    }

    AsyncFunction("cancelDownload") { (id: String) in
      await engine.cancelDownload(try Self.model(id))
    }

    AsyncFunction("deleteModel") { (id: String) in
      try await Self.coded { try await engine.delete(try Self.model(id)) }
    }

    AsyncFunction("prepare") { (id: String, processing: String) in
      try await Self.coded {
        try await engine.prepare(try Self.model(id), processing: Self.processing(processing))
      }
    }

    AsyncFunction("release") { () in
      await engine.releaseIfIdle()
    }

    AsyncFunction("transcribe") { (requestId: String, uri: String, id: String, processing: String, onlyMyVoice: Bool, language: String?) -> [String: Any?] in
      let transcript = try await Self.coded {
        try await engine.transcribe(
          requestId: requestId, url: try Self.fileURL(uri), model: try Self.model(id),
          processing: Self.processing(processing), onlyMyVoice: onlyMyVoice, language: language)
      }
      return [
        "text": transcript.text,
        "audioSeconds": transcript.audioSeconds,
        "processingSeconds": transcript.processingSeconds,
        "filter": transcript.filter.map { filter -> [String: Any?] in
          [
            "applied": filter.applied,
            "keptSeconds": filter.keptSeconds,
            "droppedSeconds": filter.droppedSeconds,
            "skipped": filter.skipped?.rawValue,
          ]
        },
      ]
    }

    AsyncFunction("cancelTranscription") { (requestId: String) in
      await engine.cancelTranscription(requestId: requestId)
    }

    AsyncFunction("voiceProfileStatus") { () -> [String: Any?] in
      let status = await engine.voiceProfileStatus()
      return [
        "enrolled": status.enrolled,
        "clipCount": status.clipCount,
        "createdAt": status.createdAt.map { $0.timeIntervalSince1970 * 1000 },
      ]
    }

    AsyncFunction("checkEnrollmentClip") { (uri: String) -> [String: Any?] in
      let check = try await Self.coded { try await engine.checkEnrollmentClip(try Self.fileURL(uri)) }
      return [
        "speechSeconds": check.speechSeconds,
        "problem": check.problem?.rawValue,
        "message": check.problem?.message,
      ]
    }

    AsyncFunction("saveVoiceProfile") { (uris: [String]) in
      try await Self.coded { try await engine.saveVoiceProfile(try uris.map(Self.fileURL)) }
    }

    AsyncFunction("deleteVoiceProfile") { () in
      try await Self.coded { try await engine.deleteVoiceProfile() }
    }
  }

  private static var sampleClip: URL? {
    for bundle in [Bundle(for: PseudoDictationModule.self), Bundle.main] {
      let resources = bundle.url(forResource: "PseudoDictationResources", withExtension: "bundle")
      let url = resources.flatMap(Bundle.init(url:))?
        .url(forResource: "dictation-sample", withExtension: "wav")
      if let url { return url }
    }
    return nil
  }

  private static func model(_ id: String) throws -> DictationModel {
    guard let model = DictationModel(rawValue: id) else { throw exception(.unknownModel(id)) }
    return model
  }

  private static func processing(_ value: String) -> DictationProcessing {
    DictationProcessing(rawValue: value) ?? .auto
  }

  private static func fileURL(_ uri: String) throws -> URL {
    if uri.hasPrefix("/") { return URL(fileURLWithPath: uri) }
    guard let url = URL(string: uri), url.isFileURL else {
      throw exception(.audioUnreadable("Not a local file."))
    }
    return url
  }

  private static func exception(_ error: DictationError) -> Exception {
    Exception(name: "DictationError", description: error.message, code: error.code)
  }

  private static func coded<T>(_ work: () async throws -> T) async throws -> T {
    do {
      return try await work()
    } catch let error as Exception {
      throw error
    } catch {
      throw exception(DictationEngine.describe(error))
    }
  }
}
