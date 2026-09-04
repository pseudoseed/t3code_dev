import ExpoModulesCore

public class T3VoiceModule: Module {
  private let engine = WhisperKitEngine()
  private let cleanupEngine = CleanupEngine()
  private let fluidAudio = FluidAudioEngine()
  private let operations = VoiceOperations()
  private let downloader = ModelDownloader()

  public func definition() -> ModuleDefinition {
    Name("T3Voice")

    // Bumped whenever the native surface changes shape, so a stale native
    // binary is distinguishable from a broken JS binding.
    Constants([
      "nativeRevision": 5,
    ])

    Events("onModelDownloadProgress")

    Function("getMemorySnapshot") { () -> [String: Any] in
      DeviceMemory.snapshot()
    }

    Function("getInstalledModelIds") { () -> [String] in
      var ids = ModelStore.installedModelIds()
      // The bundled model is not in the store; it ships inside the app.
      if BundledModels.folder(forModelId: BundledModels.bundledSpeechModelId) != nil {
        ids.append(BundledModels.bundledSpeechModelId)
      }
      return Array(Set(ids)).sorted()
    }

    Function("getStorageUsage") { () -> [String: Any] in
      ["totalBytes": Double(ModelStore.totalSizeOnDisk())]
    }

    Function("getModelSizeOnDisk") { (modelId: String) -> Double in
      Double(ModelStore.sizeOnDisk(modelId: modelId))
    }

    AsyncFunction("deleteModel") { (modelId: String) in
      // Evict first: deleting the files under a loaded model leaves CoreML
      // holding descriptors to something that no longer exists.
      if await self.engine.isLoaded(modelId: modelId) {
        await self.engine.evict()
      }
      if await self.cleanupEngine.isLoaded(modelId: modelId) {
        await self.cleanupEngine.evict()
      }
      if await self.fluidAudio.isLoaded(modelId: modelId) {
        await self.fluidAudio.evict()
      }
      try ModelStore.delete(modelId: modelId)
      try self.downloader.discardPartial(modelId: modelId)
    }

    AsyncFunction("downloadModel") { (request: ModelDownloadRequest, promise: Promise) in
      self.run(operationId: request.operationId, promise: promise) {
        try await self.downloader.download(
          modelId: request.modelId,
          files: request.files,
          allowsCellular: request.allowsCellular
        ) { [weak self] progress in
          self?.sendEvent(
            "onModelDownloadProgress",
            [
              "modelId": progress.modelId,
              "completedBytes": Double(progress.completedBytes),
              "totalBytes": Double(progress.totalBytes),
            ]
          )
        }
        return true
      }
    }

    AsyncFunction("prepare") { (operationId: String, modelId: String, speakerFiltering: Bool, promise: Promise) in
      self.run(operationId: operationId, promise: promise) {
        guard let folder = try Self.resolveModelFolder(modelId) else {
          throw VoiceEngineError.modelUnavailable("Model \(modelId) is not installed.")
        }

        let before = DeviceMemory.footprint()
        defer { Self.reportLoadCost(modelId: modelId, before: before) }

        guard FluidAudioEngine.asrVersion(forModelId: modelId) != nil else {
          _ = try await self.engine.prepare(modelId: modelId, modelFolder: folder)
          return true
        }

        try await self.fluidAudio.prepare(modelId: modelId, modelFolder: folder)
        // The diarizer is a second model. Loading it only when filtering is on
        // keeps its memory off every dictation that does not need it.
        if speakerFiltering,
          let diarizerFolder = try Self.resolveModelFolder(FluidAudioEngine.diarizerModelId) {
          try await self.fluidAudio.prepareDiarizer(modelFolder: diarizerFolder)
        }
        return true
      }
    }

    AsyncFunction("transcribe") { (operationId: String, modelId: String, audioPath: String, locale: String?, speakerFiltering: Bool, promise: Promise) in
      self.run(operationId: operationId, promise: promise) {
        let before = DeviceMemory.footprint()
        defer { Self.reportRunCost(stage: "transcribe", modelId: modelId, before: before) }

        guard FluidAudioEngine.asrVersion(forModelId: modelId) != nil else {
          let text = try await self.engine.transcribe(audioPath: audioPath, locale: locale)
          return Self.encode(VoiceTranscriptionOutput(text: text, speakerFiltering: .notRequested))
        }

        let output = try await self.fluidAudio.transcribe(
          audioPath: audioPath,
          locale: locale,
          speakerFiltering: speakerFiltering
        )
        return Self.encode(output)
      }
    }

    AsyncFunction("downloadManagedModel") { (operationId: String, modelId: String, promise: Promise) in
      self.run(operationId: operationId, promise: promise) {
        // FluidAudio fetches its own files: it knows which ones a version needs
        // and we would only be duplicating that list in a manifest that drifts.
        let folder = try ModelStore.folder(forModelId: modelId)
        try await FluidAudioEngine.download(modelId: modelId, to: folder) { [weak self] fraction in
          // Reported as a fraction of one, because FluidAudio knows the ratio
          // but never tells us the byte total.
          self?.sendEvent(
            "onModelDownloadProgress",
            [
              "modelId": modelId,
              "completedBytes": fraction,
              "totalBytes": 1.0,
            ]
          )
        }
        try ModelStore.markInstalled(modelId: modelId)
        return true
      }
    }

    AsyncFunction("prepareCleanup") { (operationId: String, modelId: String, promise: Promise) in
      self.run(operationId: operationId, promise: promise) {
        guard let folder = try Self.resolveModelFolder(modelId) else {
          throw VoiceEngineError.modelUnavailable("Cleanup model \(modelId) is not installed.")
        }

        let before = DeviceMemory.footprint()
        defer { Self.reportLoadCost(modelId: modelId, before: before) }

        try await self.cleanupEngine.prepare(modelId: modelId, modelFolder: folder)
        return true
      }
    }

    AsyncFunction("cleanup") { (operationId: String, text: String, systemPrompt: String, timeoutMs: Double, promise: Promise) in
      self.run(operationId: operationId, promise: promise) {
        let before = DeviceMemory.footprint()
        defer { Self.reportRunCost(stage: "cleanup", modelId: "cleanup", before: before) }

        return try await self.cleanupEngine.clean(
          transcript: text,
          systemPrompt: systemPrompt,
          timeout: timeoutMs / 1_000
        )
      }
    }

    AsyncFunction("evictModels") {
      await self.engine.evict()
      await self.cleanupEngine.evict()
      await self.fluidAudio.evict()
    }

    AsyncFunction("cancel") { (operationId: String) in
      await self.operations.cancel(operationId)
    }

    OnDestroy {
      let operations = self.operations
      Task { await operations.cancelAll() }
    }
  }

