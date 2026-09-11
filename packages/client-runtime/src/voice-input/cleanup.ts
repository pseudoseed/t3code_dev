/**
 * The second stage of dictation: an on-device language model rewriting a raw
 * transcript into text a person would have typed.
 *
 * Cleanup sits beside transcription rather than inside it. It is toggleable,
 * it selects its own model, and it must be skippable without touching the
 * transcription path, so the two contracts stay separate.
 *
 * Everything here is pure. The native module owns the model.
 */

import type { VoiceTranscriptionOptions } from "./transcription.ts";

/**
 * One rewrite, and whether the model reached the end of it.
 *
 * `complete` is false when generation stopped at the output cap or the timeout
 * instead of at the model's own end of turn. The text that comes back then is a
 * rewrite of everything up to wherever it stopped, so what is missing is always
 * the end of what the user said.
 */
export type VoiceCleanupResult = {
  readonly text: string;
  readonly complete: boolean;
};

/** Binds a loaded cleanup model to the call that rewrites one transcript. */
export type PreparedVoiceCleanup = {
  readonly clean: (
    transcript: string,
    options: VoiceTranscriptionOptions,
  ) => Promise<VoiceCleanupResult>;
};

export type VoiceCleanup = {
  readonly prepare: (options: VoiceTranscriptionOptions) => Promise<PreparedVoiceCleanup>;
};

/**
 * A word the user spells a particular way, preserved verbatim.
 *
 * Dictation of code is full of these. A model that has never seen a project's
 * name will confidently produce a real English word instead of it.
 */
export type PreferredSpelling = string;

/** One `wrong -> right` mapping, either typed by the user or learned. */
export type CorrectionPair = {
  readonly wrong: string;
  readonly right: string;
};

export type VoiceCorrections = {
  readonly preferredSpellings: readonly PreferredSpelling[];
  readonly pairs: readonly CorrectionPair[];
};

export const EMPTY_VOICE_CORRECTIONS: VoiceCorrections = {
  preferredSpellings: [],
  pairs: [],
};

export const DEFAULT_CLEANUP_PROMPT = [
  "You are cleaning up a voice transcript so it reads as written text.",
  "",
  "Fix punctuation, capitalization, and obvious mishearings.",
  "Remove filler words and false starts.",
  "Keep the speaker's own words and meaning. Do not summarize, answer, or add anything.",
  "Return only the cleaned text.",
].join("\n");

/**
 * The editor caps the prompt because every character competes with the
 * transcript for the model's context window, and a prompt long enough to
 * crowd out the transcript produces truncated output rather than an error.
 */
export const MAX_CLEANUP_PROMPT_LENGTH = 2_000;

/**
 * How long one rewrite may run before it is abandoned and the raw transcript
 * wins.
 *
 * Enforced by the implementation, which stops between generated tokens. Nothing
 * on this side can interrupt a running model, so a timer here would only
 * abandon the promise while the work carried on.
 */
export const CLEANUP_TIMEOUT_MS = 30_000;

/**
 * Below this the length-ratio check is skipped.
 *
 * Short transcripts legitimately change length by a lot: "um yeah ok" becoming
 * "Yeah, OK." is a 20% cut, and "so i mean" becoming "So, I mean," grows. The
 * ratio only separates signal from noise once there is enough text to measure.
 */
const CLEANUP_RATIO_MINIMUM_LENGTH = 24;

/** A cleanup pass that lands outside this band rewrote more than it should. */
const CLEANUP_MINIMUM_RATIO = 0.6;
const CLEANUP_MAXIMUM_RATIO = 1.6;

export type CleanupDegradeReason =
  | "load-failed"
  | "failed"
  | "cancelled"
  | "empty"
  | "incomplete"
  | "length-ratio";

export const CLEANUP_FALLBACK_NOTICES: Record<CleanupDegradeReason, string> = {
  "load-failed": "The cleanup model could not be loaded. Kept the original transcription.",
  failed: "Cleanup failed. Kept the original transcription.",
  cancelled: "Cleanup was cancelled. Kept the original transcription.",
  empty: "Cleanup returned no text. Kept the original transcription.",
  incomplete: "Cleanup stopped before finishing. Kept the original transcription.",
  "length-ratio":
    "Cleanup changed the transcript's length too much. Kept the original transcription.",
};

