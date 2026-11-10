export interface Word {
  readonly text: string;
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

// U+2014 is the em dash, which lint keeps out of string literals.
const EDGE_PUNCTUATION = new Set(".,!?;:()[]{}\"'“”‘’…–«»¿¡" + String.fromCodePoint(0x2014));

const isWhitespace = (character: string) => character.trim().length === 0;

/** Words with their offsets. Punctuation on a word's edges is left out; inside a word it stays. */
export function splitWords(text: string): ReadonlyArray<Word> {
  const words: Word[] = [];
  let index = 0;
  while (index < text.length) {
    if (isWhitespace(text[index]!)) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < text.length && !isWhitespace(text[end]!)) end += 1;
    let start = index;
    let stop = end;
    while (start < stop && EDGE_PUNCTUATION.has(text[start]!)) start += 1;
    while (stop > start && EDGE_PUNCTUATION.has(text[stop - 1]!)) stop -= 1;
    if (stop > start) {
      const word = text.slice(start, stop);
      words.push({ text: word, key: word.toLowerCase(), start, end: stop });
    }
    index = end;
  }
  return words;
}

const SENTENCE_END = new Set(".!?…");
const OPENING = new Set("([{\"'“‘«¿¡");

/** True at the start of the text and right after a sentence terminator, ignoring opening quotes and brackets. */
export function startsSentence(text: string, offset: number): boolean {
  for (let index = offset - 1; index >= 0; index -= 1) {
    const character = text[index]!;
    if (isWhitespace(character) || OPENING.has(character)) continue;
    return SENTENCE_END.has(character);
  }
  return true;
}

export function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}
