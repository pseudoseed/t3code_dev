import Foundation

/// Where downloaded speech and cleanup models live on disk.
///
/// Application Support, not Caches. iOS purges Caches under disk pressure, and
/// silently deleting a model the user waited several minutes to download, then
/// re-downloading it on cellular, is worse than running out of space honestly.
///
/// The directory is excluded from backup. Multi-gigabyte weights in an iCloud
/// backup burn the user's quota to store bytes that are freely re-downloadable.
enum ModelStore {
  enum StoreError: Error {
    case checksumMismatch(String)
    case incompleteDownload(String)
  }

  static func modelsDirectory() throws -> URL {
    let base = try FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )

    let directory = base.appendingPathComponent("T3VoiceModels", isDirectory: true)
    if !FileManager.default.fileExists(atPath: directory.path) {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try excludeFromBackup(directory)
    }

    return directory
  }

  static func folder(forModelId modelId: String) throws -> URL {
    try modelsDirectory().appendingPathComponent(modelId, isDirectory: true)
  }

  /// A model counts as installed only when its completion marker is present.
  ///
  /// A half-written directory from an interrupted download looks exactly like a
  /// finished one to `fileExists`, and loading it fails deep inside CoreML with
  /// an error nobody can act on. The marker is written last, after every file
  /// has been verified and moved into place.
  static func isInstalled(modelId: String) -> Bool {
    guard let folder = try? folder(forModelId: modelId) else { return false }
    return FileManager.default.fileExists(atPath: completionMarker(in: folder).path)
  }

  static func installedModelIds() -> [String] {
    guard
      let directory = try? modelsDirectory(),
      let entries = try? FileManager.default.contentsOfDirectory(
        at: directory,
        includingPropertiesForKeys: nil
      )
    else {
      return []
    }

    return entries
      .map { $0.lastPathComponent }
      .filter { isInstalled(modelId: $0) }
      .sorted()
  }

  static func markInstalled(modelId: String) throws {
    let folder = try folder(forModelId: modelId)
    try Data().write(to: completionMarker(in: folder), options: .atomic)
  }

  static func delete(modelId: String) throws {
    let folder = try folder(forModelId: modelId)
    guard FileManager.default.fileExists(atPath: folder.path) else { return }
    try FileManager.default.removeItem(at: folder)
  }

  /// Bytes on disk for one model, or zero when it is not installed.
  static func sizeOnDisk(modelId: String) -> Int64 {
    guard let folder = try? folder(forModelId: modelId) else { return 0 }
    return directorySize(folder)
  }

  static func totalSizeOnDisk() -> Int64 {
    guard let directory = try? modelsDirectory() else { return 0 }
    return directorySize(directory)
  }

  static func directorySize(_ url: URL) -> Int64 {
    guard
      let enumerator = FileManager.default.enumerator(
        at: url,
        includingPropertiesForKeys: [.totalFileAllocatedSizeKey, .fileAllocatedSizeKey]
      )
    else {
      return 0
    }

    var total: Int64 = 0
    for case let fileURL as URL in enumerator {
      let values = try? fileURL.resourceValues(
        forKeys: [.totalFileAllocatedSizeKey, .fileAllocatedSizeKey]
      )
      let size = values?.totalFileAllocatedSize ?? values?.fileAllocatedSize ?? 0
      total += Int64(size)
    }

    return total
  }

  /// The weights file inside a cleanup model's folder.
  ///
  /// Cleanup models are one GGUF, but they are stored as a folder like every
  /// other model so the completion marker and the download staging path work
  /// the same way for all of them.
  static func ggufFile(in folder: URL) -> URL? {
    let entries =
      (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil))
      ?? []
    return entries.first { $0.pathExtension.lowercased() == "gguf" }
  }

  private static func completionMarker(in folder: URL) -> URL {
    folder.appendingPathComponent(".t3-voice-complete", isDirectory: false)
  }

  private static func excludeFromBackup(_ url: URL) throws {
    var mutable = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try mutable.setResourceValues(values)
  }
}
