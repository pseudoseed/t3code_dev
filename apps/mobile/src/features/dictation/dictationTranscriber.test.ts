import type {
  PreparedVoiceTranscription,
  VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { describe, expect, it, vi } from "vite-plus/test";

import { PendingDictations } from "./correctionLearning";
import type {
  DictationModelStatus,
  DictationNativeModule,
  DictationTranscript,
} from "./dictationNative";
import { createDictationStore, type DictationSettings } from "./dictationStore";
import { createDictationTranscriber } from "./dictationTranscriber";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const SPOKEN = "So uh please check the cube control logs in pseudo code today";
const WRITTEN = "So please check the cube control logs in PseudoCode today";
const URI = "file:///recording.m4a";
const COLD: DictationModelStatus = {
  installed: true,
  warm: false,
  downloading: false,
  sizeOnDiskBytes: 491_000_000,
};
const WARM: DictationModelStatus = { ...COLD, warm: true };
const MISSING: DictationModelStatus = { ...COLD, installed: false, sizeOnDiskBytes: 0 };
const TRANSCRIPT: DictationTranscript = {
  text: SPOKEN,
  audioSeconds: 4.5,
  processingSeconds: 0.12,
  filter: { applied: true, keptSeconds: 3, droppedSeconds: 1.5, skipped: null },
};

function setup(
  input: {
    readonly settings?: Partial<DictationSettings>;
    readonly system?: "present" | "absent" | "refuses";
    readonly systemLocale?: string;
    readonly native?: "present" | "absent";
    readonly locale?: string;
  } = {},
) {
  const clock = { now: 1_000 };
  const store = createDictationStore({
    read: async () =>
      JSON.stringify({
        settings: input.settings ?? {},
        learning: {
          rules: [{ heard: "pseudo code", written: "PseudoCode", source: "manual", addedAt: 1 }],
        },
      }),
    write: async () => {},
  });
  const systemTranscribe = vi.fn<PreparedVoiceTranscription["transcribe"]>(async () => {
    clock.now += 250;
    return SPOKEN;
  });
  const system: VoiceTranscriber = {
    prepare: vi.fn(async () => {
      if (input.system === "refuses") throw new Error("That language is not supported.");
      return { locale: input.systemLocale ?? "en-US", transcribe: systemTranscribe };
    }),
  };
  const getSystemTranscriber = vi.fn(async () => (input.system === "absent" ? null : system));
  const native = {
    modelStatus: vi.fn(async (): Promise<DictationModelStatus> => WARM),
    prepare: vi.fn(() => new Promise<void>(() => {})),
    transcribe: vi.fn(async (): Promise<DictationTranscript> => TRANSCRIPT),
    cancelTranscription: vi.fn(async (_requestId: string) => {}),
  };
  const pending = new PendingDictations();
  const transcriber = createDictationTranscriber({
    native: input.native === "absent" ? null : (native as unknown as DictationNativeModule),
    store,
    getSystemTranscriber,
    getLocale: () => input.locale ?? "en-US",
    now: () => clock.now,
    pending,
    newRequestId: () => "request-1",
  });
  const abort = new AbortController();
  const dictate = async () => {
    const prepared = await transcriber.prepare({ signal: abort.signal });
    return prepared.transcribe(URI, { signal: abort.signal });
  };
  return {
    transcriber,
    native,
    store,
    pending,
    abort,
    dictate,
    getSystemTranscriber,
    systemTranscribe,
    lastRun: () => store.getSnapshot().lastRun,
  };
}

describe("with Apple dictation selected", () => {
  it("cleans up what the system recognizer heard and records the run", async () => {
    const { dictate, native, lastRun } = setup();
    await expect(dictate()).resolves.toBe(WRITTEN);
    expect(lastRun()).toEqual({
      at: 1_250,
      engine: "apple",
      fallback: null,
      audioSeconds: null,
      processingSeconds: 0.25,
      filter: null,
    });
    expect(native.modelStatus).not.toHaveBeenCalled();
  });

  it("says where to get a model when there is no system recognizer", async () => {
    const { dictate } = setup({ system: "absent" });
    await expect(dictate()).rejects.toMatchObject({
      code: "unavailable",
      message: "Download a dictation model in Settings > Microphone.",
    });
  });

  it.each([
    { name: "a language that is not English", input: { systemLocale: "de-DE" } },
    { name: "the setting turned off", input: { settings: { removeFillers: false } } },
  ])("keeps ums and uhs with $name", async ({ input }) => {
    const { dictate } = setup(input);
    await expect(dictate()).resolves.toBe(
      "So uh please check the cube control logs in PseudoCode today",
    );
  });
});

it("uses the system recognizer for a chosen model in a build without the module", async () => {
  const { dictate, lastRun } = setup({ settings: { modelId: "parakeet-v3" }, native: "absent" });
  await expect(dictate()).resolves.toBe(WRITTEN);
  expect(lastRun()).toMatchObject({ engine: "apple", fallback: null });
});

describe("with a downloaded model selected", () => {
  const settings = { modelId: "parakeet-v3", onlyMyVoice: true } as const;

  it("transcribes on a loaded model without waiting for anything else", async () => {
    const { dictate, native, getSystemTranscriber, lastRun } = setup({ settings });
    await expect(dictate()).resolves.toBe(WRITTEN);
    expect(native.transcribe).toHaveBeenCalledWith(
      "request-1",
      URI,
      "parakeet-v3",
      "auto",
      true,
      "en-US",
    );
    expect(native.prepare).toHaveBeenCalledWith("parakeet-v3", "auto");
    expect(getSystemTranscriber).not.toHaveBeenCalled();
    expect(lastRun()).toEqual({
      at: 1_000,
      engine: "parakeet-v3",
      fallback: null,
      audioSeconds: 4.5,
      processingSeconds: 0.12,
      filter: TRANSCRIPT.filter,
    });
  });

  it("uses a model that finished loading while the user was talking", async () => {
    const { dictate, native, systemTranscribe, lastRun } = setup({ settings });
    native.modelStatus.mockResolvedValueOnce(COLD);
    await expect(dictate()).resolves.toBe(WRITTEN);
    expect(systemTranscribe).not.toHaveBeenCalled();
    expect(lastRun()).toMatchObject({ engine: "parakeet-v3", fallback: null });
  });

  it.each([
    { name: "is still loading", atTranscribe: () => Promise.resolve(COLD), fallback: "warming-up" },
    {
      name: "cannot say whether it loaded",
      atTranscribe: () => Promise.reject(new Error("busy")),
      fallback: "warming-up",
    },
    {
      name: "failed to load",
      atTranscribe: () => Promise.resolve(COLD),
      load: () => Promise.reject(new Error("Not enough memory.")),
      fallback: "failed",
    },
  ])("hands the recording to the system recognizer when the model $name", async (row) => {
    const { dictate, native, lastRun } = setup({ settings });
    native.modelStatus.mockResolvedValueOnce(COLD).mockImplementationOnce(row.atTranscribe);
    if (row.load) native.prepare.mockImplementationOnce(row.load);
    await expect(dictate()).resolves.toBe(WRITTEN);
    expect(native.transcribe).not.toHaveBeenCalled();
    expect(lastRun()).toMatchObject({ engine: "apple", fallback: row.fallback });
  });

  it("uses the system recognizer when the model's state cannot be read", async () => {
    const { dictate, native, lastRun } = setup({ settings });
    native.modelStatus.mockRejectedValueOnce(new Error("busy"));
    await expect(dictate()).resolves.toBe(WRITTEN);
    expect(native.transcribe).not.toHaveBeenCalled();
    expect(lastRun()).toMatchObject({ engine: "apple", fallback: "failed" });
  });

  it("asks an English-only model for English on a device in another language", async () => {
    const { transcriber, native, abort } = setup({
      settings: { modelId: "parakeet-110m" },
      locale: "de-DE",
    });
    const prepared = await transcriber.prepare({ signal: abort.signal });
    expect(prepared.locale).toBe("en-US");
    await prepared.transcribe(URI, { signal: abort.signal });
    expect(native.transcribe.mock.calls[0]).toContain("en-US");
  });

  it.each(["absent", "refuses"] as const)(
    "waits for a loading model when the system recognizer %s",
    async (system) => {
      const { dictate, native, lastRun } = setup({ settings, system });
      native.modelStatus.mockResolvedValue(COLD);
      await expect(dictate()).resolves.toBe(WRITTEN);
      expect(lastRun()).toMatchObject({ engine: "parakeet-v3", fallback: null });
    },
  );

  it("uses the system recognizer while the model is not downloaded", async () => {
    const { dictate, native, lastRun } = setup({ settings });
    native.modelStatus.mockResolvedValue(MISSING);
    await expect(dictate()).resolves.toBe(WRITTEN);
    expect(native.prepare).not.toHaveBeenCalled();
    expect(native.transcribe).not.toHaveBeenCalled();
    expect(lastRun()).toMatchObject({ engine: "apple", fallback: "not-downloaded" });
  });

  it.each(["absent", "refuses"] as const)(
    "refuses to start with no model and a system recognizer that %s",
    async (system) => {
      const { dictate, native } = setup({ settings, system });
      native.modelStatus.mockResolvedValue(MISSING);
      await expect(dictate()).rejects.toMatchObject({ code: "unavailable" });
    },
  );

  it("gives a recording the model failed on to the system recognizer", async () => {
    const { dictate, native, lastRun } = setup({ settings });
    native.transcribe.mockRejectedValueOnce(new Error("The model could not be loaded."));
    await expect(dictate()).resolves.toBe(WRITTEN);
    expect(lastRun()).toMatchObject({ engine: "apple", fallback: "failed" });
  });

  it.each(["absent", "refuses"] as const)(
    "reports the model's own failure when the system recognizer %s",
    async (system) => {
      const { dictate, native, lastRun } = setup({ settings, system });
      native.transcribe.mockRejectedValueOnce(
        new Error(
          "Calling the 'transcribe' function has failed\n→ Caused by: The model could not be loaded.",
        ),
      );
      await expect(dictate()).rejects.toMatchObject({
        code: "transcription-failed",
        message: "The model could not be loaded.",
      });
      expect(lastRun()).toBeNull();
    },
  );

  it("cancels the model's work when the dictation is cancelled", async () => {
    const { transcriber, native, abort, getSystemTranscriber, pending, lastRun } = setup({
      settings,
    });
    const running = deferred<DictationTranscript>();
    native.transcribe.mockReturnValueOnce(running.promise);
    native.cancelTranscription.mockImplementationOnce(async () => {
      running.reject(new Error("Cancelled"));
    });
    const prepared = await transcriber.prepare({ signal: abort.signal });
    const result = prepared.transcribe(URI, { signal: abort.signal });
    await vi.waitFor(() => expect(native.transcribe).toHaveBeenCalled());
    abort.abort();

    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(native.cancelTranscription).toHaveBeenCalledWith("request-1");
    expect(getSystemTranscriber).not.toHaveBeenCalled();
    expect(lastRun()).toBeNull();
    expect(pending.resolve(WRITTEN, 1_000)).toEqual([]);
  });

  it("drops a transcript that arrives after the dictation was cancelled", async () => {
    const { transcriber, native, abort, lastRun } = setup({ settings });
    const running = deferred<DictationTranscript>();
    native.transcribe.mockReturnValueOnce(running.promise);
    const prepared = await transcriber.prepare({ signal: abort.signal });
    const result = prepared.transcribe(URI, { signal: abort.signal });
    await vi.waitFor(() => expect(native.transcribe).toHaveBeenCalled());
    abort.abort();
    running.resolve(TRANSCRIPT);

    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(lastRun()).toBeNull();
  });

  it("does not start for a dictation that was already cancelled", async () => {
    const { transcriber, native, abort } = setup({ settings });
    abort.abort();
    await expect(transcriber.prepare({ signal: abort.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(native.modelStatus).not.toHaveBeenCalled();
  });
});

describe("correction learning", () => {
  const sent = "So please check the kubectl logs in PseudoCode today";

  it("remembers the dictation so a later fix to it can be learned", async () => {
    const { dictate, pending } = setup();
    await dictate();
    expect(pending.resolve(sent, 2_000)).toEqual([{ heard: "cube control", written: "kubectl" }]);
  });

  it("remembers nothing when learning is off", async () => {
    const { dictate, pending } = setup({ settings: { learnCorrections: false } });
    await dictate();
    expect(pending.resolve(sent, 2_000)).toEqual([]);
  });
});
