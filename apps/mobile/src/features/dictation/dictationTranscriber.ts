import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";

import type { PendingDictations } from "./correctionLearning";
import { nativeErrorMessage } from "./dictationDownloads";
import {
  DICTATION_PROCESSING,
  localDictationModel,
  type DictationModelId,
  type LocalDictationModelId,
} from "./dictationModels";
import type { DictationNativeModule, DictationTranscript } from "./dictationNative";
import type { DictationFallback, DictationRun, DictationStore } from "./dictationStore";
import { applyReplacementRules } from "./replacementRules";
import { removeFillers, usesEnglish } from "./textCleanup";

export interface DictationTranscriberDeps {
  /** Null where the native module is not in the build; only the system recognizer runs then. */
  readonly native: DictationNativeModule | null;
  readonly store: DictationStore;
  readonly getSystemTranscriber: () => Promise<VoiceTranscriber | null>;
  readonly getLocale: () => string;
  readonly now: () => number;
  readonly pending: PendingDictations;
  readonly newRequestId: () => string;
}

const NO_MODEL_MESSAGE = "Download a dictation model in Settings > Microphone.";

const ignore = () => {};

/**
 * Dictation with the model chosen in settings. The system recognizer stands in while a model is
 * missing or still compiling, and takes over a recording the model failed on, so the microphone
 * button never waits on a model.
 */
export function createDictationTranscriber(deps: DictationTranscriberDeps): VoiceTranscriber {
  const { native, store } = deps;

  /** Applies the user's text settings and remembers the result for correction learning. */
  function finish(text: string, locale: string, run: Omit<DictationRun, "at">): string {
    const { settings, learning } = store.getSnapshot();
    let output = text;
    if (settings.removeFillers && usesEnglish(locale)) output = removeFillers(output);
    output = applyReplacementRules(output, learning.rules);
    const at = deps.now();
    if (settings.learnCorrections) deps.pending.note(output, at);
    store.update((state) => ({ ...state, lastRun: { ...run, at } }));
    return output;
  }

  async function prepareSystem(
    options: VoiceTranscriptionOptions,
  ): Promise<PreparedVoiceTranscription | null> {
    const system = await deps.getSystemTranscriber();
    throwIfVoiceTranscriptionAborted(options.signal);
    return system === null ? null : system.prepare(options);
  }

  function viaSystem(
    prepared: PreparedVoiceTranscription,
    fallback: DictationFallback | null,
  ): PreparedVoiceTranscription {
    return {
      locale: prepared.locale,
      async transcribe(uri, options) {
        const started = deps.now();
        const text = await prepared.transcribe(uri, options);
        return finish(text, prepared.locale, {
          engine: "apple",
          fallback,
          audioSeconds: null,
          processingSeconds: (deps.now() - started) / 1000,
          filter: null,
        });
      },
    };
  }

  function viaModel(
    module: DictationNativeModule,
    modelId: LocalDictationModelId,
    locale: string,
  ): PreparedVoiceTranscription {
    return {
      locale,
      async transcribe(uri, options) {
        const { signal } = options;
        throwIfVoiceTranscriptionAborted(signal);
        const requestId = deps.newRequestId();
        const cancel = () => void module.cancelTranscription(requestId).catch(ignore);
        signal.addEventListener("abort", cancel);
        let transcript: DictationTranscript;
        try {
          transcript = await module.transcribe(
            requestId,
            uri,
            modelId,
            DICTATION_PROCESSING,
            store.getSnapshot().settings.onlyMyVoice,
            locale,
          );
        } catch (cause) {
          throwIfVoiceTranscriptionAborted(signal);
          const failure = new VoiceTranscriptionError({
            code: "transcription-failed",
            message: nativeErrorMessage(cause, "Dictation failed."),
            cause,
          });
          const system = await prepareSystem(options).catch(() => null);
          throwIfVoiceTranscriptionAborted(signal);
          if (system === null) throw failure;
          return viaSystem(system, "failed").transcribe(uri, options);
        } finally {
          signal.removeEventListener("abort", cancel);
        }
        throwIfVoiceTranscriptionAborted(signal);
        return finish(transcript.text, locale, {
          engine: modelId,
          fallback: null,
          audioSeconds: transcript.audioSeconds,
          processingSeconds: transcript.processingSeconds,
          filter: transcript.filter,
        });
      },
    };
  }

  async function standIn(
    options: VoiceTranscriptionOptions,
  ): Promise<PreparedVoiceTranscription | null> {
    try {
      return await prepareSystem(options);
    } catch {
      throwIfVoiceTranscriptionAborted(options.signal);
      // A system recognizer that cannot take this language is no stand-in at all.
      return null;
    }
  }

  return {
    async prepare(options) {
      throwIfVoiceTranscriptionAborted(options.signal);
      await store.ready;
      throwIfVoiceTranscriptionAborted(options.signal);
      const modelId: DictationModelId = store.getSnapshot().settings.modelId;

      if (modelId === "apple" || native === null) {
        const system = await prepareSystem(options);
        if (system === null) {
          throw new VoiceTranscriptionError({ code: "unavailable", message: NO_MODEL_MESSAGE });
        }
        return viaSystem(system, null);
      }

      const status = await native.modelStatus(modelId, DICTATION_PROCESSING).catch(() => null);
      throwIfVoiceTranscriptionAborted(options.signal);
      const deviceLocale = deps.getLocale();
      const locale =
        localDictationModel(modelId).englishOnly && !usesEnglish(deviceLocale)
          ? "en-US"
          : deviceLocale;
      if (status?.installed === true) {
        let loadFailed = false;
        // Not awaited: recording starts now and the model loads while the user talks.
        void native.prepare(modelId, DICTATION_PROCESSING).catch(() => {
          loadFailed = true;
        });
        const model = viaModel(native, modelId, locale);
        if (status.warm) return model;
        // The first load after an install or an update compiles the model, which can take a minute.
        const system = await standIn(options);
        if (system === null) return model;
        return {
          locale,
          // The model had the length of the recording to load. The stand-in takes over only if
          // that was not enough.
          async transcribe(uri, transcribeOptions) {
            const loaded = await native.modelStatus(modelId, DICTATION_PROCESSING).then(
              (current) => current.warm,
              () => false,
            );
            if (loaded) return model.transcribe(uri, transcribeOptions);
            return viaSystem(system, loadFailed ? "failed" : "warming-up").transcribe(
              uri,
              transcribeOptions,
            );
          },
        };
      }
      const system = await standIn(options);
      if (system === null) {
        throw new VoiceTranscriptionError({ code: "unavailable", message: NO_MODEL_MESSAGE });
      }
      return viaSystem(system, status === null ? "failed" : "not-downloaded");
    },
  };
}
