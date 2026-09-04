import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  resetVoiceInputGlobalsForTests,
  resolveTranscriptCommit,
  VoiceInputController,
  VOICE_RECORDING_LIMIT_SECONDS,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceRecorder,
} from "./controller.ts";
import type { PendingVoiceTranscript } from "./controller.ts";
import type { DictationAnchor } from "./learning.ts";
import type { PreparedVoiceCleanup, VoiceCleanup } from "./cleanup.ts";
import {
  resolveSpeakerFilteringNotice,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "./transcription.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class TestRecorder implements VoiceRecorder {
  uri: string | null = "file:///voice.m4a";
  readonly prepareToRecordAsync = vi.fn(async () => undefined);
  readonly record = vi.fn();
  readonly stop = vi.fn(async () => undefined);
}

function preparedTranscription(
  transcribe: PreparedVoiceTranscription["transcribe"] = async () => ({ text: "new text" }),
): PreparedVoiceTranscription {
  return { locale: "en-US", transcribe };
}

/** Most tests only care about the text, so they hand back just that. */
function transcribingText(
  produce: (uri: string, options: VoiceTranscriptionOptions) => Promise<string>,
): PreparedVoiceTranscription["transcribe"] {
  return async (uri, options) => ({ text: await produce(uri, options) });
}

function draft(overrides: Partial<VoiceDraftSnapshot> = {}): VoiceDraftSnapshot {
  return {
    ownerKey: "environment:thread",
    text: "hello world",
    selection: { start: 6, end: 11 },
    revision: 1,
    ...overrides,
  };
}

function createHarness(
  overrides: Partial<VoiceInputControllerDependencies> = {},
  initialDraft = draft(),
) {
  const recorder = new TestRecorder();
  let currentDraft: VoiceDraftSnapshot | null = initialDraft;
  const commits: Array<{ text: string; selection: { start: number; end: number } }> = [];
  const deleted: string[] = [];
  const dependencies: VoiceInputControllerDependencies = {
    recorder,
    getTranscriber: () => ({ prepare: async () => preparedTranscription() }),
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => undefined,
    releaseRecording: async () => undefined,
    deleteRecording: (uri) => deleted.push(uri),
    readDraft: () => currentDraft,
    commitDraft: (text, selection) => commits.push({ text, selection }),
    onStateChange: vi.fn(),
    ...overrides,
  };
  return {
    controller: new VoiceInputController(dependencies),
    recorder,
    commits,
    deleted,
    setDraft: (next: VoiceDraftSnapshot | null) => {
      currentDraft = next;
    },
  };
}

