import { expect, it, vi } from "vite-plus/test";

import type { DictationClipCheck } from "./dictationNative";
import { createVoiceEnrollment, type EnrollmentRecording } from "./voiceEnrollment";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const GOOD: DictationClipCheck = { speechSeconds: 6, problem: null, message: null };
const QUIET: DictationClipCheck = {
  speechSeconds: 0,
  problem: "tooQuiet",
  message: "No speech was heard. Move closer to the microphone and try again.",
};

function setup() {
  const files = new Set<string>();
  const limits: Array<() => void> = [];
  let recorded = 0;
  const native = {
    checkEnrollmentClip: vi.fn(async (_uri: string) => GOOD),
    saveVoiceProfile: vi.fn(async (_uris: ReadonlyArray<string>) => {}),
  };
  const record = vi.fn(async (onLimit: () => void): Promise<EnrollmentRecording> => {
    limits.push(onLimit);
    recorded += 1;
    const uri = `file:///clip-${recorded}.m4a`;
    return {
      stop: async () => {
        files.add(uri);
        return uri;
      },
    };
  });
  const onSaved = vi.fn();
  const enrollment = createVoiceEnrollment({
    native,
    record,
    deleteFile: (uri) => {
      if (!files.delete(uri)) throw new Error(`no file at ${uri}`);
    },
    onSaved,
  });
  const recordClip = async () => {
    await enrollment.start();
    await enrollment.stop();
  };
  return { enrollment, native, record, onSaved, files, limits, recordClip };
}

it("saves the profile from 3 accepted samples and deletes their files", async () => {
  const { enrollment, native, onSaved, files, recordClip } = setup();
  await recordClip();
  expect(enrollment.getSnapshot()).toEqual({ phase: "idle", accepted: 1, message: null });
  await recordClip();
  await recordClip();

  expect(native.saveVoiceProfile).toHaveBeenCalledWith([
    "file:///clip-1.m4a",
    "file:///clip-2.m4a",
    "file:///clip-3.m4a",
  ]);
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(files.size).toBe(0);
  expect(enrollment.getSnapshot()).toEqual({ phase: "idle", accepted: 0, message: null });
});

it("asks for a sample again when it is turned down, keeping the ones already accepted", async () => {
  const { enrollment, native, files, recordClip } = setup();
  await recordClip();
  native.checkEnrollmentClip.mockResolvedValueOnce(QUIET);
  await recordClip();

  expect(enrollment.getSnapshot()).toEqual({ phase: "idle", accepted: 1, message: QUIET.message });
  expect([...files]).toEqual(["file:///clip-1.m4a"]);

  await enrollment.start();
  expect(enrollment.getSnapshot()).toEqual({ phase: "recording", accepted: 1, message: null });
});

it("starts over when the samples do not make a profile", async () => {
  const { enrollment, native, onSaved, files, recordClip } = setup();
  native.saveVoiceProfile.mockRejectedValueOnce(
    new Error("The recordings do not sound like the same voice. Record them again."),
  );
  await recordClip();
  await recordClip();
  await recordClip();

  expect(enrollment.getSnapshot()).toEqual({
    phase: "idle",
    accepted: 0,
    message: "The recordings do not sound like the same voice. Record them again.",
  });
  expect(onSaved).not.toHaveBeenCalled();
  expect(files.size).toBe(0);
});

it("shows why recording could not start", async () => {
  const { enrollment, record } = setup();
  record.mockRejectedValueOnce(new Error("Microphone access is off for PseudoCode."));
  await enrollment.start();
  expect(enrollment.getSnapshot()).toEqual({
    phase: "idle",
    accepted: 0,
    message: "Microphone access is off for PseudoCode.",
  });
});

it("stops by itself at the length limit", async () => {
  const { enrollment, native, limits } = setup();
  const checked = deferred<DictationClipCheck>();
  native.checkEnrollmentClip.mockReturnValueOnce(checked.promise);
  await enrollment.start();
  limits[0]!();
  expect(enrollment.getSnapshot().phase).toBe("checking");
  checked.resolve(GOOD);
  await vi.waitFor(() => expect(enrollment.getSnapshot().accepted).toBe(1));
});

it("ignores a second start and a stop with nothing recording", async () => {
  const { enrollment, record, native } = setup();
  await enrollment.stop();
  expect(native.checkEnrollmentClip).not.toHaveBeenCalled();
  await enrollment.start();
  await enrollment.start();
  expect(record).toHaveBeenCalledTimes(1);
});

it("throws away the recording and the accepted samples on reset", async () => {
  const { enrollment, files, recordClip } = setup();
  await recordClip();
  await enrollment.start();
  enrollment.reset();
  expect(enrollment.getSnapshot()).toEqual({ phase: "idle", accepted: 0, message: null });
  await vi.waitFor(() => expect(files.size).toBe(0));
});

it("discards a sample whose check finishes after a reset", async () => {
  const { enrollment, native, files } = setup();
  const checked = deferred<DictationClipCheck>();
  native.checkEnrollmentClip.mockReturnValueOnce(checked.promise);
  await enrollment.start();
  const stopping = enrollment.stop();
  await vi.waitFor(() => expect(native.checkEnrollmentClip).toHaveBeenCalled());
  enrollment.reset();
  checked.resolve(GOOD);
  await stopping;

  expect(enrollment.getSnapshot()).toEqual({ phase: "idle", accepted: 0, message: null });
  expect(files.size).toBe(0);
});

it("stops a recorder that finishes starting after a reset", async () => {
  const { enrollment, record, files } = setup();
  const started = deferred<EnrollmentRecording>();
  record.mockReturnValueOnce(started.promise);
  const starting = enrollment.start();
  enrollment.reset();
  const stop = vi.fn(async () => {
    files.add("file:///late.m4a");
    return "file:///late.m4a";
  });
  started.resolve({ stop });
  await starting;

  await vi.waitFor(() => expect(files.size).toBe(0));
  expect(stop).toHaveBeenCalledTimes(1);
  expect(enrollment.getSnapshot().phase).toBe("idle");
});
