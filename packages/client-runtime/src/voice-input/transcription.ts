/** Cancellation is cooperative: settle only after the underlying work has stopped. */
export type VoiceTranscriptionOptions = {
  readonly signal: AbortSignal;
};

/**
 * Why a dictation was transcribed unfiltered even though speaker filtering was
 * switched on.
 *
 * `singleSpeaker` is not a failure. There was one voice, so nothing was dropped
 * and there is nothing to tell the user.
 */
export type SpeakerFilterFallbackReason =
  | "singleSpeaker"
  | "noSpeech"
  | "ambiguousDominantSpeaker"
  | "keptAudioTooShort";

export type SpeakerFilteringOutcome = {
  readonly requested: boolean;
  readonly applied: boolean;
  readonly fallbackReason: SpeakerFilterFallbackReason | null;
};

export type VoiceTranscriptionResult = {
  readonly text: string;
  /** Absent from backends that cannot filter by speaker at all. */
  readonly speakerFiltering?: SpeakerFilteringOutcome;
  /**
   * Something the user should know that is not a failure, such as a model that
   * could not be loaded and was substituted. Overrides the speaker-filtering
   * disclosure, since a substituted model is the more surprising fact.
   */
  readonly notice?: string;
};

/**
 * What the composer says when filtering was asked for and did not happen.
 *
 * Null means say nothing: either filtering ran, or it was never on, or the
 * reason is one the user does not need to hear about. Everything else is a
 * transcript that may contain a voice the user did not want, and staying quiet
 * about that is worse than not offering the feature.
 */
export function resolveSpeakerFilteringNotice(
  outcome: SpeakerFilteringOutcome | undefined,
): string | null {
  if (!outcome?.requested || outcome.applied) return null;

  switch (outcome.fallbackReason) {
    case "ambiguousDominantSpeaker":
      return "More than one voice was speaking, so the whole recording was transcribed.";
    case "keptAudioTooShort":
      return "Too little of the recording was yours to use on its own, so all of it was transcribed.";
    case "noSpeech":
      return "No speech was found to separate, so the whole recording was transcribed.";
    default:
      return null;
  }
}

/** Binds a recording to its selected implementation and resolved locale. */
export type PreparedVoiceTranscription = {
  readonly locale: string;
  readonly transcribe: (
    uri: string,
    options: VoiceTranscriptionOptions,
  ) => Promise<VoiceTranscriptionResult>;
};

export type VoiceTranscriber = {
  readonly prepare: (options: VoiceTranscriptionOptions) => Promise<PreparedVoiceTranscription>;
};

export type VoiceTranscriptionErrorCode =
  | "unavailable"
  | "unsupported-locale"
  | "preparation-failed"
  | "transcription-failed"
  | "cancelled";

export class VoiceTranscriptionError extends Error {
  readonly code: VoiceTranscriptionErrorCode;

  constructor(code: VoiceTranscriptionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VoiceTranscriptionError";
    this.code = code;
  }
}

export function throwIfVoiceTranscriptionAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.");
  }
}
