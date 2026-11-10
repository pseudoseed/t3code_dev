import type { CorrectionCandidate, LearningState } from "./correctionLearning";
import { isDictationModelId, type DictationModelId } from "./dictationModels";
import type { DictationFilterReport } from "./dictationNative";
import type { ReplacementRule } from "./replacementRules";

export interface DictationSettings {
  readonly modelId: DictationModelId;
  readonly onlyMyVoice: boolean;
  readonly removeFillers: boolean;
  readonly learnCorrections: boolean;
}

export type DictationFallback = "not-downloaded" | "warming-up" | "failed";

/** What the last dictation ran on. Kept in memory only. */
export interface DictationRun {
  readonly at: number;
  readonly engine: DictationModelId;
  readonly fallback: DictationFallback | null;
  readonly audioSeconds: number | null;
  readonly processingSeconds: number;
  readonly filter: DictationFilterReport | null;
}

export interface DictationState {
  readonly settings: DictationSettings;
  readonly learning: LearningState;
  readonly lastRun: DictationRun | null;
}

export const DEFAULT_DICTATION_STATE: DictationState = {
  settings: { modelId: "apple", onlyMyVoice: false, removeFillers: true, learnCorrections: true },
  learning: { rules: [], candidates: [], dismissed: [] },
  lastRun: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
const time = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const list = (value: unknown) => (Array.isArray(value) ? (value as ReadonlyArray<unknown>) : []);

/** Rebuilds the state from whatever was on disk, keeping every entry that is still well formed. */
export function sanitizeDictationState(raw: unknown): DictationState {
  const root = isRecord(raw) ? raw : {};
  const settings = isRecord(root.settings) ? root.settings : {};
  const learning = isRecord(root.learning) ? root.learning : {};
  const defaults = DEFAULT_DICTATION_STATE.settings;

  const rules = list(learning.rules).flatMap((entry): ReplacementRule[] => {
    if (!isRecord(entry)) return [];
    const heard = text(entry.heard);
    const written = text(entry.written);
    if (heard === null || written === null) return [];
    return [
      {
        heard,
        written,
        source: entry.source === "learned" ? "learned" : "manual",
        addedAt: time(entry.addedAt) ?? 0,
      },
    ];
  });
  const candidates = list(learning.candidates).flatMap((entry): CorrectionCandidate[] => {
    if (!isRecord(entry)) return [];
    const heard = text(entry.heard);
    const written = text(entry.written);
    const sightings = list(entry.sightings).flatMap((at) => time(at) ?? []);
    if (heard === null || written === null || sightings.length === 0) return [];
    return [{ heard, written, sightings, suggested: entry.suggested === true }];
  });

  return {
    settings: {
      modelId: isDictationModelId(settings.modelId) ? settings.modelId : defaults.modelId,
      onlyMyVoice: flag(settings.onlyMyVoice, defaults.onlyMyVoice),
      removeFillers: flag(settings.removeFillers, defaults.removeFillers),
      learnCorrections: flag(settings.learnCorrections, defaults.learnCorrections),
    },
    learning: {
      rules,
      candidates,
      dismissed: list(learning.dismissed).flatMap((key) => text(key) ?? []),
    },
    lastRun: null,
  };
}

export interface DictationStore {
  /** Settles once the saved state is loaded. Never rejects: an unreadable file means defaults. */
  readonly ready: Promise<void>;
  getSnapshot(): DictationState;
  subscribe(listener: () => void): () => void;
  update(change: (state: DictationState) => DictationState): void;
  /** Settles when every change so far is on disk. */
  flushed(): Promise<void>;
}

export function createDictationStore(io: {
  readonly read: () => Promise<string | null>;
  readonly write: (contents: string) => Promise<void>;
}): DictationStore {
  let state = DEFAULT_DICTATION_STATE;
  let loaded = false;
  let saved: DictationState | null = null;
  let writing: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();

  const publish = (next: DictationState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  // Changes made before the load finishes are replayed on top of what was saved.
  const early: Array<(state: DictationState) => DictationState> = [];
  const ready = io
    .read()
    .then(
      (contents) => (contents === null ? null : (JSON.parse(contents) as unknown)),
      () => null,
    )
    .catch(() => null)
    .then((raw) => {
      loaded = true;
      saved = sanitizeDictationState(raw);
      publish(early.reduce((current, change) => change(current), saved));
      persist();
    });

  function persist() {
    writing = writing.then(async () => {
      const snapshot = state;
      if (
        saved !== null &&
        saved.settings === snapshot.settings &&
        saved.learning === snapshot.learning
      ) {
        return;
      }
      try {
        await io.write(
          JSON.stringify({ settings: snapshot.settings, learning: snapshot.learning }),
        );
        saved = snapshot;
      } catch {
        // The change stays in memory and goes out with the next write.
      }
    });
  }

  return {
    ready,
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(change) {
      if (!loaded) early.push(change);
      const next = change(state);
      if (next === state) return;
      publish(next);
      if (loaded) persist();
    },
    flushed: () => ready.then(() => writing),
  };
}
