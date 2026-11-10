import type { TranscriptionResult } from "@react-native-ai/apple/src/NativeAppleTranscription";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { VoiceInputController, VoiceTranscriptionError } from "@t3tools/client-runtime/voice-input";
import { resetVoiceInputGlobalsForTests } from "../../../../packages/client-runtime/src/voice-input/controller";

const mocks = vi.hoisted(() => ({
  isAvailable: vi.fn<(locale: string) => boolean>(),
  prepare: vi.fn<(locale: string) => Promise<string>>(),
  transcribe: vi.fn<(audio: ArrayBufferLike, locale: string) => Promise<TranscriptionResult>>(),
  readAudio: vi.fn<() => Promise<ArrayBuffer>>(),
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

/** Drives one on-device dictation through the controller the composer uses. */
function createDictation() {
  const recorder = {
    uri: "file:///voice.m4a",
    prepareToRecordAsync: async () => {},
    record: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const commits: string[] = [];
  const controller = new VoiceInputController({
    recorder,
    getTranscriber: () => ({
      prepare: async (options) => (await getLocalVoiceTranscriber())!.prepare(options),
    }),
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => {},
    releaseRecording: async () => {},
    deleteRecording: () => {},
    readDraft: () => ({
      ownerKey: "environment:thread",
      text: "",
      selection: { start: 0, end: 0 },
      revision: 1,
    }),
    commitDraft: (text) => commits.push(text),
    onStateChange: () => {},
  });
  return { controller, recorder, commits };
}

beforeEach(() => {
  vi.resetAllMocks();
  resetVoiceInputGlobalsForTests();
  mocks.isAvailable.mockReturnValue(true);
  mocks.prepare.mockResolvedValue("sv-SE");
  mocks.readAudio.mockResolvedValue(audio);
  mocks.transcribe.mockResolvedValue(nativeTranscript);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getLocalVoiceTranscriber", () => {
  it("records while Apple prepares its speech model and transcribes once it is ready", async () => {
    const nativePrepare = deferred<string>();
    mocks.prepare.mockReturnValue(nativePrepare.promise);
    const dictation = createDictation();

    await dictation.controller.start();
    expect(dictation.recorder.record).toHaveBeenCalledOnce();
    expect(dictation.controller.currentState.phase).toBe("recording");

    const stopping = dictation.controller.stop();
    nativePrepare.resolve("sv-SE");
    await stopping;

    expect(mocks.transcribe).toHaveBeenCalledExactlyOnceWith(audio, "sv-SE");
    expect(dictation.commits).toEqual(["Hej världen."]);
  });

  it.each([
    ["AppleTranscriptionUnsupportedLocale", "unsupported-locale"],
    ["Network", "preparation-failed"],
  ])(
    "reports a %s failure to prepare when the recording is transcribed",
    async (code, expected) => {
      mocks.prepare.mockRejectedValue(Object.assign(new Error("failed"), { code }));
      const options = { signal: new AbortController().signal };
      const error = await (await getLocalVoiceTranscriber())!
        .prepare(options)
        .then((prepared) => prepared.transcribe("file:///voice.m4a", options))
        .catch((cause: unknown) => cause);

      expect(error).toMatchObject({ code: expected });
      expect(mocks.transcribe).not.toHaveBeenCalled();
    },
  );

  it("does not start native transcription after cancellation during a file read", async () => {
    const enteredRead = deferred<void>();
    const readResult = deferred<ArrayBuffer>();
    mocks.readAudio.mockImplementation(() => {
      enteredRead.resolve();
      return readResult.promise;
    });
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const prepared = await (await getLocalVoiceTranscriber())!.prepare(options);
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