describe("resolveTranscriptCommit", () => {
  it("replaces the recorded UTF-16 selection around emoji and composer tokens", () => {
    const text = "Fix 🧪 then $review please";
    const tokenStart = text.indexOf("$review");
    const captured = draft({
      text,
      selection: { start: tokenStart, end: tokenStart + "$review".length },
    });

    expect(resolveTranscriptCommit(captured, captured, "use the mobile skill", "en-US")).toEqual({
      kind: "commit",
      text: "Fix 🧪 then use the mobile skill please",
      selection: { start: tokenStart + "use the mobile skill".length, end: tokenStart + 20 },
      insertedRange: { start: tokenStart, end: tokenStart + "use the mobile skill".length },
    });
  });

  it("does not replace text after the owner, text, or revision changes", () => {
    const captured = draft();
    expect(
      resolveTranscriptCommit(captured, draft({ ownerKey: "other" }), "text", "en-US"),
    ).toEqual({
      kind: "stale",
    });
    expect(resolveTranscriptCommit(captured, draft({ text: "newer" }), "text", "en-US")).toEqual({
      kind: "stale",
    });
    expect(resolveTranscriptCommit(captured, draft({ revision: 2 }), "text", "en-US")).toEqual({
      kind: "stale",
    });
  });

  it("adds English spacing at empty start, middle, and end caret boundaries", () => {
    const atEnd = draft({
      text: "Fix cache.",
      selection: { start: "Fix cache.".length, end: "Fix cache.".length },
    });
    expect(resolveTranscriptCommit(atEnd, atEnd, "Also fix tests.", "en-US")).toMatchObject({
      kind: "commit",
      text: "Fix cache. Also fix tests.",
    });
    expect(resolveTranscriptCommit(atEnd, atEnd, "Also fix tests.", "en_US")).toMatchObject({
      kind: "commit",
      text: "Fix cache. Also fix tests.",
    });

    const atStart = draft({ text: "Fix cache.", selection: { start: 0, end: 0 } });
    expect(resolveTranscriptCommit(atStart, atStart, "First", "en-US")).toMatchObject({
      kind: "commit",
      text: "First Fix cache.",
    });

    const inMiddle = draft({ text: "Fix cache.", selection: { start: 4, end: 4 } });
    expect(resolveTranscriptCommit(inMiddle, inMiddle, "also", "en-US")).toMatchObject({
      kind: "commit",
      text: "Fix also cache.",
    });
  });

  it("does not add English boundary spaces to CJK or selected inline text", () => {
    const cjk = draft({ text: "修正キャッシュ", selection: { start: 8, end: 8 } });
    expect(resolveTranscriptCommit(cjk, cjk, "テストも", "ja-JP")).toMatchObject({
      kind: "commit",
      text: "修正キャッシュテストも",
    });

    const selected = draft({ text: "one $skill two", selection: { start: 4, end: 10 } });
    expect(resolveTranscriptCommit(selected, selected, "new", "en-US")).toMatchObject({
      kind: "commit",
      text: "one new two",
    });
  });
});

