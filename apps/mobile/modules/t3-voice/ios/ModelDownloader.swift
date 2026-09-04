import CryptoKit
import ExpoModulesCore
import Foundation

struct ModelFileSpec: Record {
  @Field var path: String = ""
  @Field var url: String = ""
  @Field var bytes: Double = 0
  /// Hex sha256. Empty means the source did not publish one for this file.
  @Field var sha256: String = ""
}

/// One download request, as a record because the Expo bridge caps how many
/// separate arguments a function signature can take.
struct ModelDownloadRequest: Record {
  @Field var operationId: String = ""
  @Field var modelId: String = ""
  @Field var files: [ModelFileSpec] = []
  @Field var allowsCellular: Bool = false
}

struct ModelDownloadProgress {
  let modelId: String
  let completedBytes: Int64
  let totalBytes: Int64
}

/// Downloads a multi-file model into the store.
///
/// Models are directories, not archives: WhisperKit's tiny.en alone is 19 files
/// across three CoreML bundles. Progress is reported across the whole set, and
/// a file already present and verified is skipped, so an interrupted download
/// resumes at file granularity on the next attempt rather than starting over.
///
/// A plain class rather than an actor, so two models download at once. Each
/// call touches only its own model's directory, and `URLSession` is already
/// safe to share.
final class ModelDownloader: Sendable {
  private let session: URLSession

  init() {
    let configuration = URLSessionConfiguration.default
    // Weights are large and the user may leave the app mid-download. Waiting
    // for connectivity beats failing at the moment the elevator loses signal.
    configuration.waitsForConnectivity = true
    configuration.allowsExpensiveNetworkAccess = true
    session = URLSession(configuration: configuration)
  }

  func download(
    modelId: String,
    files: [ModelFileSpec],
    allowsCellular: Bool,
    onProgress: @escaping (ModelDownloadProgress) -> Void
  ) async throws {
    let destination = try ModelStore.folder(forModelId: modelId)
    // A staging directory keeps a partial download from ever looking installed.
    // It is only moved into place once every file has been verified.
    let staging = destination.appendingPathExtension("partial")

    try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)

    let totalBytes = files.reduce(Int64(0)) { $0 + Int64($1.bytes) }
    var completedBytes: Int64 = 0

    for file in files {
      try Task.checkCancellation()

      let target = staging.appendingPathComponent(file.path)
      try FileManager.default.createDirectory(
        at: target.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )

      if try isAlreadyValid(at: target, expecting: file) {
        completedBytes += Int64(file.bytes)
        onProgress(
          ModelDownloadProgress(
            modelId: modelId,
            completedBytes: completedBytes,
            totalBytes: totalBytes
          )
        )
        continue
      }

      try await downloadOne(file: file, to: target, allowsCellular: allowsCellular)
      completedBytes += Int64(file.bytes)
      onProgress(
        ModelDownloadProgress(
          modelId: modelId,
          completedBytes: completedBytes,
          totalBytes: totalBytes
        )
      )
    }

    try Task.checkCancellation()

    if FileManager.default.fileExists(atPath: destination.path) {
      try FileManager.default.removeItem(at: destination)
    }
    try FileManager.default.moveItem(at: staging, to: destination)
    try ModelStore.markInstalled(modelId: modelId)
  }

  /// Drops a partial download. The installed copy, if any, is left alone.
  func discardPartial(modelId: String) throws {
    let destination = try ModelStore.folder(forModelId: modelId)
    let staging = destination.appendingPathExtension("partial")
    guard FileManager.default.fileExists(atPath: staging.path) else { return }
    try FileManager.default.removeItem(at: staging)
  }

  private func downloadOne(file: ModelFileSpec, to target: URL, allowsCellular: Bool) async throws {
    guard let url = URL(string: file.url) else {
      throw ModelStore.StoreError.incompleteDownload("Bad URL for \(file.path).")
    }

    var request = URLRequest(url: url)
    request.allowsCellularAccess = allowsCellular

    let (temporaryURL, response) = try await session.download(for: request)

    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      try? FileManager.default.removeItem(at: temporaryURL)
      throw ModelStore.StoreError.incompleteDownload(
        "Download failed for \(file.path)."
      )
    }

    if !file.sha256.isEmpty {
      let digest = try sha256Hex(of: temporaryURL)
      guard digest == file.sha256.lowercased() else {
        try? FileManager.default.removeItem(at: temporaryURL)
        throw ModelStore.StoreError.checksumMismatch(file.path)
      }
    }

    if FileManager.default.fileExists(atPath: target.path) {
      try FileManager.default.removeItem(at: target)
    }
    try FileManager.default.moveItem(at: temporaryURL, to: target)
  }

  private func isAlreadyValid(at target: URL, expecting file: ModelFileSpec) throws -> Bool {
    guard FileManager.default.fileExists(atPath: target.path) else { return false }
    guard !file.sha256.isEmpty else {
      // Without a published checksum, size is the only cheap signal we have.
      let values = try target.resourceValues(forKeys: [.fileSizeKey])
      return Int64(values.fileSize ?? 0) == Int64(file.bytes)
    }

    return try sha256Hex(of: target) == file.sha256.lowercased()
  }

  /// Streams the file rather than reading it whole: some weights are gigabytes,
  /// and hashing one by loading it into memory is how a download kills the app.
  private func sha256Hex(of url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }

    var hasher = SHA256()
    while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty {
      hasher.update(data: chunk)
    }

    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }
}
