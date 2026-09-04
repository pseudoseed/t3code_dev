import {
  DEFAULT_CLEANUP_PROMPT,
  buildCleanupPrompt,
  mergeCorrectionPairs,
  parseCorrectionPairs,
  parsePreferredSpellings,
} from "@t3tools/client-runtime/voice-input";

import type { Preferences } from "../../persistence/mobile-preferences";
import type { LocalVoiceCleanupSettings } from "../../native/voiceCleanup";
import type { LocalVoiceTranscriptionSettings } from "../../native/voiceTranscription";

/**
 * Turns the stored preferences into what the cleanup stage needs.
 *
 * The prompt is composed here rather than natively so the correction hints and
 * the user's own prompt stay one testable string, and so switching cleanup
 * models needs no prompt changes.
 *
 * Cleanup defaults to off. No cleanup model ships inside the app, so on a fresh
 * install there is nothing to run and a default of on would mean the first
 * dictation silently waits for a download the user never asked for.
 */
export function resolveVoiceCleanupSettings(preferences: Preferences): LocalVoiceCleanupSettings {
  return {
    enabled: preferences.voiceCleanupEnabled ?? false,
    modelId: preferences.voiceCleanupModelId ?? null,
    systemPrompt: buildCleanupPrompt({
      basePrompt: preferences.voiceCleanupPrompt ?? DEFAULT_CLEANUP_PROMPT,
      corrections: {
        preferredSpellings: parsePreferredSpellings(
          preferences.voiceCleanupPreferredSpellings ?? "",
        ),
        // Typed mappings win over learned ones: a user who wrote a rule by hand
        // has said what they want more clearly than an inferred edit.
        pairs: mergeCorrectionPairs(
          parseCorrectionPairs(preferences.voiceCleanupCorrections ?? ""),
          preferences.voiceLearnedCorrections ?? [],
        ),
      },
    }),
  };
}

/**
 * Which speech model to use and whether to filter other voices out.
 *
 * Both default to unset rather than to a value, so the device picks the model
 * on every launch and a device that grows a better option starts using it.
 */
export function resolveVoiceTranscriptionSettings(
  preferences: Preferences,
): LocalVoiceTranscriptionSettings {
  return {
    speechModelId: preferences.voiceSpeechModelId ?? null,
    speakerFiltering: preferences.voiceSpeakerFilteringEnabled ?? false,
  };
}

/**
 * The transcript to offer back after a relaunch, or null.
 *
 * Matched on owner alone. Revisions only count within one process, so after a
 * restart the only honest question is whether this is the same draft, and a
 * transcript already sitting in the draft is one the user got before the crash.
 *
 * `sessionStartedAt` is what keeps this from firing on a dictation still in
 * flight: the record is written before cleanup starts, so without it the app
 * would offer back text it is about to insert normally a second later.
 */
export function resolveRecoverableTranscript(
  preferences: Preferences,
  draft: { readonly ownerKey: string | null; readonly text: string },
  sessionStartedAt: number,
): string | null {
  const pending = preferences.voicePendingTranscript;
  if (!pending || !draft.ownerKey || pending.ownerKey !== draft.ownerKey) return null;
  if (pending.capturedAt >= sessionStartedAt) return null;

  const text = pending.text.trim();
  if (text.length === 0) return null;
  if (draft.text.includes(text)) return null;

  return text;
}
