import { expect, it, vi } from "vite-plus/test";

import { createDictationDownloads } from "./dictationDownloads";
import type {
  DictationDownloadProgress,
  DictationModelStatus,
  DictationNativeModule,
} from "./dictationNative";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const status = (installed: boolean): DictationModelStatus => ({
  installed,
  warm: false,
  downloading: false,
  sizeOnDiskBytes: installed ? 243_000_000 : 0,
});

function setup() {
  const installed = new Set<string>();
  let emit: (progress: DictationDownloadProgress) => void = () => {};
  const download = deferred<void>();
  const native = {
    modelStatus: vi.fn(async (id: string) => status(installed.has(id))),
    downloadModel: vi.fn(() => download.promise),
    cancelDownload: vi.fn(async () => {}),
    deleteModel: vi.fn(async (id: string) => {
      installed.delete(id);
    }),
    addListener: vi.fn((_event: "onDownloadProgress", listener: typeof emit) => {
      emit = listener;
      return { remove() {} };
    }),
  };
  const downloads = createDictationDownloads(native as unknown as DictationNativeModule);
  return {
    native,
    downloads,
    installed,
    download,
    emit: (progress: DictationDownloadProgress) => emit(progress),
    state: () => downloads.getSnapshot()["parakeet-110m"],
  };
}

it("follows a download from its first byte to an installed model", async () => {
  const { downloads, native, installed, download, emit, state } = setup();
  const listener = vi.fn();
  downloads.subscribe(listener);

  const finished = downloads.download("parakeet-110m");
  expect(state().progress).toEqual({ phase: "downloading", fraction: 0 });
  expect(downloads.download("parakeet-110m")).toBe(finished);
  expect(native.downloadModel).toHaveBeenCalledTimes(1);

  emit({ modelId: "parakeet-110m", phase: "downloading", fraction: 0.4 });
  emit({ modelId: "parakeet-v3", phase: "downloading", fraction: 0.9 });
  emit({ modelId: "someone-elses-model", phase: "downloading", fraction: 0.9 });
  expect(state().progress).toEqual({ phase: "downloading", fraction: 0.4 });
  expect(downloads.getSnapshot()["parakeet-v3"].progress).toBeNull();

  emit({ modelId: "parakeet-110m", phase: "preparing", fraction: 1 });
  expect(state().progress).toEqual({ phase: "preparing", fraction: 1 });

  installed.add("parakeet-110m");
  download.resolve();
  await expect(finished).resolves.toBe(true);
  expect(state()).toEqual({ status: status(true), progress: null, error: null });

  emit({ modelId: "parakeet-110m", phase: "downloading", fraction: 0.99 });
  expect(state().progress).toBeNull();
  expect(listener).toHaveBeenCalled();
});

it.each([
  {
    name: "shows no error for a download the user cancelled",
    failure: Object.assign(new Error("Cancelled"), { code: "cancelled" }),
    error: null,
  },
  {
    name: "shows why a download failed",
    failure: Object.assign(
      new Error(
        "Calling the 'downloadModel' function has failed\n→ Caused by: Not enough free space.",
      ),
      { code: "not-enough-disk" },
    ),
    error: "Not enough free space.",
  },
  {
    name: "has words for a failure that brought none",
    failure: "boom",
    error: "The download failed.",
  },
])("$name", async ({ failure, error }) => {
  const { downloads, download, state } = setup();
  const finished = downloads.download("parakeet-110m");
  download.reject(failure);
  await expect(finished).resolves.toBe(false);
  expect(state()).toEqual({ status: status(false), progress: null, error });
});

it("starts a new download after the last one ended", async () => {
  const { downloads, native, download } = setup();
  const first = downloads.download("parakeet-110m");
  download.reject(new Error("offline"));
  await first;
  void downloads.download("parakeet-110m");
  expect(native.downloadModel).toHaveBeenCalledTimes(2);
});

it("keeps the last known status when a status read fails", async () => {
  const { downloads, native, installed, state } = setup();
  installed.add("parakeet-110m");
  await downloads.refresh();
  expect(state().status).toEqual(status(true));

  native.modelStatus.mockRejectedValue(new Error("busy"));
  await downloads.refresh();
  expect(state().status).toEqual(status(true));
});

it("offers a model whose state could not be read, until it can be", async () => {
  const { downloads, native, installed, state } = setup();
  installed.add("parakeet-110m");
  native.modelStatus.mockRejectedValueOnce(new Error("busy"));
  await downloads.refresh();
  expect(state()).toEqual({
    status: status(false),
    progress: null,
    error: "This model's state could not be read.",
  });

  await downloads.refresh();
  expect(state()).toEqual({ status: status(true), progress: null, error: null });
});

it("reports a model that could not be deleted and clears the report once it is", async () => {
  const { downloads, native, installed, state } = setup();
  installed.add("parakeet-110m");
  native.deleteModel.mockRejectedValueOnce(new Error("The model is in use."));
  await downloads.remove("parakeet-110m");
  expect(state()).toMatchObject({ status: status(true), error: "The model is in use." });

  await downloads.remove("parakeet-110m");
  expect(state()).toMatchObject({ status: status(false), error: null });
});
