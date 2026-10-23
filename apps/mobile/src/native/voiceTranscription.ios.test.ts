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

  it("keeps Parakeet and speaker filtering when resident models reduce free memory", async () => {
    mocks.isAvailable.mockReturnValue(true);
    mocks.readVoiceModelEnvironment.mockReturnValue({
      iosMajorVersion: 26,
      availableMemoryBytes: 64 * 1024 * 1024,
      supportedBackends: ["whisperKit", "fluidAudio"],
    });
    mocks.getInstalledModelIds.mockReturnValue(["parakeet-v3", "fluid-diarizer"]);
    const prepare = vi.fn(async () => ({
      locale: "en",
      transcribe: async () => ({ text: "selected model" }),
    }));
    mocks.getLocalModelVoiceTranscriber.mockReturnValue({ prepare });

    const transcriber = getLocalVoiceTranscriber({
      speechModelId: "parakeet-v3",
      speakerFiltering: true,
    })!;
    const options = { signal: new AbortController().signal };
    const prepared = await transcriber.prepare(options);
    expect((await prepared.transcribe("file:///voice.m4a", options)).text).toBe("selected model");
    expect(mocks.getLocalModelVoiceTranscriber).toHaveBeenCalledWith({
      modelId: "parakeet-v3",
      locale: expect.any(String),
      speakerFiltering: true,
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
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

  it.each([
    { label: "fresh install", ids: [], expected: false },
    { label: "legacy model awaiting update", ids: ["fluid-diarizer"], expected: true },
    { label: "current model", ids: ["fluid-diarizer-offline"], expected: true },
    {
      label: "completed update retaining the legacy model",
      ids: ["fluid-diarizer", "fluid-diarizer-offline"],
      expected: true,
    },
  ])("preserves requested filtering for $label", ({ ids, expected }) => {
    mocks.getLocalModelVoiceTranscriber.mockReturnValue({ prepare: vi.fn() });
    mocks.getInstalledModelIds.mockReturnValue(["parakeet-v3", ...ids]);

    getLocalVoiceTranscriber({ speechModelId: "parakeet-v3", speakerFiltering: true });

    expect(mocks.getLocalModelVoiceTranscriber).toHaveBeenCalledWith({
      modelId: "parakeet-v3",
      locale: expect.any(String),
      speakerFiltering: expected,
    });
  });
});
