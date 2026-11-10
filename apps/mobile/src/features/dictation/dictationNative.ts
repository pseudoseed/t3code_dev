import { requireOptionalNativeModule } from "expo";

export type DictationFilterSkip =
  | "noSpeech"
  | "noMatch"
  | "onlyYou"
  | "tooShort"
  | "overlapping"
  | "noProfile"
  | "notInstalled"
  | "failed";

export interface DictationFilterReport {
  readonly applied: boolean;
  readonly keptSeconds: number;
  readonly droppedSeconds: number;
  readonly skipped: DictationFilterSkip | null;
}

export interface DictationTranscript {
  readonly text: string;
  readonly audioSeconds: number;
  readonly processingSeconds: number;
  readonly filter: DictationFilterReport | null;
}

export interface DictationModelStatus {
  readonly installed: boolean;
  readonly warm: boolean;
  readonly downloading: boolean;
  readonly sizeOnDiskBytes: number;
}

export interface DictationDownloadProgress {
  readonly modelId: string;
  readonly phase: "downloading" | "preparing";
  readonly fraction: number;
}

export interface DictationClipCheck {
  readonly speechSeconds: number;
  readonly problem: string | null;
  readonly message: string | null;
}

export interface DictationNativeModule {
  deviceInfo(): { readonly physicalMemoryBytes: number; readonly isSimulator: boolean };
  sampleClipUri(): string | null;
  modelStatus(modelId: string, processing: string): Promise<DictationModelStatus>;
  downloadModel(modelId: string, processing: string): Promise<void>;
  cancelDownload(modelId: string): Promise<void>;
  deleteModel(modelId: string): Promise<void>;
  prepare(modelId: string, processing: string): Promise<void>;
  release(): Promise<void>;
  transcribe(
    requestId: string,
    uri: string,
    modelId: string,
    processing: string,
    onlyMyVoice: boolean,
    language: string | null,
  ): Promise<DictationTranscript>;
  cancelTranscription(requestId: string): Promise<void>;
  voiceProfileStatus(): Promise<{
    readonly enrolled: boolean;
    readonly clipCount: number;
    readonly createdAt: number | null;
  }>;
  checkEnrollmentClip(uri: string): Promise<DictationClipCheck>;
  saveVoiceProfile(uris: ReadonlyArray<string>): Promise<void>;
  deleteVoiceProfile(): Promise<void>;
  addListener(
    event: "onDownloadProgress",
    listener: (progress: DictationDownloadProgress) => void,
  ): { remove(): void };
}

/** Null on Android and in a build made before the module existed. */
export const dictationNative =
  requireOptionalNativeModule<DictationNativeModule>("PseudoDictation");