describe("VoiceInputController", () => {
  beforeEach(() => resetVoiceInputGlobalsForTests());

  it("checks support and permission before recording", async () => {
    const unsupported = createHarness({ getTranscriber: () => null });
    await unsupported.controller.start();
    expect(unsupported.controller.currentState.error).toContain("not available");
    expect(unsupported.recorder.record).not.toHaveBeenCalled();

    const denied = createHarness({
      requestPermission: async () => ({ granted: false, canAskAgain: false }),
    });
    await denied.controller.start();
    expect(denied.controller.currentState.errorAction).toBe("settings");
    expect(denied.recorder.record).not.toHaveBeenCalled();
  });

  it.each(["permission", "transcription"] as const)(
    "clears %s errors when switching to another draft",
    async (failure) => {
      const harness = createHarness(
        failure === "permission"
          ? { requestPermission: async () => ({ granted: false, canAskAgain: false }) }
          : {
              getTranscriber: () => ({
                prepare: async () =>
                  preparedTranscription(async () => {
                    throw new Error("Transcription failed");
                  }),
              }),
            },
      );
      await harness.controller.start();
      await harness.controller.stop();
      expect(harness.controller.currentState).toMatchObject({
        phase: "error",
        error: expect.any(String),
        errorAction: failure === "permission" ? "settings" : "retry",
        notice: null,
      });

      harness.setDraft(draft({ ownerKey: "environment:other-thread" }));
      harness.controller.ownerChanged();

      expect(harness.controller.currentState).toEqual({
        phase: "idle",
        error: null,
        errorAction: null,
        notice: null,
      });
      expect(harness.commits).toEqual([]);
    },
  );

  it.each(["permission", "preparation", "recording"] as const)(
    "keeps the selected transcriber when preferences change during %s",
    async (changeDuring) => {
      const permission = deferred<{ granted: boolean; canAskAgain: boolean }>();
      const permissionEntered = deferred<void>();
      const preparation = deferred<void>();
      const preparationEntered = deferred<void>();
      const preparationSignals: AbortSignal[] = [];
      const transcriptionSignals: AbortSignal[] = [];
      const transcriber = (text: string): VoiceTranscriber => ({
        prepare: async ({ signal }) => {
          preparationSignals.push(signal);
          preparationEntered.resolve(undefined);
          await preparation.promise;
          return preparedTranscription(
            transcribingText(async (_uri, { signal }) => {
              transcriptionSignals.push(signal);
              return text;
            }),
          );
        },
      });
      const first = transcriber("first choice");
      const second = transcriber("second choice");
      let selected = first;
      const harness = createHarness({
        getTranscriber: () => selected,
        requestPermission: () => {
          permissionEntered.resolve(undefined);
          return permission.promise;
        },
      });

      const starting = harness.controller.start();
      await permissionEntered.promise;
      if (changeDuring === "permission") selected = second;
      permission.resolve({ granted: true, canAskAgain: true });
      await preparationEntered.promise;
      if (changeDuring === "preparation") selected = second;
      preparation.resolve(undefined);
      await starting;
      if (changeDuring === "recording") selected = second;
      await harness.controller.stop();

      expect(harness.commits.map((commit) => commit.text)).toEqual(["hello first choice"]);

      await harness.controller.start();
      await harness.controller.stop();

      expect(harness.commits.map((commit) => commit.text)).toEqual([
        "hello first choice",
        "hello second choice",
      ]);
      expect(preparationSignals).toHaveLength(2);
      expect(transcriptionSignals).toHaveLength(2);
      expect(transcriptionSignals[0]).toBe(preparationSignals[0]);
      expect(transcriptionSignals[1]).toBe(preparationSignals[1]);
      expect(preparationSignals[1]).not.toBe(preparationSignals[0]);
    },
  );

  it("blocks submit while voice input can still change the draft", () => {
    expect(
      voiceInputBlocksSubmission({
        phase: "preparing",
        error: null,
        errorAction: null,
        notice: null,
      }),
    ).toBe(true);
    expect(
      voiceInputBlocksSubmission({
        phase: "recording",
        error: null,
        errorAction: null,
        notice: null,
      }),
    ).toBe(true);
    expect(
      voiceInputBlocksSubmission({
        phase: "transcribing",
        error: null,
        errorAction: null,
        notice: null,
      }),
    ).toBe(true);
    expect(
      voiceInputBlocksSubmission({ phase: "idle", error: null, errorAction: null, notice: null }),
    ).toBe(false);
  });

  it("uses the native five-minute cap and commits one final transcript", async () => {
    const harness = createHarness();
    await harness.controller.start();
    expect(harness.recorder.record).toHaveBeenCalledWith({
      forDuration: VOICE_RECORDING_LIMIT_SECONDS,
    });

    const stopping = harness.controller.stop();
    harness.controller.handleRecorderStatus({
      isFinished: true,
      hasError: false,
      error: null,
      url: "file:///voice.m4a",
    });
    await stopping;

    expect(harness.commits).toEqual([
      { text: "hello new text", selection: { start: 14, end: 14 } },
    ]);
    expect(harness.deleted).toEqual(["file:///voice.m4a"]);
  });

  it.each(["cancel", "dispose", "ownerChanged"] as const)(
    "holds the session after %s until non-abortable transcription settles",
    async (action) => {
      const transcription = deferred<string>();
      const transcriptionEntered = deferred<AbortSignal>();
      const harness = createHarness({
        getTranscriber: () => ({
          prepare: async () =>
            preparedTranscription(
              transcribingText((_uri, { signal }) => {
                transcriptionEntered.resolve(signal);
                return transcription.promise;
              }),
            ),
        }),
      });
      await harness.controller.start();
      const stopping = harness.controller.stop();
      const signal = await transcriptionEntered.promise;
      expect(signal.aborted).toBe(false);
      if (action === "ownerChanged") {
        harness.setDraft(draft({ ownerKey: "environment:other-thread" }));
      }
      harness.controller[action]();
      expect(signal.aborted).toBe(true);

      const next = createHarness();
      await next.controller.start();
      expect(next.controller.currentState.error).toContain("already active");
      expect(next.recorder.record).not.toHaveBeenCalled();

      transcription.resolve("late text");
      await stopping;

      expect(harness.commits).toEqual([]);
      expect(harness.deleted).toEqual(["file:///voice.m4a"]);
      expect(harness.controller.currentState.phase).toBe("idle");

      await next.controller.start();
      expect(next.controller.currentState.phase).toBe("recording");
      await next.controller.interruptRecording();
    },
  );

  it("cancels an in-flight transcriber that rejects when its signal aborts", async () => {
    const transcription = deferred<string>();
    const transcriptionEntered = deferred<AbortSignal>();
    const harness = createHarness({
      getTranscriber: () => ({
        prepare: async () =>
          preparedTranscription(
            transcribingText((_uri, { signal }) => {
              signal.addEventListener("abort", () => transcription.reject(new Error("aborted")), {
                once: true,
              });
              transcriptionEntered.resolve(signal);
              return transcription.promise;
            }),
          ),
      }),
    });
    await harness.controller.start();
    const stopping = harness.controller.stop();
    const signal = await transcriptionEntered.promise;
    harness.controller.cancel();
    await stopping;

    expect(signal.aborted).toBe(true);
    expect(harness.commits).toEqual([]);
    expect(harness.deleted).toEqual(["file:///voice.m4a"]);
    expect(harness.controller.currentState.phase).toBe("idle");
  });

  it("releases the microphone before transcription starts", async () => {
    const events: string[] = [];
    const harness = createHarness({
      releaseRecording: async () => {
        events.push("released");
      },
      getTranscriber: () => ({
        prepare: async () =>
          preparedTranscription(
            transcribingText(async () => {
              events.push("transcribed");
              return "done";
            }),
          ),
      }),
    });
    await harness.controller.start();
    await harness.controller.stop();

    expect(events).toEqual(["released", "transcribed"]);
  });

  it("retries audio-session release during final cleanup", async () => {
    const releaseRecording = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(undefined);
    const harness = createHarness({ releaseRecording });
    await harness.controller.start();
    await harness.controller.stop();

    expect(releaseRecording).toHaveBeenCalledTimes(2);
  });

  it("leaves transcription with an error when recorder finalization fails", async () => {
    const harness = createHarness();
    harness.recorder.stop.mockRejectedValueOnce(new Error("stop failed"));
    await harness.controller.start();
    await harness.controller.stop();

    expect(harness.controller.currentState.phase).toBe("error");
    expect(harness.controller.currentState.error).toContain("finish voice recording");
  });

  it("ignores a late transcript after the draft owner changes", async () => {
    const transcription = deferred<string>();
    const transcriptionEntered = deferred<void>();
    const harness = createHarness({
      getTranscriber: () => ({
        prepare: async () =>
          preparedTranscription(
            transcribingText(() => {
              transcriptionEntered.resolve(undefined);
              return transcription.promise;
            }),
          ),
      }),
    });
    await harness.controller.start();
    const stopping = harness.controller.stop();
    await transcriptionEntered.promise;
    harness.setDraft(draft({ ownerKey: "environment:other-thread" }));
    transcription.resolve("late text");
    await stopping;

    expect(harness.commits).toEqual([]);
    expect(harness.controller.currentState.error).toContain("draft changed");
  });

  it("keeps the app-wide session locked until canceled preparation settles", async () => {
    const preparation = deferred<PreparedVoiceTranscription>();
    const preparationEntered = deferred<AbortSignal>();
    const first = createHarness({
      getTranscriber: () => ({
        prepare: ({ signal }) => {
          preparationEntered.resolve(signal);
          return preparation.promise;
        },
      }),
    });
    const firstStart = first.controller.start();
    const signal = await preparationEntered.promise;
    first.controller.cancel();
    expect(signal.aborted).toBe(true);

    const blocked = createHarness();
    await blocked.controller.start();
    expect(blocked.controller.currentState.error).toContain("already active");

    preparation.resolve(preparedTranscription());
    await firstStart;
    expect(first.recorder.record).not.toHaveBeenCalled();
    blocked.controller.cancel();

    const next = createHarness();
    await next.controller.start();
    expect(next.controller.currentState.phase).toBe("recording");
    await next.controller.interruptRecording();
  });

  it("does not start the microphone for an owner that changed during preparation", async () => {
    const preparation = deferred<PreparedVoiceTranscription>();
    const preparationEntered = deferred<void>();
    const harness = createHarness({
      getTranscriber: () => ({
        prepare: () => {
          preparationEntered.resolve(undefined);
          return preparation.promise;
        },
      }),
    });
    const starting = harness.controller.start();
    await preparationEntered.promise;
    harness.setDraft(draft({ ownerKey: "environment:other-thread", text: "other draft" }));
    preparation.resolve(preparedTranscription());
    await starting;

    expect(harness.recorder.record).not.toHaveBeenCalled();
    expect(harness.controller.currentState.error).toContain("no longer available");
  });

  it("discards recorder errors and audio interruptions without transcribing", async () => {
    const transcribe = vi.fn(async () => "ignored");
    const preparationEntered = deferred<AbortSignal>();
    const harness = createHarness({
      getTranscriber: () => ({
        prepare: async ({ signal }) => {
          preparationEntered.resolve(signal);
          return preparedTranscription(transcribingText(transcribe));
        },
      }),
    });
    await harness.controller.start();
    const signal = await preparationEntered.promise;
    harness.recorder.uri = "file:///reset-empty.m4a";
    await harness.controller.handleRecorderStatus({
      isFinished: true,
      hasError: true,
      error: "Audio route changed",
      url: "file:///voice.m4a",
    });

    expect(harness.commits).toEqual([]);
    expect(transcribe).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(true);
    expect(harness.controller.currentState.error).toBe("Audio route changed");
    expect(harness.deleted).toEqual(["file:///voice.m4a", "file:///reset-empty.m4a"]);
  });

  it("cancels preparation when the app reaches the background", async () => {
    const preparation = deferred<PreparedVoiceTranscription>();
    const preparationEntered = deferred<AbortSignal>();
    const harness = createHarness({
      getTranscriber: () => ({
        prepare: ({ signal }) => {
          preparationEntered.resolve(signal);
          return preparation.promise;
        },
      }),
    });
    const starting = harness.controller.start();
    const signal = await preparationEntered.promise;
    harness.controller.appMovedToBackground();
    expect(signal.aborted).toBe(true);
    preparation.resolve(preparedTranscription());
    await starting;

    expect(harness.recorder.record).not.toHaveBeenCalled();
    expect(harness.controller.currentState.error).toContain("background");
  });
});

