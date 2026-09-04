import AppleTranscription from "@react-native-ai/apple/src/NativeAppleTranscription";
import { File } from "expo-file-system";

import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
  type VoiceTranscriptionResult,
  APPLE_SPEECH_MODEL_ID,
  BUNDLED_SPEECH_MODEL_ID,
  SPEECH_MODELS,
  resolveDefaultSpeechModelId,
  resolveModelAvailability,
  supportsSpeakerFiltering,
} from "@t3tools/client-runtime/voice-input";

import { DIARIZER_MODEL_ID, getInstalledModelIds, readVoiceModelEnvironment } from "./t3Voice";
import { getLocalModelVoiceTranscriber } from "./localModelTranscription.ios";
import type { LocalVoiceTranscriptionSettings } from "./voiceTranscription";
import type { VoiceModelEnvironment } from "@t3tools/client-runtime/voice-input";

export type { LocalVoiceTranscriptionSettings } from "./voiceTranscription";

/**
 * What this whole app can run, not just what the t3-voice module implements.
 *
 * Apple's recognizer comes from its own binding, so the module cannot report
 * it. Anything deciding whether a model is offered has to ask here, or Apple
 * reads as unsupported on the devices that do support it.
 */
export function readVoiceModelEnvironmentForApp(): VoiceModelEnvironment | null {
  const moduleEnvironment = readVoiceModelEnvironment();
  if (!moduleEnvironment) return null;
  if (!AppleTranscription.isAvailable(getDeviceLocale())) return moduleEnvironment;

  return {
    ...moduleEnvironment,
    supportedBackends: [...moduleEnvironment.supportedBackends, "appleSpeechAnalyzer"],
  };
}

function getDeviceLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

function wrapError(
  code: "preparation-failed" | "transcription-failed",
  message: string,
  cause: unknown,
): VoiceTranscriptionError {
  if (cause instanceof VoiceTranscriptionError) {
    return cause;
  }

  return new VoiceTranscriptionError(code, message, { cause });
}

function getNativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Picks the speech model for this device.
 *
 * The user's own choice wins whenever it is installed and this device can still
 * run it. Otherwise Apple's recognizer, because it costs no download and no
 * resident memory; and below iOS 26, or in a language Apple does not cover, the
 * bundled model, which is the only one guaranteed present offline on first
 * launch. Returning null means none of them is usable, and the composer shows a
 * setup affordance rather than a microphone that does nothing.
 */
export function getLocalVoiceTranscriber(
  settings: LocalVoiceTranscriptionSettings,
): VoiceTranscriber | null {
  const locale = getDeviceLocale();
  const localeSupportedByApple = AppleTranscription.isAvailable(locale);
  const moduleEnvironment = readVoiceModelEnvironment();
  if (!moduleEnvironment) {
    return getAppleVoiceTranscriber(locale);
  }

  const environment = readVoiceModelEnvironmentForApp() ?? moduleEnvironment;

  const modelId =
    resolveSelectedSpeechModelId(settings.speechModelId, environment) ??
    resolveDefaultSpeechModelId(environment, { localeSupportedByApple });

  if (modelId === APPLE_SPEECH_MODEL_ID) {
    return getAppleVoiceTranscriber(locale);
  }

  if (modelId === null) return getAppleVoiceTranscriber(locale);

  const model = SPEECH_MODELS.find((candidate) => candidate.id === modelId);
  // An English-only model transcribes as English even on a device set to
  // another language. Saying so keeps the controller's word-boundary spacing
  // correct instead of guessing from the device locale.
  const modelLocale = model?.languages === "englishOnly" ? "en" : locale;

  const bundled = getBundledVoiceTranscriber();
  const selected = getLocalModelVoiceTranscriber({
    modelId,
    locale: modelLocale,
    speakerFiltering: canFilterSpeakers(model, settings.speakerFiltering),
  });

  // A model the user picked and then deleted falls back rather than leaving the
  // microphone broken. Their saved choice is left alone either way.
  if (!selected) return bundled ?? getAppleVoiceTranscriber(locale);
  if (!bundled || modelId === BUNDLED_SPEECH_MODEL_ID) return selected;

  return withBundledFallback(selected, bundled, model?.label ?? "That speech model");
}

