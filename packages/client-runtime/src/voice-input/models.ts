/**
 * The catalog of on-device speech and cleanup models, and the rules deciding
 * which of them a device can actually run.
 *
 * Everything here is pure. The native module owns downloads, loading, and
 * inference; this owns what the user is allowed to pick and why.
 */

export type VoiceModelBackend =
  | "appleSpeechAnalyzer"
  | "whisperKit"
  | "fluidAudio"
  | "mlxAudio"
  | "llamaCpp";

export type VoiceModelKind = "speech" | "cleanup";

/** How a model gets onto the device. */
export type VoiceModelDelivery =
  /** Shipped inside the app binary. Present on first launch, offline. */
  | { readonly kind: "bundled" }
  /** Downloaded by us from an immutable URL and checksummed. */
  | { readonly kind: "download"; readonly bytes: number }
  /** Provided by iOS. Apple may fetch assets on first use; we cannot bundle it. */
  | { readonly kind: "system" };

export type VoiceModel = {
  readonly id: string;
  readonly kind: VoiceModelKind;
  readonly label: string;
  readonly detail: string;
  readonly backend: VoiceModelBackend;
  readonly delivery: VoiceModelDelivery;
  /** Minimum iOS major version. `undefined` means the app's deployment target. */
  readonly minimumIosMajorVersion?: number;
  /** `null` means the model auto-detects and resolves a locale at prepare time. */
  readonly languages: "englishOnly" | null;
  /**
   * Peak bytes iOS charges this process for holding and running the model.
   *
   * Derived from footprint measurements taken around a real load and a real
   * transcription, per backend rather than per model, because the cost tracks
   * how the runtime allocates weights and not which model it is. See the two
   * multipliers below for what was measured and what margin sits on top.
   */
  readonly peakMemoryBytes: number;
};

const MB = 1024 * 1024;

/**
 * What a GGUF costs to hold and run, as a multiple of its file size.
 *
 * Measured: Qwen 3.5 0.8B is a 508 MB file and cost 703 MB to load plus 27 MB
 * to run, so 1.44x. llama.cpp reads the weights into ordinary allocated memory,
 * which iOS charges in full, and this transfers to a device because the
 * allocation is the same either way.
 */
const GGUF_MEMORY_MULTIPLIER = 1.5;

/**
 * What a CoreML model costs, as a multiple of the bytes it downloads.
 *
 * Measured: Parakeet v3 is a 461 MB download and cost 227 MB to load plus 5 MB
 * to run, so 0.5x. CoreML maps most of a `.mlmodelc` from disk rather than
 * allocating it, and iOS does not charge for clean file-backed pages.
 *
 * Kept at 1.0 rather than the measured 0.5. The measurement is from the
 * Simulator, where CoreML runs on the CPU; a device puts these on the Neural
 * Engine, which is charged differently and has not been measured. Doubling the
 * measured figure is the margin, and it comes out of the plan's exit condition
 * only once a device confirms it.
 */
const COREML_MEMORY_MULTIPLIER = 1.0;

const ggufPeak = (bytes: number) => Math.round(bytes * GGUF_MEMORY_MULTIPLIER);
const coreMlPeak = (bytes: number) => Math.round(bytes * COREML_MEMORY_MULTIPLIER);

/** Speaker filtering rides on the diarizer, so any FluidAudio model can do it. */
export function supportsSpeakerFiltering(model: VoiceModel): boolean {
  return model.backend === "fluidAudio";
}

export const SPEECH_MODELS: readonly VoiceModel[] = [
  {
    id: "apple-speech-analyzer",
    kind: "speech",
    label: "Apple",
    detail: "Built into iOS 26",
    backend: "appleSpeechAnalyzer",
    delivery: { kind: "system" },
    minimumIosMajorVersion: 26,
    languages: null,
    // Out of process. Apple's own daemon holds the model, not us.
    peakMemoryBytes: 0,
  },
  {
    id: "whisper-tiny-en",
    kind: "speech",
    label: "Fast",
    detail: "Whisper tiny, English",
    backend: "whisperKit",
    delivery: { kind: "bundled" },
    languages: "englishOnly",
    peakMemoryBytes: coreMlPeak(75 * MB),
  },
  {
    id: "whisper-small-en",
    kind: "speech",
    label: "Accurate",
    detail: "Whisper small, English",
    backend: "whisperKit",
    delivery: { kind: "download", bytes: 467 * MB },
    languages: "englishOnly",
    peakMemoryBytes: coreMlPeak(467 * MB),
  },
  {
    id: "whisper-small",
    kind: "speech",
    label: "Accurate, multilingual",
    detail: "Whisper small",
    backend: "whisperKit",
    delivery: { kind: "download", bytes: 467 * MB },
    languages: null,
    peakMemoryBytes: coreMlPeak(467 * MB),
  },
  {
    id: "parakeet-v3",
    kind: "speech",
    label: "Parakeet v3",
    detail: "25 languages, filters out other voices",
    backend: "fluidAudio",
    delivery: { kind: "download", bytes: 461 * MB },
    languages: null,
    peakMemoryBytes: coreMlPeak(461 * MB),
  },
  {
    id: "nemotron-streaming-en",
    kind: "speech",
    label: "Streaming, English",
    detail: "Nemotron 0.6B, low latency",
    backend: "mlxAudio",
    delivery: { kind: "download", bytes: 633 * MB },
    languages: "englishOnly",
    peakMemoryBytes: coreMlPeak(633 * MB),
  },
  {
    id: "nemotron-streaming-multilingual",
    kind: "speech",
    label: "Streaming, multilingual",
    detail: "Nemotron 3.5 ASR 0.6B, low latency",
    backend: "mlxAudio",
    delivery: { kind: "download", bytes: 721 * MB },
    languages: null,
    peakMemoryBytes: coreMlPeak(721 * MB),
  },
];

