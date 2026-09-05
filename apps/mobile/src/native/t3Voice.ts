import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

import type {
  VoiceCleanupResult,
  VoiceModelBackend,
  VoiceModelEnvironment,
  VoiceTranscriptionResult,
} from "@t3tools/client-runtime/voice-input";

import manifest from "./voiceModelManifest.json";

type MemorySnapshot = {
  readonly availableBytes: number;
  readonly physicalBytes: number;
  /** False on the Simulator, where the process has no memory limit at all. */
  readonly isProcessLimited: boolean;
  /** Bytes this process is charged for right now. */
  readonly footprintBytes: number;
};

export type ModelFileSpec = {
  readonly path: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
};

export type ModelDownloadProgress = {
  readonly modelId: string;
  readonly completedBytes: number;
  readonly totalBytes: number;
};

type T3VoiceNativeModule = {
  readonly nativeRevision: number;
  getMemorySnapshot(): MemorySnapshot;
  getInstalledModelIds(): string[];
  prepare(operationId: string, modelId: string, speakerFiltering: boolean): Promise<boolean>;
  transcribe(
    operationId: string,
    modelId: string,
    audioPath: string,
    locale: string | null,
    speakerFiltering: boolean,
  ): Promise<VoiceTranscriptionResult>;
  prepareCleanup(operationId: string, modelId: string): Promise<boolean>;
  cleanup(
    operationId: string,
    text: string,
    systemPrompt: string,
    timeoutMs: number,
  ): Promise<VoiceCleanupResult>;
  evictModels(): Promise<void>;
  cancel(operationId: string): Promise<void>;
  downloadModel(request: {
    operationId: string;
    modelId: string;
    files: readonly ModelFileSpec[];
    allowsCellular: boolean;
  }): Promise<boolean>;
  downloadManagedModel(operationId: string, modelId: string): Promise<boolean>;
  deleteModel(modelId: string): Promise<void>;
  getStorageUsage(): { totalBytes: number };
  getModelSizeOnDisk(modelId: string): number;
  addListener(
    event: string,
    listener: (payload: ModelDownloadProgress) => void,
  ): { remove(): void };
};

const modelFiles = manifest as Record<string, readonly ModelFileSpec[]>;

/**
 * On-device dictation ships for iOS and iPadOS. The Android module exists only
 * so Android builds link, so everything here treats a missing or stub module as
 * "not supported" rather than an error.
 */
const nativeModule =
  Platform.OS === "ios" ? requireOptionalNativeModule<T3VoiceNativeModule>("T3Voice") : null;

export function isLocalVoiceSupported(): boolean {
  return nativeModule !== null;
}

/**
 * Reads the memory budget fresh.
 *
 * Never cache this. `os_proc_available_memory()` is an instantaneous snapshot,
 * so a value read when the model picker rendered says nothing about what is
 * free when a model actually loads. Both moments check separately.
 */
export function getMemorySnapshot(): MemorySnapshot | null {
  return nativeModule?.getMemorySnapshot() ?? null;
}

export function getInstalledModelIds(): readonly string[] {
  return nativeModule?.getInstalledModelIds() ?? [];
}

/** Backends the installed native binary implements, which grows per phase. */
export function getSupportedBackends(): readonly VoiceModelBackend[] {
  if (!nativeModule) return [];
  // Apple's recognizer comes from a separate binding, not this module, so it is
  // not listed here. MLX Audio joins when it lands.
  return ["whisperKit", "fluidAudio", "llamaCpp"];
}

function getIosMajorVersion(): number {
  const version = Number.parseInt(String(Platform.Version), 10);
  return Number.isNaN(version) ? 0 : version;
}

/**
 * The facts model gating needs, sampled now. Callers resolve availability
 * against this and then discard it.
 */
export function readVoiceModelEnvironment(): VoiceModelEnvironment | null {
  const snapshot = getMemorySnapshot();
  if (!snapshot) return null;

  return {
    iosMajorVersion: getIosMajorVersion(),
    availableMemoryBytes: snapshot.availableBytes,
    supportedBackends: getSupportedBackends(),
  };
}

