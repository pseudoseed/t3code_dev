import { capitalize, splitWords, startsSentence } from "./words";

export interface ReplacementRule {
  readonly heard: string;
  readonly written: string;
  readonly source: "manual" | "learned";
  readonly addedAt: number;
}

/** Rules match on this: lower case words, single spaces, edge punctuation removed. */
export function ruleKey(heard: string): string {
  return splitWords(heard)
    .map((word) => word.key)
    .join(" ");
}

const isLowerCase = (character: string | undefined) =>
  character !== undefined &&
  character === character.toLowerCase() &&
  character !== character.toUpperCase();

const isUpperCase = (character: string | undefined) =>
  character !== undefined &&
  character === character.toUpperCase() &&
  character !== character.toLowerCase();

/**
 * Replaces whole words and phrases, ignoring case. The longest rule wins where several start on the
 * same word, and replaced text is not matched again.
 */
export function applyReplacementRules(
  text: string,
  rules: ReadonlyArray<Pick<ReplacementRule, "heard" | "written">>,
): string {
  const byFirstWord = new Map<
    string,
    Array<{ readonly keys: ReadonlyArray<string>; readonly written: string }>
  >();
  for (const rule of rules) {
    const keys = ruleKey(rule.heard).split(" ");
    const first = keys[0];
    if (!first || rule.written.trim().length === 0) continue;
    const bucket = byFirstWord.get(first) ?? [];
    bucket.push({ keys, written: rule.written.trim() });
    byFirstWord.set(first, bucket);
  }
  if (byFirstWord.size === 0) return text;
  for (const bucket of byFirstWord.values()) bucket.sort((a, b) => b.keys.length - a.keys.length);

  const words = splitWords(text);
  let output = "";
  let cursor = 0;
  for (let index = 0; index < words.length;) {
    const match = byFirstWord.get(words[index]!.key)?.find((candidate) =>
      candidate.keys.every((key, offset) => {
        const word = words[index + offset];
        if (word?.key !== key) return false;
        return (
          offset === 0 || text.slice(words[index + offset - 1]!.end, word.start).trim().length === 0
        );
      }),
    );
    if (!match) {
      index += 1;
      continue;
    }
    const start = words[index]!.start;
    const end = words[index + match.keys.length - 1]!.end;
    const sentenceCase =
      isLowerCase(match.written[0]) && isUpperCase(text[start]) && startsSentence(text, start);
    output +=
      text.slice(cursor, start) + (sentenceCase ? capitalize(match.written) : match.written);
    cursor = end;
    index += match.keys.length;
  }
  return output + text.slice(cursor);
}