  /// Logs what loading a model actually cost.
  ///
  /// The catalog gates on a per-model memory figure, and a figure nobody has
  /// measured is a guess that decides whether a model is offered on a small
  /// phone. This is how that number gets replaced with a real one, on whatever
  /// device the app is running.
  private static func reportLoadCost(modelId: String, before: UInt64) {
    let after = DeviceMemory.footprint()
    let deltaMB = Double(Int64(after) - Int64(before)) / (1024 * 1024)
    VoiceDiagnostics.report(
      "memory",
      String(
        format: "model=%@ loadCostMB=%.1f footprintMB=%.1f",
        modelId,
        deltaMB,
        Double(after) / (1024 * 1024)
      )
    )
  }

  /// Logs what running a model cost on top of having it loaded.
  ///
  /// Loading is not the peak. Inference allocates activation buffers, and for
  /// cleanup a growing key-value cache, so the number that decides whether a
  /// device can run a model is this one, not the load.
  private static func reportRunCost(stage: String, modelId: String, before: UInt64) {
    let after = DeviceMemory.footprint()
    let deltaMB = Double(Int64(after) - Int64(before)) / (1024 * 1024)
    VoiceDiagnostics.report(
      "memory",
      String(
        format: "stage=%@ model=%@ runCostMB=%.1f footprintMB=%.1f",
        stage,
        modelId,
        deltaMB,
        Double(after) / (1024 * 1024)
      )
    )
  }

  private static func encode(_ output: VoiceTranscriptionOutput) -> [String: Any] {
    [
      "text": output.text,
      "speakerFiltering": [
        "requested": output.speakerFiltering.requested,
        "applied": output.speakerFiltering.applied,
        "fallbackReason": output.speakerFiltering.fallbackReason as Any,
      ],
    ]
  }

  /// Finds a model wherever it lives: bundled inside the app, or downloaded.
  private static func resolveModelFolder(_ modelId: String) throws -> URL? {
    if let bundled = BundledModels.folder(forModelId: modelId) {
      return bundled
    }

    guard ModelStore.isInstalled(modelId: modelId) else { return nil }
    return try ModelStore.folder(forModelId: modelId)
  }

  /// Runs one cancellable operation and settles its promise exactly once.
  ///
  /// Cancellation resolves as an explicit `cancelled` error rather than leaving
  /// the promise hanging, because the JS controller keeps its recording session
  /// alive until this settles.
  private func run<T>(
    operationId: String,
    promise: Promise,
    work: @escaping () async throws -> T
  ) {
    let task = Task<Void, Never> {
      // Inference outlives a home-button press often enough that this matters:
      // without the assertion the promise never settles and the composer is
      // stuck in a phase it cannot leave.
      let assertion = await BackgroundActivity.begin("T3Voice.\(operationId)")
      defer { Task { await BackgroundActivity.end(assertion) } }

      do {
        let value = try await work()
        try Task.checkCancellation()
        promise.resolve(value)
      } catch is CancellationError {
        promise.reject("T3VoiceCancelled", "The voice operation was cancelled.")
      } catch let error as VoiceEngineError {
        switch error {
        case let .modelUnavailable(message):
          promise.reject("T3VoiceModelUnavailable", message)
        case .cancelled:
          promise.reject("T3VoiceCancelled", "The voice operation was cancelled.")
        }
      } catch {
        promise.reject("T3VoiceFailed", error.localizedDescription)
      }

      await operations.finish(operationId)
    }

    Task { await operations.register(operationId, task: task) }
  }
}