describe("VoiceInputController cleanup stage", () => {
  beforeEach(() => resetVoiceInputGlobalsForTests());

  const RAW = "um so add a retry button to the connection settings screen";

  function cleanupHarness(clean: PreparedVoiceCleanup["clean"]) {
    const phases: string[] = [];
    const persisted: PendingVoiceTranscript[] = [];
    let cleared = 0;
    const cleanup: VoiceCleanup = { prepare: async () => ({ clean }) };
    const harness = createHarness({
      getTranscriber: () => ({
        prepare: async () => preparedTranscription(transcribingText(async () => RAW)),
      }),
      getCleanup: () => cleanup,
      persistPendingTranscript: (pending) => persisted.push(pending),
      clearPendingTranscript: () => {
        cleared += 1;
      },
      onStateChange: (state) => phases.push(state.phase),
    });
    return { ...harness, phases, persisted, cleared: () => cleared };
  }

  async function recordAndStop(harness: ReturnType<typeof cleanupHarness>) {
    await harness.controller.start();
    const stopping = harness.controller.stop();
    harness.controller.handleRecorderStatus({
      isFinished: true,
      hasError: false,
      error: null,
      url: "file:///voice.m4a",
    });
    return stopping;
  }

  it("commits the cleaned transcript and reports a cleaning phase while it runs", async () => {
    const harness = cleanupHarness(async () => "Add a retry button to the connection settings.");
    await recordAndStop(harness);

    expect(harness.phases).toEqual(["preparing", "recording", "transcribing", "cleaning", "idle"]);
    expect(harness.commits).toEqual([
      {
        text: "hello Add a retry button to the connection settings.",
        selection: { start: 52, end: 52 },
      },
    ]);
  });

  it("persists the raw transcript before cleanup and clears it once the app has responded", async () => {
    const harness = cleanupHarness(async () => "Add a retry button to the connection settings.");
    await recordAndStop(harness);

    expect(harness.persisted).toEqual([{ ownerKey: "environment:thread", revision: 1, text: RAW }]);
    expect(harness.cleared()).toBe(1);
  });

  it("commits the raw transcript when cleanup throws", async () => {
    const harness = cleanupHarness(async () => {
      throw new Error("model unavailable");
    });
    await recordAndStop(harness);

    expect(harness.commits).toEqual([
      { text: `hello ${RAW}`, selection: { start: 6 + RAW.length, end: 6 + RAW.length } },
    ]);
  });

  it("commits the raw transcript when the model answers instead of rewriting", async () => {
    const harness = cleanupHarness(
      async () =>
        "Sure! Here is a plan for adding a retry button, including where to put it, what to call it, and how to wire up the handler.",
    );
    await recordAndStop(harness);

    expect(harness.commits).toEqual([
      { text: `hello ${RAW}`, selection: { start: 6 + RAW.length, end: 6 + RAW.length } },
    ]);
  });

  it("keeps the raw transcript when the user cancels the rewrite", async () => {
    const cleaning = deferred<string>();
    const cleaningEntered = deferred<AbortSignal>();
    const harness = cleanupHarness((_transcript, { signal }) => {
      cleaningEntered.resolve(signal);
      signal.addEventListener("abort", () => cleaning.reject(new Error("aborted")), { once: true });
      return cleaning.promise;
    });

    const stopping = recordAndStop(harness);
    const signal = await cleaningEntered.promise;
    expect(harness.controller.currentState.phase).toBe("cleaning");

    harness.controller.cancel();
    expect(signal.aborted).toBe(true);
    await stopping;

    expect(harness.commits).toEqual([
      { text: `hello ${RAW}`, selection: { start: 6 + RAW.length, end: 6 + RAW.length } },
    ]);
    expect(harness.controller.currentState.phase).toBe("idle");
  });

  it("drops the transcript when the draft owner changes during the rewrite", async () => {
    const cleaning = deferred<string>();
    const cleaningEntered = deferred<AbortSignal>();
    const harness = cleanupHarness((_transcript, { signal }) => {
      cleaningEntered.resolve(signal);
      signal.addEventListener("abort", () => cleaning.reject(new Error("aborted")), { once: true });
      return cleaning.promise;
    });

    const stopping = recordAndStop(harness);
    await cleaningEntered.promise;
    harness.setDraft(draft({ ownerKey: "environment:other-thread" }));
    harness.controller.ownerChanged();
    await stopping;

    expect(harness.commits).toEqual([]);
    expect(harness.controller.currentState.phase).toBe("idle");
  });

  it("does not enter the cleaning phase when cleanup is switched off", async () => {
    const phases: string[] = [];
    const harness = createHarness({
      getCleanup: () => null,
      onStateChange: (state) => phases.push(state.phase),
    });
    await harness.controller.start();
    const stopping = harness.controller.stop();
    harness.controller.handleRecorderStatus({
      isFinished: true,
      hasError: false,
      error: null,
      url: "file:///voice.m4a",
    });
    await stopping;

    expect(phases).not.toContain("cleaning");
    expect(harness.commits).toEqual([
      { text: "hello new text", selection: { start: 14, end: 14 } },
    ]);
  });
});

