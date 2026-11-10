import {
  DICTATION_PROCESSING,
  LOCAL_DICTATION_MODEL_IDS,
  VOICE_FILTER_MODEL_ID,
  type DownloadableModelId,
} from "./dictationModels";
import type {
  DictationDownloadProgress,
  DictationModelStatus,
  DictationNativeModule,
} from "./dictationNative";

export interface ModelDownloadState {
  /** Null until the first status read settles. */
  readonly status: DictationModelStatus | null;
  readonly progress: Pick<DictationDownloadProgress, "phase" | "fraction"> | null;
  readonly error: string | null;
}

export type DictationDownloadsSnapshot = Readonly<Record<DownloadableModelId, ModelDownloadState>>;

const DOWNLOADABLE: ReadonlyArray<DownloadableModelId> = [
  ...LOCAL_DICTATION_MODEL_IDS,
  VOICE_FILTER_MODEL_ID,
];
const EMPTY: ModelDownloadState = { status: null, progress: null, error: null };
const UNREADABLE = "This model's state could not be read.";
const NOT_INSTALLED: DictationModelStatus = {
  installed: false,
  warm: false,
  downloading: false,
  sizeOnDiskBytes: 0,
};

export function nativeErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

// Expo puts a native error's own text after "Calling the 'x' function has failed" and this marker.
const NATIVE_CAUSE = "→ Caused by: ";

export function nativeErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const cause = error.message.lastIndexOf(NATIVE_CAUSE);
  const message = (
    cause < 0 ? error.message : error.message.slice(cause + NATIVE_CAUSE.length)
  ).trim();
  return message.length > 0 ? message : fallback;
}

export interface DictationDownloads {
  getSnapshot(): DictationDownloadsSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  /** Resolves true when the model is installed afterwards. Never rejects. */
  download(id: DownloadableModelId): Promise<boolean>;
  cancel(id: DownloadableModelId): void;
  remove(id: DownloadableModelId): Promise<void>;
}

/** Install state and download progress for every model, kept outside the screens that show it. */
export function createDictationDownloads(native: DictationNativeModule): DictationDownloads {
  let snapshot = Object.fromEntries(
    DOWNLOADABLE.map((id) => [id, EMPTY]),
  ) as DictationDownloadsSnapshot;
  const listeners = new Set<() => void>();
  const running = new Map<DownloadableModelId, Promise<boolean>>();

  const set = (id: DownloadableModelId, change: Partial<ModelDownloadState>) => {
    snapshot = { ...snapshot, [id]: { ...snapshot[id], ...change } };
    for (const listener of listeners) listener();
  };
  const isDownloadable = (id: string): id is DownloadableModelId =>
    DOWNLOADABLE.some((known) => known === id);

  native.addListener("onDownloadProgress", (progress) => {
    // A progress event can trail the download it belongs to.
    if (!isDownloadable(progress.modelId) || !running.has(progress.modelId)) return;
    set(progress.modelId, { progress: { phase: progress.phase, fraction: progress.fraction } });
  });

  const readStatus = async (id: DownloadableModelId) => {
    try {
      const status = await native.modelStatus(id, DICTATION_PROCESSING);
      set(id, snapshot[id].error === UNREADABLE ? { status, error: null } : { status });
    } catch {
      // The last known status stands. With none, the model is offered for download, which reads
      // the device again.
      if (snapshot[id].status === null) {
        set(id, { status: NOT_INSTALLED, error: UNREADABLE });
      }
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: () => Promise.all(DOWNLOADABLE.map(readStatus)).then(() => undefined),
    download(id) {
      const existing = running.get(id);
      if (existing) return existing;
      set(id, { progress: { phase: "downloading", fraction: 0 }, error: null });
      const work = native
        .downloadModel(id, DICTATION_PROCESSING)
        .then(
          () => null,
          (error: unknown) =>
            nativeErrorCode(error) === "cancelled"
              ? null
              : nativeErrorMessage(error, "The download failed."),
        )
        .then(async (error) => {
          running.delete(id);
          set(id, { progress: null, error });
          await readStatus(id);
          return snapshot[id].status?.installed === true;
        });
      running.set(id, work);
      return work;
    },
    cancel(id) {
      void native.cancelDownload(id).catch(() => {});
    },
    async remove(id) {
      try {
        await native.deleteModel(id);
        set(id, { error: null });
      } catch (error) {
        set(id, { error: nativeErrorMessage(error, "The model could not be deleted.") });
      }
      await readStatus(id);
    },
  };
}
