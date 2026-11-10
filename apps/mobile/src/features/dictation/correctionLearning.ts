import { ruleKey, type ReplacementRule } from "./replacementRules";
import { splitWords, type Word } from "./words";

export interface CorrectionPair {
  readonly heard: string;
  readonly written: string;
}

export interface CorrectionCandidate extends CorrectionPair {
  readonly sightings: ReadonlyArray<number>;
  readonly suggested: boolean;
}

export interface LearningState {
  readonly rules: ReadonlyArray<ReplacementRule>;
  readonly candidates: ReadonlyArray<CorrectionCandidate>;
  readonly dismissed: ReadonlyArray<string>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SURVIVAL_RATIO = 0.6;
const MAX_RUN_WORDS = 3;
const MIN_PAIR_LETTERS = 3;
const MAX_EDIT_RATIO = 0.65;
const MAX_ALIGNMENT_CELLS = 250_000;
const PROMOTION_WINDOW_MS = 7 * DAY_MS;
const CANDIDATE_LIFETIME_MS = 30 * DAY_MS;
export const MAX_RULES = 200;
const MAX_CANDIDATES = 100;
const MAX_DISMISSED = 400;
const INFLECTIONS = ["s", "es", "d", "ed", "ing", "'s", "’s", "ly"];

export const pairKey = (pair: CorrectionPair) => `${pair.heard}\n${pair.written}`;

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

function isInflection(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter) && INFLECTIONS.includes(longer.slice(shorter.length));
}

/** Longest common subsequence of word keys, as index pairs in order. */
function alignWords(
  dictated: ReadonlyArray<Word>,
  sent: ReadonlyArray<Word>,
): ReadonlyArray<readonly [number, number]> {
  const columns = sent.length + 1;
  const lengths = new Uint16Array((dictated.length + 1) * columns);
  for (let row = dictated.length - 1; row >= 0; row -= 1) {
    for (let column = sent.length - 1; column >= 0; column -= 1) {
      lengths[row * columns + column] =
        dictated[row]!.key === sent[column]!.key
          ? lengths[(row + 1) * columns + column + 1]! + 1
          : Math.max(lengths[(row + 1) * columns + column]!, lengths[row * columns + column + 1]!);
    }
  }
  const matches: Array<readonly [number, number]> = [];
  for (let row = 0, column = 0; row < dictated.length && column < sent.length;) {
    if (dictated[row]!.key === sent[column]!.key) {
      matches.push([row, column]);
      row += 1;
      column += 1;
    } else if (lengths[(row + 1) * columns + column]! >= lengths[row * columns + column + 1]!) {
      row += 1;
    } else {
      column += 1;
    }
  }
  return matches;
}

/**
 * Finds what the user changed in a dictated passage by locating it inside the text they sent.
 * `matched` is false when too little of the dictation survives to say the passage is in there.
 * Text typed around the passage is ignored because it lies outside the aligned words.
 */
export function extractCorrections(
  dictated: string,
  sent: string,
): { readonly matched: boolean; readonly pairs: ReadonlyArray<CorrectionPair> } {
  const dictatedWords = splitWords(dictated);
  const sentWords = splitWords(sent);
  if (dictatedWords.length === 0 || dictatedWords.length * sentWords.length > MAX_ALIGNMENT_CELLS) {
    return { matched: false, pairs: [] };
  }
  const matches = alignWords(dictatedWords, sentWords);
  if (matches.length / dictatedWords.length < SURVIVAL_RATIO) return { matched: false, pairs: [] };

  const pairs = new Map<string, CorrectionPair>();
  const add = (pair: CorrectionPair) => pairs.set(pairKey(pair), pair);

  for (const [row, column] of matches) {
    const before = dictatedWords[row]!.text;
    const after = sentWords[column]!.text;
    if (before !== after && before.slice(1) !== after.slice(1)) {
      add({ heard: dictatedWords[row]!.key, written: after });
    }
  }

  // The ends of both texts count as anchors, so a fix to the first or last dictated word is seen
  // when the dictation is the whole message. Text typed beyond it makes the run too long to learn.
  const anchors = [
    [-1, -1] as const,
    ...matches,
    [dictatedWords.length, sentWords.length] as const,
  ];
  for (let index = 1; index < anchors.length; index += 1) {
    const [previousRow, previousColumn] = anchors[index - 1]!;
    const [row, column] = anchors[index]!;
    const removed = dictatedWords.slice(previousRow + 1, row);
    const added = sentWords.slice(previousColumn + 1, column);
    if (
      removed.length === 0 ||
      added.length === 0 ||
      removed.length > MAX_RUN_WORDS ||
      added.length > MAX_RUN_WORDS
    ) {
      continue;
    }
    const heardLetters = removed.map((word) => word.key).join("");
    const writtenLetters = added.map((word) => word.key).join("");
    if (
      Math.min(heardLetters.length, writtenLetters.length) < 2 ||
      Math.max(heardLetters.length, writtenLetters.length) < MIN_PAIR_LETTERS
    ) {
      continue;
    }
    const ratio =
      editDistance(heardLetters, writtenLetters) /
      Math.max(heardLetters.length, writtenLetters.length);
    if (ratio >= MAX_EDIT_RATIO) continue;
    if (removed.length === 1 && added.length === 1 && isInflection(heardLetters, writtenLetters)) {
      continue;
    }
    add({
      heard: removed.map((word) => word.key).join(" "),
      written: added.map((word) => word.text).join(" "),
    });
  }
  return { matched: true, pairs: [...pairs.values()] };
}

const WORD_JOINERS = new Set("'’-");
const isLetter = (character: string) => character.toLowerCase() !== character.toUpperCase();
const isCapital = (character: string) =>
  isLetter(character) && character === character.toUpperCase();

