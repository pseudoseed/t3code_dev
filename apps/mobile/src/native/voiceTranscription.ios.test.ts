import type { TranscriptionResult } from "@react-native-ai/apple/src/NativeAppleTranscription";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { VoiceTranscriptionError } from "@t3tools/client-runtime/voice-input";

const mocks = vi.hoisted(() => ({
  isAvailable: vi.fn<(locale: string) => boolean>(),
  prepare: vi.fn<(locale: string) => Promise<string>>(),
  transcribe: vi.fn<(audio: ArrayBufferLike, locale: string) => Promise<TranscriptionResult>>(),
  readAudio: vi.fn<() => Promise<ArrayBuffer>>(),
  readVoiceModelEnvironment: vi.fn<() => unknown>(() => null),
  getInstalledModelIds: vi.fn<() => readonly string[]>(() => []),
  getLocalModelVoiceTranscriber: vi.fn<(input: unknown) => unknown>(() => null),
}));

vi.mock("@react-native-ai/apple/src/NativeAppleTranscription", () => ({
  default: {
    isAvailable: mocks.isAvailable,
    prepare: mocks.prepare,
    transcribe: mocks.transcribe,
  },
}));

vi.mock("expo-file-system", () => ({
  File: class {
    arrayBuffer = mocks.readAudio;
  },
}));

// Model selection reads the device's memory budget and iOS version through the
// native module. Returning null here keeps these cases on the Apple path, which
// is what they were written to cover.
vi.mock("./t3Voice", () => ({
  DIARIZER_MODEL_ID: "fluid-diarizer",
  readVoiceModelEnvironment: mocks.readVoiceModelEnvironment,
  getInstalledModelIds: mocks.getInstalledModelIds,
}));

vi.mock("./localModelTranscription.ios", () => ({
  getLocalModelVoiceTranscriber: mocks.getLocalModelVoiceTranscriber,
}));

import { getLocalVoiceTranscriber } from "./voiceTranscription.ios";

const audio = new ArrayBuffer(4);
const nativeTranscript: TranscriptionResult = {
  duration: 2,
  segments: [
    { text: " Hej", startSecond: 0, endSecond: 1 },
    { text: "världen. ", startSecond: 1, endSecond: 2 },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.isAvailable.mockReturnValue(true);
  mocks.prepare.mockResolvedValue("sv-SE");
  mocks.readAudio.mockResolvedValue(audio);
  mocks.transcribe.mockResolvedValue(nativeTranscript);
  mocks.getInstalledModelIds.mockReturnValue([]);
});

/** These cases predate model selection and only exercise Apple's recognizer. */
const noSelection = { speechModelId: null, speakerFiltering: false };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getLocalVoiceTranscriber", () => {
  it("keeps the selected language and Apple's resolved locale when the device language changes", async () => {
    const resolvedOptions = Intl.DateTimeFormat().resolvedOptions();
    const deviceLocale = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolvedOptions, locale: "sv-FI" });
    const transcriber = getLocalVoiceTranscriber(noSelection)!;
    const options = { signal: new AbortController().signal };

    deviceLocale.mockReturnValue({ ...resolvedOptions, locale: "de-DE" });
    const prepared = await transcriber.prepare(options);
    deviceLocale.mockReturnValue({ ...resolvedOptions, locale: "en-US" });

    await expect(prepared.transcribe("file:///voice.m4a", options)).resolves.toEqual({
      text: "Hej världen.",
    });
    expect(mocks.prepare).toHaveBeenCalledWith("sv-FI");
    expect(prepared.locale).toBe("sv-SE");
    expect(mocks.transcribe).toHaveBeenCalledWith(audio, "sv-SE");
  });

  it("does not start native transcription after cancellation during a file read", async () => {
    const enteredRead = deferred<void>();
    const readResult = deferred<ArrayBuffer>();
    mocks.readAudio.mockImplementation(() => {
      enteredRead.resolve();
      return readResult.promise;
    });
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const prepared = await getLocalVoiceTranscriber(noSelection)!.prepare(options);
    const result = prepared
      .transcribe("file:///voice.m4a", options)
      .catch((error: unknown) => error);

    await enteredRead.promise;
    controller.abort();
    readResult.resolve(audio);

    const error = await result;
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect(error).toMatchObject({ code: "cancelled" });
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it.each(["prepare", "transcribe"] as const)(
    "waits for native %s to finish before settling cancellation",
    async (phase) => {
      const enteredNative = deferred<void>();
      const finishNative = deferred<void>();
      if (phase === "prepare") {
        mocks.prepare.mockImplementation(async () => {
          enteredNative.resolve();
          await finishNative.promise;
          return "sv-SE";
        });
      } else {
        mocks.transcribe.mockImplementation(async () => {
          enteredNative.resolve();
          await finishNative.promise;
          return nativeTranscript;
        });
      }
      const controller = new AbortController();
      const options = { signal: controller.signal };
      const transcriber = getLocalVoiceTranscriber(noSelection)!;
      const operation =
        phase === "prepare"
          ? transcriber.prepare(options)
          : (await transcriber.prepare(options)).transcribe("file:///voice.m4a", options);
      const settled = vi.fn((value: unknown) => value);
      const result = operation.then(settled, settled);

      await enteredNative.promise;
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).not.toHaveBeenCalled();
      finishNative.resolve();

      const error = await result;
      expect(error).toBeInstanceOf(VoiceTranscriptionError);
      expect(error).toMatchObject({ code: "cancelled" });
    },
  );
});