describe("speaker filtering disclosure", () => {
  beforeEach(() => resetVoiceInputGlobalsForTests());

  it("says nothing when filtering was off or did its job", () => {
    expect(resolveSpeakerFilteringNotice(undefined)).toBeNull();
    expect(
      resolveSpeakerFilteringNotice({ requested: false, applied: false, fallbackReason: null }),
    ).toBeNull();
    expect(
      resolveSpeakerFilteringNotice({ requested: true, applied: true, fallbackReason: null }),
    ).toBeNull();
  });

  it("says nothing when there was only one voice to begin with", () => {
    expect(
      resolveSpeakerFilteringNotice({
        requested: true,
        applied: false,
        fallbackReason: "singleSpeaker",
      }),
    ).toBeNull();
  });

  it("warns when other voices may still be in the transcript", () => {
    expect(
      resolveSpeakerFilteringNotice({
        requested: true,
        applied: false,
        fallbackReason: "ambiguousDominantSpeaker",
      }),
    ).toContain("More than one voice");
  });

  it("carries the disclosure into the state the composer reads", async () => {
    const harness = createHarness({
      getTranscriber: () => ({
        prepare: async () =>
          preparedTranscription(async () => ({
            text: "new text",
            speakerFiltering: {
              requested: true,
              applied: false,
              fallbackReason: "ambiguousDominantSpeaker" as const,
            },
          })),
      }),
    });

    await harness.controller.start();
    const stopping = harness.controller.stop();
    harness.controller.handleRecorderStatus({
      isFinished: true,
      hasError: false,
      error: null,
      url: "file:///voice.m4a",
    });
    await stopping;

    expect(harness.controller.currentState.phase).toBe("idle");
    expect(harness.controller.currentState.notice).toContain("More than one voice");
    expect(harness.commits).toHaveLength(1);
  });

  it("clears the disclosure when the next recording starts", async () => {
    const harness = createHarness();
    await harness.controller.start();
    expect(harness.controller.currentState.notice).toBeNull();
    await harness.controller.interruptRecording();
  });
});