/**
 * A written form that could not be an ordinary word swap: a phrase, or a term with a digit, a
 * symbol or mixed capitals. Only these become rules without the user confirming them. An
 * apostrophe, a hyphen and a word in all capitals are ordinary: "it's", "well-known", "NOT".
 */
export function isDistinctive(pair: CorrectionPair): boolean {
  if (pair.heard.includes(" ")) return true;
  return splitWords(pair.written).some((word) => {
    const characters = [...word.text];
    if (characters.some((character) => !isLetter(character) && !WORD_JOINERS.has(character))) {
      return true;
    }
    const inner = characters.slice(1);
    return (
      inner.some(isCapital) &&
      inner.some((character) => isLetter(character) && !isCapital(character))
    );
  });
}

function toRule(pair: CorrectionPair, source: ReplacementRule["source"], now: number) {
  return { heard: pair.heard, written: pair.written, source, addedAt: now } as const;
}

/** Records one dictation's corrections. A pair seen in 2 dictations within 7 days is promoted. */
export function learnFromPairs(
  state: LearningState,
  pairs: ReadonlyArray<CorrectionPair>,
  now: number,
): LearningState {
  const ruled = new Set(state.rules.map((rule) => ruleKey(rule.heard)));
  const dismissed = new Set(state.dismissed);
  const candidates = new Map(
    state.candidates
      .map((candidate) => ({
        ...candidate,
        sightings: candidate.sightings.filter((at) => now - at <= CANDIDATE_LIFETIME_MS),
      }))
      .filter((candidate) => candidate.sightings.length > 0 && !ruled.has(candidate.heard))
      .map((candidate) => [pairKey(candidate), candidate] as const),
  );

  for (const pair of new Map(pairs.map((item) => [pairKey(item), item] as const)).values()) {
    const key = pairKey(pair);
    if (ruled.has(pair.heard) || dismissed.has(key)) continue;
    const existing = candidates.get(key);
    candidates.set(key, {
      heard: pair.heard,
      written: pair.written,
      sightings: [...(existing?.sightings ?? []), now],
      suggested: existing?.suggested ?? false,
    });
  }

  const rules = [...state.rules];
  for (const [key, candidate] of candidates) {
    const recent = candidate.sightings.filter((at) => now - at <= PROMOTION_WINDOW_MS);
    if (recent.length < 2 || ruled.has(candidate.heard)) continue;
    if (isDistinctive(candidate) && rules.length < MAX_RULES) {
      rules.push(toRule(candidate, "learned", now));
      ruled.add(candidate.heard);
    } else {
      candidates.set(key, { ...candidate, suggested: true });
    }
  }

  return {
    rules,
    dismissed: state.dismissed,
    candidates: [...candidates.values()]
      .filter((candidate) => !ruled.has(candidate.heard))
      .sort((a, b) => b.sightings.at(-1)! - a.sightings.at(-1)!)
      .slice(0, MAX_CANDIDATES),
  };
}

/** Adds or replaces the rule for a heard form. A rule the user writes lifts an earlier dismissal. */
export function saveRule(
  state: LearningState,
  pair: CorrectionPair,
  source: ReplacementRule["source"],
  now: number,
): LearningState {
  const heard = ruleKey(pair.heard);
  const written = pair.written.trim();
  if (heard.length === 0 || written.length === 0) return state;
  const rule = toRule({ heard, written }, source, now);
  const others = state.rules.filter((existing) => ruleKey(existing.heard) !== heard);
  const oldest =
    others.length < MAX_RULES ? null : others.reduce((a, b) => (b.addedAt < a.addedAt ? b : a));
  return {
    rules: [rule, ...others.filter((existing) => existing !== oldest)],
    candidates: state.candidates.filter((candidate) => candidate.heard !== heard),
    dismissed: state.dismissed.filter((key) => key !== pairKey(rule)),
  };
}

/** Removes a rule or a candidate and remembers the pair so it is not learned again. */
export function forgetPair(state: LearningState, pair: CorrectionPair): LearningState {
  const heard = ruleKey(pair.heard);
  const key = pairKey({ heard, written: pair.written });
  return {
    rules: state.rules.filter(
      (rule) => !(ruleKey(rule.heard) === heard && rule.written === pair.written),
    ),
    candidates: state.candidates.filter((candidate) => pairKey(candidate) !== key),
    dismissed: [key, ...state.dismissed.filter((existing) => existing !== key)].slice(
      0,
      MAX_DISMISSED,
    ),
  };
}

const PENDING_LIMIT = 5;
const PENDING_LIFETIME_MS = 30 * 60 * 1000;

/**
 * Dictations waiting for the message they went into. A dictation leaves the list the first time it
 * is found in sent text, so resending the same text cannot count its corrections twice. One sent
 * message yields each pair once, however many of its dictations carried it.
 */
export class PendingDictations {
  private pending: Array<{ readonly text: string; readonly at: number }> = [];

  note(text: string, now: number): void {
    if (splitWords(text).length === 0) return;
    this.pending = [...this.pending, { text, at: now }].slice(-PENDING_LIMIT);
  }

  clear(): void {
    this.pending = [];
  }

  resolve(sent: string, now: number): ReadonlyArray<CorrectionPair> {
    const found = new Map<string, CorrectionPair>();
    this.pending = this.pending.filter((dictation) => {
      if (now - dictation.at > PENDING_LIFETIME_MS) return false;
      const extraction = extractCorrections(dictation.text, sent);
      for (const pair of extraction.pairs) found.set(pairKey(pair), pair);
      return !extraction.matched;
    });
    return [...found.values()];
  }
}