function getBundledVoiceTranscriber(): VoiceTranscriber | null {
  return getLocalModelVoiceTranscriber({
    modelId: BUNDLED_SPEECH_MODEL_ID,
    locale: "en",
    speakerFiltering: false,
  });
}

/**
 * Uses the built-in model when the chosen one will not load.
 *
 * Gating passes on a memory reading taken when the picker rendered, and the
 * real budget at load time is a different number. Losing a dictation to that
 * gap would be the worst outcome, so this substitutes, says so once, and leaves
 * the user's saved choice alone: the next dictation tries their model again.
 */
function withBundledFallback(
  selected: VoiceTranscriber,
  bundled: VoiceTranscriber,
  label: string,
): VoiceTranscriber {
  return {
    prepare: async (options) => {
      try {
        return await selected.prepare(options);
      } catch (error) {
        if (error instanceof VoiceTranscriptionError && error.code === "cancelled") throw error;

        const fallback = await bundled.prepare(options);
        const notice = `${label} could not be loaded, so the built-in model was used.`;
        return {
          ...fallback,
          transcribe: async (uri, transcribeOptions) => ({
            ...(await fallback.transcribe(uri, transcribeOptions)),
            notice,
          }),
        };
      }
    },
  };
}

/** The user's saved choice, or null when it no longer runs here. */
function resolveSelectedSpeechModelId(
  selectedId: string | null,
  environment: ReturnType<typeof readVoiceModelEnvironment>,
): string | null {
  if (!selectedId || !environment) return null;
  const model = SPEECH_MODELS.find((candidate) => candidate.id === selectedId);
  if (!model) return null;
  return resolveModelAvailability(model, environment).available ? selectedId : null;
}

/**
 * Filtering needs a model whose backend diarizes and the diarizer itself.
 *
 * Asking for it without the diarizer installed would transcribe unfiltered and
 * report a fallback the user cannot act on, so it is simply off until the
 * download lands.
 */
function canFilterSpeakers(
  model: (typeof SPEECH_MODELS)[number] | undefined,
  requested: boolean,
): boolean {
  if (!requested || !model || !supportsSpeakerFiltering(model)) return false;
  return getInstalledModelIds().includes(DIARIZER_MODEL_ID);
}

function getAppleVoiceTranscriber(locale: string): VoiceTranscriber | null {
  if (!AppleTranscription.isAvailable(locale)) return null;
  return { prepare: (options) => prepareVoiceTranscription(locale, options) };
}

async function prepareVoiceTranscription(
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<PreparedVoiceTranscription> {
  throwIfVoiceTranscriptionAborted(signal);
  if (!AppleTranscription.isAvailable(locale)) {
    throw new VoiceTranscriptionError(
      "unavailable",
      "Voice transcription requires a supported device with iOS 26 or later.",
    );
  }

  try {
    const supportedLocale = await AppleTranscription.prepare(locale);
    throwIfVoiceTranscriptionAborted(signal);
    return {
      locale: supportedLocale,
      transcribe: (uri, options) => transcribeVoiceRecording(uri, supportedLocale, options),
    };
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    if (getNativeErrorCode(error) === "AppleTranscriptionUnsupportedLocale") {
      throw new VoiceTranscriptionError(
        "unsupported-locale",
        "Voice transcription does not support this device language.",
        { cause: error },
      );
    }

    throw wrapError(
      "preparation-failed",
      "Voice transcription could not prepare this language.",
      error,
    );
  }
}

async function transcribeVoiceRecording(
  uri: string,
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<VoiceTranscriptionResult> {
  try {
    throwIfVoiceTranscriptionAborted(signal);
    const audio = await new File(uri).arrayBuffer();
    throwIfVoiceTranscriptionAborted(signal);
    const result = await AppleTranscription.transcribe(audio, locale);
    throwIfVoiceTranscriptionAborted(signal);
    // Apple's recognizer cannot tell voices apart, so it reports no speaker
    // filtering rather than reporting that filtering failed.
    return {
      text: result.segments
        .map((segment) => segment.text)
        .join(" ")
        .trim(),
    };
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw wrapError("transcription-failed", "Voice transcription failed.", error);
  }
}
