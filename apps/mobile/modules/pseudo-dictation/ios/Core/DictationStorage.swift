import FluidAudio
import Foundation

/// What a compiled model was last loaded under. Core ML recompiles for the Neural Engine when any of
/// these change, and that first load can take minutes, so it must not happen on a dictation tap.
struct WarmKey: Codable, Equatable {
  var appBuild: String
  var osBuild: String
  var processing: String
}

struct VoiceProfile: Codable, Equatable {
  static let currentExtractor = "fluidaudio-offline-span-256"

  var extractor: String
  var embedding: [Float]
  var clipCount: Int
  var createdAt: Date
}

struct DictationStorage: Sendable {
  let root: URL

  static var applicationSupport: DictationStorage {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return DictationStorage(root: base.appendingPathComponent("PseudoDictation", isDirectory: true))
  }

  var modelsRoot: URL { root.appendingPathComponent("Models", isDirectory: true) }
  private var stateRoot: URL { root.appendingPathComponent("State", isDirectory: true) }
  private var profileURL: URL { root.appendingPathComponent("voice-profile.json") }

  func modelDirectory(_ model: DictationModel) -> URL {
    modelsRoot.appendingPathComponent(model.repo.folderName, isDirectory: true)
  }

  private func installMarker(_ model: DictationModel) -> URL {
    stateRoot.appendingPathComponent("\(model.rawValue).installed")
  }

  private func warmMarker(_ model: DictationModel) -> URL {
    stateRoot.appendingPathComponent("\(model.rawValue).warm.json")
  }

  /// Models are large and can be downloaded again, so they stay out of device backups.
  func prepare() throws {
    let manager = FileManager.default
    try manager.createDirectory(at: modelsRoot, withIntermediateDirectories: true)
    try manager.createDirectory(at: stateRoot, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var target = root
    try target.setResourceValues(values)
  }

  func markInstalled(_ model: DictationModel) throws {
    try prepare()
    try Data().write(to: installMarker(model), options: .atomic)
  }

  /// The marker says a download finished; the file check catches a folder damaged or cleared since.
  func isInstalled(_ model: DictationModel) -> Bool {
    guard FileManager.default.fileExists(atPath: installMarker(model).path) else { return false }
    let directory = modelDirectory(model)
    if let version = model.asrVersion {
      return AsrModels.modelsExist(at: directory, version: version)
    }
    return ModelNames.OfflineDiarizer.requiredModels.allSatisfy { name in
      Self.isLoadReady(directory.appendingPathComponent(name))
    }
  }

  private static func isLoadReady(_ url: URL) -> Bool {
    let manager = FileManager.default
    var isDirectory: ObjCBool = false
    guard manager.fileExists(atPath: url.path, isDirectory: &isDirectory) else { return false }
    guard isDirectory.boolValue else { return true }
    guard manager.fileExists(atPath: url.appendingPathComponent("coremldata.bin").path) else {
      return false
    }
    let contents = manager.enumerator(at: url, includingPropertiesForKeys: nil)
    while let item = contents?.nextObject() as? URL {
      if item.pathExtension == "partial" { return false }
    }
    return true
  }

  func delete(_ model: DictationModel) throws {
    let manager = FileManager.default
    for url in [installMarker(model), warmMarker(model), modelDirectory(model)]
    where manager.fileExists(atPath: url.path) {
      try manager.removeItem(at: url)
    }
  }

  func sizeOnDisk(_ model: DictationModel) -> UInt64 {
    let keys: [URLResourceKey] = [.totalFileAllocatedSizeKey, .isRegularFileKey]
    let contents = FileManager.default.enumerator(
      at: modelDirectory(model), includingPropertiesForKeys: keys)
    var total: UInt64 = 0
    while let item = contents?.nextObject() as? URL {
      let values = try? item.resourceValues(forKeys: Set(keys))
      if values?.isRegularFile == true {
        total += UInt64(values?.totalFileAllocatedSize ?? 0)
      }
    }
    return total
  }

  func isWarm(_ model: DictationModel, key: WarmKey) -> Bool {
    guard let data = try? Data(contentsOf: warmMarker(model)) else { return false }
    return (try? JSONDecoder().decode(WarmKey.self, from: data)) == key
  }

  func markWarm(_ model: DictationModel, key: WarmKey) throws {
    try prepare()
    try JSONEncoder().encode(key).write(to: warmMarker(model), options: .atomic)
  }

  /// A profile from another extractor holds vectors this build cannot compare, so it reads as absent.
  func loadVoiceProfile() -> VoiceProfile? {
    guard
      let data = try? Data(contentsOf: profileURL),
      let profile = try? JSONDecoder().decode(VoiceProfile.self, from: data),
      profile.extractor == VoiceProfile.currentExtractor,
      !profile.embedding.isEmpty
    else { return nil }
    return profile
  }

  func saveVoiceProfile(_ profile: VoiceProfile) throws {
    try prepare()
    try JSONEncoder().encode(profile).write(
      to: profileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  func deleteVoiceProfile() throws {
    if FileManager.default.fileExists(atPath: profileURL.path) {
      try FileManager.default.removeItem(at: profileURL)
    }
  }
}
