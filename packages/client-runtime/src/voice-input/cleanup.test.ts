import { describe, expect, it } from "vite-plus/test";

import {
  buildCleanupPrompt,
  DEFAULT_CLEANUP_PROMPT,
  EMPTY_VOICE_CORRECTIONS,
  formatCorrectionPairs,
  mergeCorrectionPairs,
  parseCorrectionPairs,
  parsePreferredSpellings,
  resolveCleanupOutcome,
} from "./cleanup.ts";

describe("resolveCleanupOutcome", () => {
  it("keeps a cleaned transcript of a plausible length", () => {
    const raw = "um so i think we should fix the thing in the composer";
    const cleaned = "So I think we should fix the thing in the composer.";

    expect(resolveCleanupOutcome(raw, cleaned)).toEqual({ kind: "cleaned", text: cleaned });
  });

  it("degrades when the model returns nothing", () => {
    expect(resolveCleanupOutcome("the quick brown fox jumped", "   ")).toEqual({
      kind: "raw",
      text: "the quick brown fox jumped",
      reason: "empty",
    });
  });

  it("degrades when the model answered the transcript instead of rewriting it", () => {
    const raw = "what is the capital of france";
    const answered =
      "The capital of France is Paris, a city on the Seine with a population of over two million people in the city proper.";

    expect(resolveCleanupOutcome(raw, answered)).toMatchObject({
      kind: "raw",
      text: raw,
      reason: "length-ratio",
    });
  });

  it("degrades when the model dropped most of the transcript", () => {
    const raw = "add a retry button to the connection settings screen please";

    expect(resolveCleanupOutcome(raw, "Add a retry.")).toMatchObject({
      kind: "raw",
      reason: "length-ratio",
    });
  });

  it("does not apply the ratio to short transcripts that legitimately change length", () => {
    expect(resolveCleanupOutcome("um yeah ok", "Yeah, OK.")).toEqual({
      kind: "cleaned",
      text: "Yeah, OK.",
    });
  });
});

describe("parsePreferredSpellings", () => {
  it("splits on lines and commas and drops blanks", () => {
    expect(parsePreferredSpellings("T3 Code\n  \nGhostty, WhisperKit\n")).toEqual([
      "T3 Code",
      "Ghostty",
      "WhisperKit",
    ]);
  });

  it("keeps the first spelling when entries differ only by case", () => {
    expect(parsePreferredSpellings("WhisperKit\nwhisperkit")).toEqual(["WhisperKit"]);
  });
});

describe("parseCorrectionPairs", () => {
  it("accepts every arrow a phone keyboard makes easy", () => {
    expect(parseCorrectionPairs("tea three -> T3\nghosty => Ghostty\nxcode → Xcode")).toEqual([
      { wrong: "tea three", right: "T3" },
      { wrong: "ghosty", right: "Ghostty" },
      { wrong: "xcode", right: "Xcode" },
    ]);
  });

  it("skips lines with no arrow, a missing side, or no actual change", () => {
    expect(parseCorrectionPairs("just a note\n-> T3\nghosty ->\nT3 -> T3")).toEqual([]);
  });

  it("lets a later mapping replace an earlier one for the same word", () => {
    expect(parseCorrectionPairs("ghosty -> Ghost\nGhosty -> Ghostty")).toEqual([
      { wrong: "Ghosty", right: "Ghostty" },
    ]);
  });

  it("round-trips through the settings editor format", () => {
    const pairs = parseCorrectionPairs("ghosty -> Ghostty\ntea three -> T3");
    expect(parseCorrectionPairs(formatCorrectionPairs(pairs))).toEqual(pairs);
  });
});

describe("mergeCorrectionPairs", () => {
  it("lets a typed mapping override a learned one for the same word", () => {
    const merged = mergeCorrectionPairs(
      [{ wrong: "ghosty", right: "Ghostty" }],
      [
        { wrong: "Ghosty", right: "ghost tea" },
        { wrong: "xcode", right: "Xcode" },
      ],
    );

    expect(merged).toEqual([
      { wrong: "ghosty", right: "Ghostty" },
      { wrong: "xcode", right: "Xcode" },
    ]);
  });
});

describe("buildCleanupPrompt", () => {
  it("sends the base prompt alone when there is nothing to hint", () => {
    expect(
      buildCleanupPrompt({ basePrompt: "Clean this up.", corrections: EMPTY_VOICE_CORRECTIONS }),
    ).toBe("Clean this up.");
  });

  it("falls back to the default prompt when the user cleared theirs", () => {
    expect(buildCleanupPrompt({ basePrompt: "   ", corrections: EMPTY_VOICE_CORRECTIONS })).toBe(
      DEFAULT_CLEANUP_PROMPT,
    );
  });

  it("puts both hint lists in one delimited block", () => {
    const prompt = buildCleanupPrompt({
      basePrompt: "Clean this up.",
      corrections: {
        preferredSpellings: ["Ghostty"],
        pairs: [{ wrong: "tea three", right: "T3" }],
      },
    });

    expect(prompt).toBe(
      [
        "Clean this up.",
        "",
        "<CORRECTION-HINTS>",
        "Spell these exactly as written when you hear them:",
        "- Ghostty",
        "",
        "Replace the left side with the right side:",
        "- tea three -> T3",
        "</CORRECTION-HINTS>",
      ].join("\n"),
    );
  });

  it("omits the list that is empty rather than labeling an empty section", () => {
    const prompt = buildCleanupPrompt({
      basePrompt: "Clean this up.",
      corrections: { preferredSpellings: ["Ghostty"], pairs: [] },
    });

    expect(prompt).not.toContain("Replace the left side");
    expect(prompt).toContain("- Ghostty");
  });
});
