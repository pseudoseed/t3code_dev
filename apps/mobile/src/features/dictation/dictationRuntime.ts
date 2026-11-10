import { useSyncExternalStore } from "react";

import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";

import { writeFileAtomically } from "../../lib/atomic-file";
import { learnFromPairs, PendingDictations, type LearningState } from "./correctionLearning";
import { createDictationDownloads, type DictationDownloads } from "./dictationDownloads";
import { dictationNative } from "./dictationNative";
import {
  createDictationStore,
  type DictationSettings,
  type DictationState,
  type DictationStore,
} from "./dictationStore";
import { createDictationTranscriber } from "./dictationTranscriber";

async function dictationFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.document, "dictation.json");
}

interface DictationRuntime {
  readonly store: DictationStore;
  readonly pending: PendingDictations;
}

let runtime: DictationRuntime | null = null;
let downloads: DictationDownloads | null = null;
let requests = 0;

/** One store per app run: the transcriber is rebuilt on every foreground, its state is not. */
function dictationRuntime(): DictationRuntime {
  runtime ??= {
    store: createDictationStore({
      read: async () => {
        const file = await dictationFile();
        return file.exists ? file.text() : null;
      },
      write: async (contents) => writeFileAtomically(await dictationFile(), contents),
    }),
    pending: new PendingDictations(),
  };
  return runtime;
}

export function deviceLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

export function makeDictationTranscriber(
  getSystemTranscriber: () => Promise<VoiceTranscriber | null>,
): VoiceTranscriber {
  const { store, pending } = dictationRuntime();
  return createDictationTranscriber({
    native: dictationNative,
    store,
    pending,
    getSystemTranscriber,
    getLocale: deviceLocale,
    now: Date.now,
    newRequestId: () => `dictation-${Date.now()}-${++requests}`,
  });
}

/** Null where the native module is not in the build. */
export function dictationDownloads(): DictationDownloads | null {
  if (dictationNative === null) return null;
  downloads ??= createDictationDownloads(dictationNative);
  return downloads;
}

export function useDictationState(): DictationState {
  const { store } = dictationRuntime();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export function currentDictationSettings(): DictationSettings {
  return dictationRuntime().store.getSnapshot().settings;
}

export function updateDictationSettings(change: Partial<DictationSettings>): void {
  if (change.learnCorrections === false) dictationRuntime().pending.clear();
  dictationRuntime().store.update((state) => ({
    ...state,
    settings: { ...state.settings, ...change },
  }));
}

export function updateDictationLearning(change: (learning: LearningState) => LearningState): void {
  dictationRuntime().store.update((state) => ({ ...state, learning: change(state.learning) }));
}

/** Compares a sent message with the dictations that went into it and learns from the edits. */
export function noteMessageSent(text: string): void {
  if (runtime === null) return;
  const now = Date.now();
  const pairs = runtime.pending.resolve(text, now);
  if (pairs.length === 0) return;
  runtime.store.update((state) =>
    state.settings.learnCorrections
      ? { ...state, learning: learnFromPairs(state.learning, pairs, now) }
      : state,
  );
}