describe("model selection", () => {
  const appleTranscriber = { prepare: expect.any(Function) };

  beforeEach(() => {
    mocks.readVoiceModelEnvironment.mockReturnValue({
      iosMajorVersion: 26,
      availableMemoryBytes: 8 * 1024 * 1024 * 1024,
      supportedBackends: ["whisperKit"],
    });
  });

  it("uses Apple on iOS 26 when Apple covers the device language", () => {
    mocks.isAvailable.mockReturnValue(true);

    expect(getLocalVoiceTranscriber(noSelection)).toEqual(appleTranscriber);
    expect(mocks.getLocalModelVoiceTranscriber).not.toHaveBeenCalled();
  });

  it("uses the bundled model below iOS 26, where Apple's recognizer does not exist", () => {
    mocks.isAvailable.mockReturnValue(true);
    mocks.readVoiceModelEnvironment.mockReturnValue({
      iosMajorVersion: 18,
      availableMemoryBytes: 8 * 1024 * 1024 * 1024,
      supportedBackends: ["whisperKit"],
    });
    const bundled = { prepare: vi.fn() };
    mocks.getLocalModelVoiceTranscriber.mockReturnValue(bundled);

    expect(getLocalVoiceTranscriber(noSelection)).toBe(bundled);
    // English, not the device locale: the bundled model only transcribes English,
    // and the controller spaces words based on what it is told here.
    expect(mocks.getLocalModelVoiceTranscriber).toHaveBeenCalledWith({
      modelId: "whisper-tiny-en",
      locale: "en",
      speakerFiltering: false,
    });
  });

  it("uses the bundled model when Apple does not cover the device language", () => {
    mocks.isAvailable.mockReturnValue(false);
    const bundled = { prepare: vi.fn() };
    mocks.getLocalModelVoiceTranscriber.mockReturnValue(bundled);

    expect(getLocalVoiceTranscriber(noSelection)).toBe(bundled);
  });

  it("falls back to Apple when the bundled model is somehow missing", () => {
    mocks.isAvailable.mockReturnValue(true);
    mocks.readVoiceModelEnvironment.mockReturnValue({
      iosMajorVersion: 18,
      availableMemoryBytes: 8 * 1024 * 1024 * 1024,
      supportedBackends: ["whisperKit"],
    });
    mocks.getLocalModelVoiceTranscriber.mockReturnValue(null);

    // Apple is unavailable below iOS 26 too, so this is the no-transcriber case
    // the composer turns into a setup affordance.
    expect(getLocalVoiceTranscriber(noSelection)).toEqual(appleTranscriber);
  });
});

describe("model substitution", () => {
  beforeEach(() => {
    mocks.isAvailable.mockReturnValue(false);
    mocks.readVoiceModelEnvironment.mockReturnValue({
      iosMajorVersion: 26,
      availableMemoryBytes: 8 * 1024 * 1024 * 1024,
      supportedBackends: ["whisperKit", "fluidAudio"],
    });
  });

  it("uses the built-in model when the chosen one will not load, and says so", async () => {
    const selected = {
      prepare: vi.fn(async () => {
        throw new Error("out of memory");
      }),
    };
    const bundled = {
      prepare: vi.fn(async () => ({
        locale: "en",
        transcribe: async () => ({ text: "hello" }),
      })),
    };
    mocks.getLocalModelVoiceTranscriber.mockImplementation((input) =>
      (input as { modelId: string }).modelId === "whisper-tiny-en" ? bundled : selected,
    );

    const transcriber = getLocalVoiceTranscriber({
      speechModelId: "whisper-small-en",
      speakerFiltering: false,
    })!;
    const options = { signal: new AbortController().signal };
    const prepared = await transcriber.prepare(options);
    const result = await prepared.transcribe("file:///voice.m4a", options);

    expect(result.text).toBe("hello");
    expect(result.notice).toContain("built-in model");
    expect(bundled.prepare).toHaveBeenCalled();
  });

  it("does not substitute when the user cancelled", async () => {
    const cancelled = new VoiceTranscriptionError(
      "cancelled",
      "Voice transcription was cancelled.",
    );
    const selected = {
      prepare: vi.fn(async () => {
        throw cancelled;
      }),
    };
    const bundled = { prepare: vi.fn() };
    mocks.getLocalModelVoiceTranscriber.mockImplementation((input) =>
      (input as { modelId: string }).modelId === "whisper-tiny-en" ? bundled : selected,
    );

    const transcriber = getLocalVoiceTranscriber({
      speechModelId: "whisper-small-en",
      speakerFiltering: false,
    })!;

    await expect(transcriber.prepare({ signal: new AbortController().signal })).rejects.toBe(
      cancelled,
    );
    expect(bundled.prepare).not.toHaveBeenCalled();
  });

  it("keeps speaker filtering off until the separation model is installed", () => {
    const selected = { prepare: vi.fn() };
    mocks.getLocalModelVoiceTranscriber.mockReturnValue(selected);
    mocks.getInstalledModelIds.mockReturnValue(["parakeet-v3"]);

    getLocalVoiceTranscriber({ speechModelId: "parakeet-v3", speakerFiltering: true });

    expect(mocks.getLocalModelVoiceTranscriber).toHaveBeenCalledWith({
      modelId: "parakeet-v3",
      locale: expect.any(String),
      speakerFiltering: false,
    });

    mocks.getLocalModelVoiceTranscriber.mockClear();
    mocks.getInstalledModelIds.mockReturnValue(["parakeet-v3", "fluid-diarizer"]);
    getLocalVoiceTranscriber({ speechModelId: "parakeet-v3", speakerFiltering: true });

    expect(mocks.getLocalModelVoiceTranscriber).toHaveBeenCalledWith({
      modelId: "parakeet-v3",
      locale: expect.any(String),
      speakerFiltering: true,
    });
  });
});
