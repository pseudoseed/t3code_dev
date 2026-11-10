import { expect, it } from "vite-plus/test";

import { applyReplacementRules } from "./replacementRules";

const rule = (heard: string, written: string) => ({ heard, written });

it.each([
  {
    name: "replaces a phrase whatever its case",
    text: "I use Pseudo Code and pseudo  code daily",
    rules: [rule("pseudo code", "PseudoCode")],
    expected: "I use PseudoCode and PseudoCode daily",
  },
  {
    name: "matches whole words only",
    text: "concatenate the cat.",
    rules: [rule("cat", "CAT")],
    expected: "concatenate the CAT.",
  },
  {
    name: "prefers the longest rule that starts on a word",
    text: "a new car in new york",
    rules: [rule("new", "gnu"), rule("new york", "NYC")],
    expected: "a gnu car in NYC",
  },
  {
    name: "keeps the punctuation around a match",
    text: "(pseudo code)! Done.",
    rules: [rule("pseudo code", "PseudoCode")],
    expected: "(PseudoCode)! Done.",
  },
  {
    name: "does not join a phrase across punctuation",
    text: "pseudo, code",
    rules: [rule("pseudo code", "PseudoCode")],
    expected: "pseudo, code",
  },
  {
    name: "keeps a capital at the start of a sentence and nowhere else",
    text: "Teh end. Teh start of Teh",
    rules: [rule("teh", "the")],
    expected: "The end. The start of the",
  },
  {
    name: "does not match text it has just written",
    text: "a b",
    rules: [rule("a", "b"), rule("b", "c")],
    expected: "b c",
  },
  {
    name: "ignores a rule with nothing to hear or nothing to write",
    text: "keep this",
    rules: [rule("...", "x"), rule("keep", "  ")],
    expected: "keep this",
  },
])("$name", ({ text, rules, expected }) => {
  expect(applyReplacementRules(text, rules)).toBe(expected);
});