describe("learning anchor", () => {
  beforeEach(() => resetVoiceInputGlobalsForTests());

  it("reports the span the transcript wrote, with the text on either side", async () => {
    const anchors: DictationAnchor[] = [];
    const harness = createHarness({
      onDictationCommitted: (anchor) => anchors.push(anchor),
    });

    await harness.controller.start();
    const stopping = harness.controller.stop();
    harness.controller.handleRecorderStatus({
      isFinished: true,
      hasError: false,
      error: null,
      url: "file:///voice.m4a",
    });
    await stopping;

    // The captured draft is "hello world" with "world" selected, so the
    // transcript replaces it and the text before it is all that survives.
    expect(anchors).toEqual([
      {
        ownerKey: "environment:thread",
        revision: 1,
        before: "hello ",
        insertedText: "new text",
        after: "",
      },
    ]);
  });

  it("reports no anchor when the transcript was never committed", async () => {
    const anchors: DictationAnchor[] = [];
    const harness = createHarness({
      getTranscriber: () => ({
        prepare: async () => preparedTranscription(transcribingText(async () => "   ")),
      }),
      onDictationCommitted: (anchor) => anchors.push(anchor),
    });

    await harness.controller.start();
    const stopping = harness.controller.stop();
    harness.controller.handleRecorderStatus({
      isFinished: true,
      hasError: false,
      error: null,
      url: "file:///voice.m4a",
    });
    await stopping;

    expect(anchors).toEqual([]);
    expect(harness.controller.currentState.error).toContain("No speech");
  });
});

