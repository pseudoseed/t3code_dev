import {
  CLEANUP_MODELS,
  SPEECH_MODELS,
  resolveModelAvailability,
  supportsSpeakerFiltering,
  type VoiceModel,
  type VoiceModelEnvironment,
  type VoiceModelUnavailableReason,
} from "@t3tools/client-runtime/voice-input";

/** What a model row can be doing, in the order a user moves through them. */
export type VoiceModelRowState =
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "downloadable" }
  | { readonly kind: "downloading"; readonly fraction: number | null }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "installed" }
  | { readonly kind: "selected" };

export type VoiceModelRow = {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  /** Empty for models already on the device or provided by iOS. */
  readonly sizeText: string;
  readonly state: VoiceModelRowState;
  readonly canDelete: boolean;
};

export type VoiceModelsSnapshot = {
  readonly environment: VoiceModelEnvironment | null;
  readonly installedModelIds: readonly string[];
  readonly selectedSpeechModelId: string | null;
  readonly selectedCleanupModelId: string | null;
  /** The model currently downloading, with progress when the source reports it. */
  readonly download: { readonly modelId: string; readonly fraction: number | null } | null;
  /** Model id to error message, for downloads and loads that failed. */
  readonly failures: Readonly<Record<string, string>>;
};

/**
 * Bytes as a person reads them.
 *
 * Base 1024, matching what iOS shows for app and download sizes. A model that
 * says 500 MB here and 500 MB in iOS Settings is one fewer thing to doubt.
 */
export function formatModelSize(bytes: number): string {
  if (bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  if (mb < 1_000) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function describeUnavailableReason(reason: VoiceModelUnavailableReason): string {
  switch (reason) {
    case "requires-newer-ios":
      return "Needs a newer iOS";
    case "not-enough-memory":
      return "Not enough memory on this device";
    case "backend-unsupported":
      return "Not supported in this build";
  }
}

function rowFor(
  model: VoiceModel,
  snapshot: VoiceModelsSnapshot,
  selectedId: string | null,
): VoiceModelRow {
  const sizeText = model.delivery.kind === "download" ? formatModelSize(model.delivery.bytes) : "";
  const canDelete =
    model.delivery.kind === "download" && snapshot.installedModelIds.includes(model.id);

  const base = { id: model.id, label: model.label, detail: model.detail, sizeText, canDelete };

  if (!snapshot.environment) {
    return { ...base, state: { kind: "unavailable", reason: "Unavailable on this device" } };
  }

  const availability = resolveModelAvailability(model, snapshot.environment);
  if (!availability.available) {
    return {
      ...base,
      state: { kind: "unavailable", reason: describeUnavailableReason(availability.reason) },
    };
  }

  if (snapshot.download?.modelId === model.id) {
    return { ...base, state: { kind: "downloading", fraction: snapshot.download.fraction } };
  }

  // A failure outranks "not installed". The user pressed download; saying
  // nothing happened is how a dead picker entry gets made.
  const failure = snapshot.failures[model.id];
  if (failure) return { ...base, state: { kind: "failed", message: failure } };

  const installed =
    model.delivery.kind !== "download" || snapshot.installedModelIds.includes(model.id);
  if (!installed) return { ...base, state: { kind: "downloadable" } };

  return { ...base, state: { kind: selectedId === model.id ? "selected" : "installed" } };
}

export function resolveSpeechModelRows(snapshot: VoiceModelsSnapshot): readonly VoiceModelRow[] {
  return SPEECH_MODELS.map((model) => rowFor(model, snapshot, snapshot.selectedSpeechModelId));
}

export function resolveCleanupModelRows(snapshot: VoiceModelsSnapshot): readonly VoiceModelRow[] {
  return CLEANUP_MODELS.map((model) => rowFor(model, snapshot, snapshot.selectedCleanupModelId));
}

export type SpeakerFilteringPresentation = {
  readonly enabled: boolean;
  readonly subtitle: string;
  /** True when the diarizer has to be downloaded before this does anything. */
  readonly needsDiarizer: boolean;
};

/**
 * Whether the speaker filtering toggle can do anything yet.
 *
 * It needs a speech model whose backend can tell voices apart, and the
 * separation model that does the telling. Offering the toggle without either
 * would let the user switch on something that then silently never runs.
 */
export function resolveSpeakerFilteringPresentation(input: {
  readonly selectedSpeechModelId: string | null;
  readonly diarizerInstalled: boolean;
  readonly diarizerSizeText: string;
}): SpeakerFilteringPresentation {
  const model = SPEECH_MODELS.find((candidate) => candidate.id === input.selectedSpeechModelId);

  if (!model || !supportsSpeakerFiltering(model)) {
    const capable = SPEECH_MODELS.filter(supportsSpeakerFiltering)
      .map((candidate) => candidate.label)
      .join(", ");
    return {
      enabled: false,
      subtitle: `Needs a speech model that can tell voices apart: ${capable}.`,
      needsDiarizer: false,
    };
  }

  if (!input.diarizerInstalled) {
    return {
      enabled: false,
      subtitle: `Needs the ${input.diarizerSizeText} voice separation model.`,
      needsDiarizer: true,
    };
  }

  return {
    enabled: true,
    subtitle: "Keeps only the voice that did most of the talking.",
    needsDiarizer: false,
  };
}

/**
 * How much storage downloaded voice models are using.
 *
 * Zero reads as "nothing downloaded" rather than "0 B", because the bundled
 * model lives inside the app and is not what this number counts.
 */
export function formatVoiceStorageUsage(bytes: number): string {
  return bytes > 0 ? formatModelSize(bytes) : "Nothing downloaded";
}