export type CleanupOutcome =
  | { readonly kind: "cleaned"; readonly text: string }
  | { readonly kind: "raw"; readonly text: string; readonly reason: CleanupDegradeReason };

/** What the composer says when only some chunks of a long transcript degraded. */
export const CLEANUP_PARTIAL_NOTICE =
  "Part of the message could not be cleaned up and was kept as transcribed.";

/**
 * How much transcript one rewrite is given.
 *
 * A long dictation is cleaned in pieces rather than in one pass. One pass over
 * a five-minute transcript needs more output tokens than the cap allows and
 * more time than the timeout, so it degrades to raw text exactly when cleanup
 * would help most. A piece this size finishes well inside both on every model
 * shipped, and a piece that degrades costs only its own sentences.
 */
const CLEANUP_CHUNK_TARGET_LENGTH = 700;

export type CleanupChunk = {
  readonly text: string;
  /** Whitespace that followed the chunk, preserved when the pieces are joined. */
  readonly separator: string;
};

/**
 * Splits a transcript at sentence ends into chunks of roughly the target
 * length. A short transcript is one chunk. A transcript without punctuation
 * splits at word boundaries instead, so nothing is ever cut mid-word.
 */
export function splitTranscriptForCleanup(
  transcript: string,
  target = CLEANUP_CHUNK_TARGET_LENGTH,
): readonly CleanupChunk[] {
  const trimmed = transcript.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= target * 1.5) return [{ text: trimmed, separator: "" }];

  const units: string[] = [];
  for (const sentence of trimmed.match(/[^.!?\n]*[.!?\n]+\s*|[^.!?\n]+$/g) ?? [trimmed]) {
    if (sentence.length <= target * 1.5) {
      units.push(sentence);
      continue;
    }
    // No punctuation for a long stretch: fall back to words.
    let current = "";
    for (const word of sentence.match(/\S+\s*/g) ?? []) {
      if (current.length > 0 && current.length + word.length > target) {
        units.push(current);
        current = "";
      }
      current += word;
    }
    if (current.length > 0) units.push(current);
  }

  const chunks: CleanupChunk[] = [];
  let current = "";
  const flush = () => {
    const text = current.trim();
    if (text.length === 0) return;
    const trailing = current.slice(current.trimEnd().length);
    chunks.push({ text, separator: trailing.includes("\n") ? "\n\n" : " " });
    current = "";
  };
  for (const unit of units) {
    if (current.length > 0 && current.length + unit.length > target) flush();
    current += unit;
  }
  flush();
  if (chunks.length > 0)
    chunks[chunks.length - 1] = { ...chunks[chunks.length - 1]!, separator: "" };
  return chunks;
}

/** Reassembles cleaned or raw pieces in transcript order. */
export function joinCleanupChunks(
  chunks: readonly CleanupChunk[],
  texts: readonly string[],
): string {
  return chunks
    .map((chunk, index) => (texts[index] ?? chunk.text).trim() + chunk.separator)
    .join("");
}

/**
 * Decides whether a cleanup result is usable, or whether the raw transcript
 * wins.
 *
 * A local model given a transcript it does not understand will answer it,
 * translate it, or return an apology. All three are longer or shorter than the
 * input by a wide margin, which is what the ratio catches. Degrading is always
 * safe: the raw transcript is what the user actually said.
 *
 * A rewrite the model did not finish is thrown away whole rather than measured.
 * It reads as a complete message that stops mid-sentence, and the ratio cannot
 * see that: a rewrite cut a sentence or two from the end still lands well
 * inside the band, so it would be committed as if the user never said the rest.
 */
