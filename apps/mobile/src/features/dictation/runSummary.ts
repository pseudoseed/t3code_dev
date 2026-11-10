import { dictationModelName } from "./dictationModels";
import type { DictationFilterReport } from "./dictationNative";
import type { DictationFallback, DictationRun } from "./dictationStore";

const FALLBACK_REASONS: Record<DictationFallback, string> = {
  "not-downloaded": "the chosen model is not downloaded",
  "warming-up": "the chosen model was still loading",
  failed: "the chosen model failed on this recording",
};

const seconds = (value: number) => `${value.toFixed(1)} s`;

function describeFilter(filter: DictationFilterReport): string {
  if (filter.applied) return `Removed ${seconds(filter.droppedSeconds)} of other voices.`;
  switch (filter.skipped) {
    case "onlyYou":
      return "Only your voice was heard.";
    case "noMatch":
      return "Your voice was not recognised, so nothing was removed.";
    case "noProfile":
      return "No voice profile is recorded, so nothing was removed.";
    case "notInstalled":
      return "The voice filter is not downloaded, so nothing was removed.";
    case "tooShort":
      return "The recording was too short to filter.";
    case "noSpeech":
      return "No speech was found to filter.";
    default:
      return "The voice filter left this recording as it was.";
  }
}

/** One line on what the last dictation ran on, for Settings. */
export function describeRun(run: DictationRun): string {
  const engine = dictationModelName(run.engine);
  const timing =
    run.audioSeconds === null
      ? seconds(run.processingSeconds)
      : `${seconds(run.processingSeconds)} for ${seconds(run.audioSeconds)} of audio`;
  const reason = run.fallback === null ? "" : `, because ${FALLBACK_REASONS[run.fallback]}`;
  const filter = run.filter === null ? "" : ` ${describeFilter(run.filter)}`;
  return `${engine}${reason}. Took ${timing}.${filter}`;
}