export function prepareModel(
  operationId: string,
  modelId: string,
  speakerFiltering: boolean,
): Promise<boolean> {
  if (!nativeModule) throw new Error("Local voice models are unavailable on this platform.");
  return nativeModule.prepare(operationId, modelId, speakerFiltering);
}

export function transcribeWithModel(input: {
  readonly operationId: string;
  readonly modelId: string;
  readonly audioPath: string;
  readonly locale: string | null;
  readonly speakerFiltering: boolean;
}): Promise<VoiceTranscriptionResult> {
  if (!nativeModule) throw new Error("Local voice models are unavailable on this platform.");
  return nativeModule.transcribe(
    input.operationId,
    input.modelId,
    input.audioPath,
    input.locale,
    input.speakerFiltering,
  );
}

export function prepareCleanupModel(operationId: string, modelId: string): Promise<boolean> {
  if (!nativeModule) throw new Error("Local voice models are unavailable on this platform.");
  return nativeModule.prepareCleanup(operationId, modelId);
}

export function cleanupWithModel(
  operationId: string,
  text: string,
  systemPrompt: string,
  timeoutMs: number,
): Promise<VoiceCleanupResult> {
  if (!nativeModule) throw new Error("Local voice models are unavailable on this platform.");
  return nativeModule.cleanup(operationId, text, systemPrompt, timeoutMs);
}

/**
 * Drops every resident model.
 *
 * Called on a memory warning. The next dictation reloads what it needs, which
 * costs one slower turn and is strictly better than being jetsam-killed.
 */
export function evictResidentModels(): Promise<void> {
  return nativeModule?.evictModels() ?? Promise.resolve();
}

export function cancelOperation(operationId: string): Promise<void> {
  return nativeModule?.cancel(operationId) ?? Promise.resolve();
}

/**
 * The store id of the diarizer speaker filtering needs.
 *
 * Not a selectable model: it is downloaded when filtering is switched on and
 * deleted with it.
 */
export const DIARIZER_MODEL_ID = "fluid-diarizer";

/**
 * What the diarizer costs to download.
 *
 * Not in the manifest because FluidAudio fetches it, so this is measured from
 * the two files it actually pulls rather than from the repository, which holds
 * several variants it never touches.
 */
export const DIARIZER_DOWNLOAD_BYTES = 14 * 1024 * 1024;

/** The files that make up a model, or null when it has no download manifest. */
export function getModelFiles(modelId: string): readonly ModelFileSpec[] | null {
  return modelFiles[modelId] ?? null;
}

/**
 * Whether a model downloads itself rather than through our manifest.
 *
 * FluidAudio knows which files each of its versions needs; duplicating that
 * list in a manifest would only give us something that drifts. The trade is
 * that these downloads report no progress and are not checksummed by us.
 */
export function isManagedDownload(modelId: string): boolean {
  return modelFiles[modelId] === undefined;
}

export function getModelDownloadBytes(modelId: string): number {
  return getModelFiles(modelId)?.reduce((total, file) => total + file.bytes, 0) ?? 0;
}

export function downloadModel(
  operationId: string,
  modelId: string,
  options: { readonly allowsCellular: boolean },
): Promise<boolean> {
  if (!nativeModule) throw new Error("Local voice models are unavailable on this platform.");

  const files = getModelFiles(modelId);
  if (!files) return nativeModule.downloadManagedModel(operationId, modelId);

  return nativeModule.downloadModel({
    operationId,
    modelId,
    files,
    allowsCellular: options.allowsCellular,
  });
}

export function deleteModel(modelId: string): Promise<void> {
  return nativeModule?.deleteModel(modelId) ?? Promise.resolve();
}

export function getStorageUsageBytes(): number {
  return nativeModule?.getStorageUsage().totalBytes ?? 0;
}

export function getModelSizeOnDisk(modelId: string): number {
  return nativeModule?.getModelSizeOnDisk(modelId) ?? 0;
}

/** Subscribes to download progress. Returns an unsubscribe function. */
export function onModelDownloadProgress(
  listener: (progress: ModelDownloadProgress) => void,
): () => void {
  const subscription = nativeModule?.addListener("onModelDownloadProgress", listener);
  return () => subscription?.remove();
}