describe("backgrounding after the recording is made", () => {
  beforeEach(() => resetVoiceInputGlobalsForTests());

  it.each(["transcribing", "cleaning"] as const)(
    "keeps working when the app backgrounds during %s",
    async (phase) => {
      const work = deferred<string>();
      const entered = deferred<void>();
      const cleanup: VoiceCleanup = {
        prepare: async () => ({
          clean: () => {
            entered.resolve();
            return work.promise;
          },
        }),
      };
      const harness = createHarness({
        getTranscriber: () => ({
          prepare: async () =>
            preparedTranscription(
              transcribingText(() => {
                if (phase === "transcribing") entered.resolve();
                return phase === "transcribing" ? work.promise : Promise.resolve("said words");
              }),
            ),
        }),
        ...(phase === "cleaning" ? { getCleanup: () => cleanup } : {}),
      });

      await harness.controller.start();
      const stopping = harness.controller.stop();
      harness.controller.handleRecorderStatus({
        isFinished: true,
        hasError: false,
        error: null,
        url: "file:///voice.m4a",
      });
      await entered.promise;
      expect(harness.controller.currentState.phase).toBe(phase);

      await harness.controller.appMovedToBackground();
      expect(harness.controller.currentState.phase).toBe(phase);

      work.resolve("said words");
      await stopping;

      expect(harness.commits).toHaveLength(1);
    },
  );
});