export function resolveCleanupOutcome(raw: string, cleaned: VoiceCleanupResult): CleanupOutcome {
  const trimmedRaw = raw.trim();
  const trimmedCleaned = cleaned.text.trim();

  if (!cleaned.complete) {
    return { kind: "raw", text: trimmedRaw, reason: "incomplete" };
  }

  if (trimmedCleaned.length === 0) {
    return { kind: "raw", text: trimmedRaw, reason: "empty" };
  }

  if (trimmedRaw.length >= CLEANUP_RATIO_MINIMUM_LENGTH) {
    const ratio = trimmedCleaned.length / trimmedRaw.length;
    if (ratio < CLEANUP_MINIMUM_RATIO || ratio > CLEANUP_MAXIMUM_RATIO) {
      return { kind: "raw", text: trimmedRaw, reason: "length-ratio" };
    }
  }

  return { kind: "cleaned", text: trimmedCleaned };
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Parses the preferred-spellings list the user types in settings.
 *
 * One entry per line or comma. Duplicates that differ only by case collapse to
 * the first spelling entered, because the whole point of the list is that one
 * spelling is the right one.
 */
export function parsePreferredSpellings(input: string): readonly PreferredSpelling[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of input.split(/[\n,]/)) {
    const value = candidate.trim();
    if (value.length === 0) continue;
    const key = normalizeKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }

  return result;
}

/**
 * Parses `wrong -> right` pairs, one per line.
 *
 * `->`, `→`, and `=>` all work, because the user is typing this on a phone
 * keyboard. Later lines win over earlier ones for the same left-hand side, so
 * correcting a mapping is a matter of adding the new one.
 */
export function parseCorrectionPairs(input: string): readonly CorrectionPair[] {
  const byWrong = new Map<string, CorrectionPair>();

  for (const line of input.split("\n")) {
    const match = /^(.*?)\s*(?:->|=>|→)\s*(.*)$/.exec(line);
    if (!match) continue;

    const wrong = match[1]?.trim() ?? "";
    const right = match[2]?.trim() ?? "";
    if (wrong.length === 0 || right.length === 0) continue;
    // Compared exactly, not case-insensitively: `xcode -> Xcode` is one of the
    // most useful mappings there is, and folding case would throw it away.
    if (wrong === right) continue;

    byWrong.set(normalizeKey(wrong), { wrong, right });
  }

  return [...byWrong.values()];
}

export function formatCorrectionPairs(pairs: readonly CorrectionPair[]): string {
  return pairs.map((pair) => `${pair.wrong} -> ${pair.right}`).join("\n");
}

/**
 * Merges typed and learned corrections into one list.
 *
 * Typed pairs win. A user who wrote a mapping by hand has said what they want
 * more clearly than the learning loop inferring one from an edit.
 */
export function mergeCorrectionPairs(
  typed: readonly CorrectionPair[],
  learned: readonly CorrectionPair[],
): readonly CorrectionPair[] {
  const byWrong = new Map<string, CorrectionPair>();
  for (const pair of learned) byWrong.set(normalizeKey(pair.wrong), pair);
  for (const pair of typed) byWrong.set(normalizeKey(pair.wrong), pair);
  return [...byWrong.values()];
}

/**
 * Composes the prompt sent to the cleanup model.
 *
 * The hints go in their own delimited block so the model can tell instructions
 * from data. Without hints the block is omitted entirely rather than sent
 * empty, since an empty `<CORRECTION-HINTS>` reads as "there are no correct
 * spellings" to a small model.
 */
export function buildCleanupPrompt(input: {
  readonly basePrompt: string;
  readonly corrections: VoiceCorrections;
}): string {
  const base = input.basePrompt.trim() || DEFAULT_CLEANUP_PROMPT;
  const { preferredSpellings, pairs } = input.corrections;
  if (preferredSpellings.length === 0 && pairs.length === 0) return base;

  const lines: string[] = ["<CORRECTION-HINTS>"];

  if (preferredSpellings.length > 0) {
    lines.push("Spell these exactly as written when you hear them:");
    for (const spelling of preferredSpellings) lines.push(`- ${spelling}`);
  }

  if (pairs.length > 0) {
    if (preferredSpellings.length > 0) lines.push("");
    lines.push("Replace the left side with the right side:");
    for (const pair of pairs) lines.push(`- ${pair.wrong} -> ${pair.right}`);
  }

  lines.push("</CORRECTION-HINTS>");

  return `${base}\n\n${lines.join("\n")}`;
}