export const CLEANUP_MODELS: readonly VoiceModel[] = [
  {
    id: "qwen-0-8b",
    kind: "cleanup",
    label: "Fast",
    detail: "Qwen 3.5 0.8B",
    backend: "llamaCpp",
    delivery: { kind: "download", bytes: 508 * MB },
    languages: null,
    peakMemoryBytes: ggufPeak(508 * MB),
  },
  {
    id: "qwen-2b",
    kind: "cleanup",
    label: "Balanced",
    detail: "Qwen 3.5 2B",
    backend: "llamaCpp",
    delivery: { kind: "download", bytes: 1222 * MB },
    languages: null,
    peakMemoryBytes: ggufPeak(1222 * MB),
  },
  {
    id: "qwen-4b",
    kind: "cleanup",
    label: "Best quality",
    detail: "Qwen 3.5 4B",
    backend: "llamaCpp",
    delivery: { kind: "download", bytes: 2614 * MB },
    languages: null,
    peakMemoryBytes: ggufPeak(2614 * MB),
  },
];

export const BUNDLED_SPEECH_MODEL_ID = "whisper-tiny-en";
export const APPLE_SPEECH_MODEL_ID = "apple-speech-analyzer";

export type VoiceModelUnavailableReason =
  | "requires-newer-ios"
  | "not-enough-memory"
  | "backend-unsupported";

export type VoiceModelAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: VoiceModelUnavailableReason };

export type VoiceModelEnvironment = {
  readonly iosMajorVersion: number;
  /** Bytes iOS will still hand this process. Read fresh; it moves constantly. */
  readonly availableMemoryBytes: number;
  /** Backends the installed native binary actually implements. */
  readonly supportedBackends: readonly VoiceModelBackend[];
};

/**
 * Why a model is offered or refused.
 *
 * An unavailable model is shown disabled with this reason, never hidden. A
 * device that is merely small should look small, not broken.
 */
export function resolveModelAvailability(
  model: VoiceModel,
  environment: VoiceModelEnvironment,
): VoiceModelAvailability {
  if (!environment.supportedBackends.includes(model.backend)) {
    return { available: false, reason: "backend-unsupported" };
  }

  if (
    model.minimumIosMajorVersion !== undefined &&
    environment.iosMajorVersion < model.minimumIosMajorVersion
  ) {
    return { available: false, reason: "requires-newer-ios" };
  }

  if (model.peakMemoryBytes > environment.availableMemoryBytes) {
    return { available: false, reason: "not-enough-memory" };
  }

  return { available: true };
}

/**
 * The speech model to select when the user has never chosen one.
 *
 * Apple's recognizer is preferred where it exists because it costs no download
 * and no resident memory, but it needs iOS 26 and it only covers the locales
 * Apple supports. Everywhere else the bundled model wins: it is the only option
 * guaranteed to work offline on first launch.
 *
 * Returns `null` only when even the bundled model is refused, which means the
 * composer shows a setup affordance rather than a microphone that does nothing.
 */
export function resolveDefaultSpeechModelId(
  environment: VoiceModelEnvironment,
  options: { readonly localeSupportedByApple: boolean },
): string | null {
  const byId = new Map(SPEECH_MODELS.map((model) => [model.id, model]));

  const apple = byId.get(APPLE_SPEECH_MODEL_ID);
  if (
    options.localeSupportedByApple &&
    apple &&
    resolveModelAvailability(apple, environment).available
  ) {
    return APPLE_SPEECH_MODEL_ID;
  }

  const bundled = byId.get(BUNDLED_SPEECH_MODEL_ID);
  if (bundled && resolveModelAvailability(bundled, environment).available) {
    return BUNDLED_SPEECH_MODEL_ID;
  }

  return null;
}
