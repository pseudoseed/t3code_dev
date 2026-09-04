/**
 * Learning corrections from what the user fixes by hand.
 *
 * A dictation that produces "ghosty" when the user meant "Ghostty" is worth
 * remembering, but only from the words that dictation actually inserted. This
 * anchors to that span and diffs it alone, because diffing the whole draft
 * learns unrelated edits and then pollutes every future transcript with them.
 *
 * Everything here is pure. Storage is a client concern.
 */

import type { CorrectionPair } from "./cleanup.ts";

/**
 * Where a dictation landed in a draft, and what surrounded it.
 *
 * Positions alone do not survive editing, so the text on either side is kept
 * instead. If either has changed by submit time, the anchor is spent and
 * nothing is learned. That bias is deliberate: a wrong mapping is permanent
 * until the user finds and deletes it, while a missed one costs nothing.
 */
export type DictationAnchor = {
  readonly ownerKey: string;
  readonly revision: number;
  readonly before: string;
  readonly insertedText: string;
  readonly after: string;
};

/** How many learned mappings are kept before the oldest is dropped. */
export const MAX_LEARNED_CORRECTIONS = 200;

/** Longer than this on either side and it is a rewrite, not a correction. */
const MAX_CORRECTION_WORDS = 2;

function words(value: string): readonly string[] {
  return value.split(/\s+/).filter((word) => word.length > 0);
}

/** True when a token carries no letters or digits to correct. */
function isSubstantive(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

/**
 * Recovers the text the user left in the dictated span.
 *
 * Returns null when the surrounding text moved, which means the span can no
 * longer be located and nothing about it can be trusted.
 */
export function resolveEditedSpan(anchor: DictationAnchor, currentText: string): string | null {
  if (!currentText.startsWith(anchor.before)) return null;
  if (!currentText.endsWith(anchor.after)) return null;

  const start = anchor.before.length;
  const end = currentText.length - anchor.after.length;
  if (end < start) return null;

  return currentText.slice(start, end);
}

/**
 * The word-level replacements between what was dictated and what was sent.
 *
 * Only replacements are learned. A deletion means the user cut a word, not that
 * it was misheard, and an insertion means they added one; neither says anything
 * about what the model should have produced.
 */
export function diffCorrections(original: string, edited: string): readonly CorrectionPair[] {
  const left = words(original);
  const right = words(edited);
  if (left.length === 0 || right.length === 0) return [];

  const pairs: CorrectionPair[] = [];
  for (const block of alignmentBlocks(left, right)) {
    const wrong = block.left.join(" ");
    const right_ = block.right.join(" ");
    if (block.left.length === 0 || block.right.length === 0) continue;
    if (block.left.length > MAX_CORRECTION_WORDS) continue;
    if (block.right.length > MAX_CORRECTION_WORDS) continue;
    if (wrong === right_) continue;
    if (!isSubstantive(wrong) || !isSubstantive(right_)) continue;

    pairs.push({ wrong, right: right_ });
  }

  return pairs;
}

type AlignmentBlock = { readonly left: readonly string[]; readonly right: readonly string[] };

/**
 * The differing runs between two word lists.
 *
 * A longest-common-subsequence walk rather than a prefix and suffix trim,
 * because a user who fixes two separate words in one dictation means both of
 * them, and trimming would collapse everything between into one huge block that
 * the word limit then throws away.
 */
function alignmentBlocks(
  left: readonly string[],
  right: readonly string[],
): readonly AlignmentBlock[] {
  const lengths: number[][] = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i]![j] =
        left[i] === right[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }

  const blocks: AlignmentBlock[] = [];
  let pendingLeft: string[] = [];
  let pendingRight: string[] = [];
  const flush = () => {
    if (pendingLeft.length > 0 || pendingRight.length > 0) {
      blocks.push({ left: pendingLeft, right: pendingRight });
      pendingLeft = [];
      pendingRight = [];
    }
  };

  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      pendingLeft.push(left[i]!);
      i += 1;
    } else {
      pendingRight.push(right[j]!);
      j += 1;
    }
  }

  pendingLeft.push(...left.slice(i));
  pendingRight.push(...right.slice(j));
  flush();

  return blocks;
}

/**
 * Folds new mappings into the stored list.
 *
 * The newest mapping for a word wins, and it moves to the end, so the cap drops
 * whatever the user has gone longest without confirming.
 */
export function addLearnedCorrections(
  existing: readonly CorrectionPair[],
  learned: readonly CorrectionPair[],
  cap: number = MAX_LEARNED_CORRECTIONS,
): readonly CorrectionPair[] {
  const byWrong = new Map<string, CorrectionPair>();
  for (const pair of existing) byWrong.set(pair.wrong.toLowerCase(), pair);
  for (const pair of learned) {
    const key = pair.wrong.toLowerCase();
    byWrong.delete(key);
    byWrong.set(key, pair);
  }

  const merged = [...byWrong.values()];
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

export function removeLearnedCorrection(
  existing: readonly CorrectionPair[],
  wrong: string,
): readonly CorrectionPair[] {
  return existing.filter((pair) => pair.wrong.toLowerCase() !== wrong.toLowerCase());
}
