import { describe, expect, it, vi } from "vite-plus/test";

import {
  createDictationStore,
  DEFAULT_DICTATION_STATE,
  sanitizeDictationState,
  type DictationRun,
} from "./dictationStore";

const RUN: DictationRun = {
  at: 1,
  engine: "apple",
  fallback: null,
  audioSeconds: null,
  processingSeconds: 0.2,
  filter: null,
};

function memoryFile(initial: string | null) {
  const file = { contents: initial };
  const write = vi.fn(async (contents: string) => {
    file.contents = contents;
  });
  return { file, write, read: async () => file.contents };
}

describe("sanitizeDictationState", () => {
  it.each([null, "text", 4, [], { settings: 3, learning: [] }])(
    "falls back to defaults for %j",
    (raw) => {
      expect(sanitizeDictationState(raw)).toEqual(DEFAULT_DICTATION_STATE);
    },
  );

  it("keeps every well formed entry and drops the rest", () => {
    const state = sanitizeDictationState({
      settings: { modelId: "parakeet-v3", onlyMyVoice: true, removeFillers: "yes" },
      learning: {
        rules: [
          { heard: "cube control", written: "kubectl", source: "learned", addedAt: 7 },
          { heard: "there", written: "their", source: "someone", addedAt: "then" },
          { heard: "", written: "x" },
          { heard: "x" },
          "rule",
        ],
        candidates: [
          { heard: "cloud", written: "Claude", sightings: [3, "4", 5], suggested: true },
          { heard: "mane", written: "main", sightings: [] },
          { heard: "mane", sightings: [1] },
        ],
        dismissed: ["a\nb", 3, ""],
      },
      lastRun: RUN,
    });
    expect(state).toEqual({
      settings: {
        modelId: "parakeet-v3",
        onlyMyVoice: true,
        removeFillers: true,
        learnCorrections: true,
      },
      learning: {
        rules: [
          { heard: "cube control", written: "kubectl", source: "learned", addedAt: 7 },
          { heard: "there", written: "their", source: "manual", addedAt: 0 },
        ],
        candidates: [{ heard: "cloud", written: "Claude", sightings: [3, 5], suggested: true }],
        dismissed: ["a\nb"],
      },
      lastRun: null,
    });
  });

  it("returns to Apple when the saved model is not one this build knows", () => {
    expect(
      sanitizeDictationState({ settings: { modelId: "whisper-large" } }).settings.modelId,
    ).toBe("apple");
  });
});

describe("createDictationStore", () => {
  it("replays a change made before the load on top of what was saved", async () => {
    const io = memoryFile(JSON.stringify({ settings: { modelId: "parakeet-v3" } }));
    const store = createDictationStore(io);
    store.update((state) => ({ ...state, settings: { ...state.settings, onlyMyVoice: true } }));
    expect(store.getSnapshot().settings).toMatchObject({ modelId: "apple", onlyMyVoice: true });

    await store.flushed();
    expect(store.getSnapshot().settings).toMatchObject({
      modelId: "parakeet-v3",
      onlyMyVoice: true,
    });
    expect(sanitizeDictationState(JSON.parse(io.file.contents!)).settings).toEqual(
      store.getSnapshot().settings,
    );
  });

  it("writes settings and learning, and never the last run", async () => {
    const io = memoryFile(null);
    const store = createDictationStore(io);
    await store.flushed();
    expect(io.write).not.toHaveBeenCalled();

    store.update((state) => ({ ...state, lastRun: RUN }));
    await store.flushed();
    expect(io.write).not.toHaveBeenCalled();
    expect(store.getSnapshot().lastRun).toEqual(RUN);

    store.update((state) => ({
      ...state,
      settings: { ...state.settings, modelId: "parakeet-110m" },
    }));
    await store.flushed();
    expect(JSON.parse(io.file.contents!)).toEqual({
      settings: { ...DEFAULT_DICTATION_STATE.settings, modelId: "parakeet-110m" },
      learning: DEFAULT_DICTATION_STATE.learning,
    });
  });

  it.each([
    ["a file that cannot be read", () => Promise.reject(new Error("locked"))],
    ["a file that is not JSON", () => Promise.resolve("{ nope")],
  ])("starts from defaults with %s", async (_name, read) => {
    const store = createDictationStore({ read, write: async () => {} });
    await store.ready;
    expect(store.getSnapshot()).toEqual(DEFAULT_DICTATION_STATE);
  });

  it("writes a change again with the next one when its write failed", async () => {
    const io = memoryFile(null);
    io.write.mockRejectedValueOnce(new Error("disk full"));
    const store = createDictationStore(io);
    store.update((state) => ({ ...state, settings: { ...state.settings, onlyMyVoice: true } }));
    await store.flushed();
    expect(io.file.contents).toBeNull();

    store.update((state) => ({ ...state, settings: { ...state.settings, removeFillers: false } }));
    await store.flushed();
    expect(JSON.parse(io.file.contents!).settings).toMatchObject({
      onlyMyVoice: true,
      removeFillers: false,
    });
  });
});
