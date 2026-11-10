import { capitalize, splitWords, startsSentence } from "./words";

// "er" is left out: it is also how people write a spoken "ER" and a word in several languages.
const FILLERS = new Set(["um", "umm", "uh", "uhh", "uhm", "erm"]);
const isAcronym = (word: string) => word.length > 1 && word === word.toUpperCase();
const SENTENCE_END = new Set(".!?…");

/** Drops English hesitation sounds along with the comma that trails them, and repairs sentence case. */
export function removeFillers(text: string): string {
  let output = "";
  let cursor = 0;
  let capitalizeNext = false;
  const append = (chunk: string) => {
    if (chunk.length === 0) return;
    output += capitalizeNext ? capitalize(chunk) : chunk;
    capitalizeNext = false;
  };

  for (const word of splitWords(text)) {
    if (!FILLERS.has(word.key) || isAcronym(word.text)) continue;
    append(text.slice(cursor, word.start));
    let end = word.end;
    if (text[end] === ",") end += 1;
    while (end < text.length && text[end]!.trim().length === 0) end += 1;
    const sentenceStart = startsSentence(text, word.start);
    const closesSentence = end === text.length || SENTENCE_END.has(text[end]!);
    if (closesSentence && sentenceStart) {
      while (end < text.length && (SENTENCE_END.has(text[end]!) || text[end]!.trim().length === 0))
        end += 1;
    } else if (closesSentence) {
      output = output.replace(/[,\s]+$/, "");
    }
    if (sentenceStart) capitalizeNext = true;
    cursor = end;
  }
  if (cursor === 0) return text;
  append(text.slice(cursor));
  return cursor === text.length ? output.trimEnd() : output;
}

export function usesEnglish(locale: string): boolean {
  const normalized = locale.replaceAll("_", "-").toLowerCase();
  return normalized === "en" || normalized.startsWith("en-");
}
