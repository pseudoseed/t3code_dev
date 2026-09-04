import { describe, expect, it } from "vite-plus/test";

import {
  addLearnedCorrections,
  diffCorrections,
  removeLearnedCorrection,
  resolveEditedSpan,
  type DictationAnchor,
} from "./learning.ts";

function anchor(overrides: Partial<DictationAnchor> = {}): DictationAnchor {
  return {
    ownerKey: "environment:thread",
    revision: 1,
    before: "Fix ",
    insertedText: "the ghosty renderer",
    after: " please",
    ...overrides,
  };
}

describe("resolveEditedSpan", () => {
  it("recovers what the user left where the dictation landed", () => {
    expect(resolveEditedSpan(anchor(), "Fix the Ghostty renderer please")).toBe(
      "the Ghostty renderer",
    );
  });

  it("gives up when the text around the span changed", () => {
    expect(resolveEditedSpan(anchor(), "Please fix the Ghostty renderer please")).toBeNull();
    expect(resolveEditedSpan(anchor(), "Fix the Ghostty renderer now")).toBeNull();
  });

  it("recovers an empty span when the user deleted the dictation", () => {
    expect(resolveEditedSpan(anchor(), "Fix  please")).toBe("");
  });
});

describe("diffCorrections", () => {
  it("learns a one-word replacement", () => {
    expect(diffCorrections("open the ghosty window", "open the Ghostty window")).toEqual([
      { wrong: "ghosty", right: "Ghostty" },
    ]);
  });

  it("learns two separate replacements in one dictation", () => {
    expect(
      diffCorrections("run tea three against ghosty now", "run T3 against Ghostty now"),
    ).toEqual([
      { wrong: "tea three", right: "T3" },
      { wrong: "ghosty", right: "Ghostty" },
    ]);
  });

  it("ignores a deletion and an insertion", () => {
    expect(diffCorrections("please fix the bug", "fix the bug")).toEqual([]);
    expect(diffCorrections("fix the bug", "please fix the bug")).toEqual([]);
  });

  it("ignores a rewrite longer than two words on either side", () => {
    expect(
      diffCorrections("make the thing work", "rewrite this entire sentence completely"),
    ).toEqual([]);
  });

  it("ignores punctuation-only and whitespace-only changes", () => {
    expect(diffCorrections("fix the bug", "fix the bug.")).toEqual([
      { wrong: "bug", right: "bug." },
    ]);
    expect(diffCorrections("fix the bug ,", "fix the bug .")).toEqual([]);
    expect(diffCorrections("fix  the bug", "fix the bug")).toEqual([]);
  });

  it("learns nothing when nothing changed or one side is empty", () => {
    expect(diffCorrections("fix the bug", "fix the bug")).toEqual([]);
    expect(diffCorrections("fix the bug", "   ")).toEqual([]);
    expect(diffCorrections("", "fix the bug")).toEqual([]);
  });
});

describe("addLearnedCorrections", () => {
  it("lets a newer mapping replace an older one for the same word", () => {
    const stored = addLearnedCorrections(
      [{ wrong: "ghosty", right: "ghost tea" }],
      [{ wrong: "Ghosty", right: "Ghostty" }],
    );

    expect(stored).toEqual([{ wrong: "Ghosty", right: "Ghostty" }]);
  });

  it("drops the least recently confirmed mapping at the cap", () => {
    const stored = addLearnedCorrections(
      [
        { wrong: "a", right: "A" },
        { wrong: "b", right: "B" },
      ],
      [{ wrong: "c", right: "C" }],
      2,
    );

    expect(stored).toEqual([
      { wrong: "b", right: "B" },
      { wrong: "c", right: "C" },
    ]);
  });

  it("moves a reconfirmed mapping to the end so the cap does not drop it", () => {
    const stored = addLearnedCorrections(
      [
        { wrong: "a", right: "A" },
        { wrong: "b", right: "B" },
      ],
      [{ wrong: "a", right: "A" }],
      2,
    );

    expect(stored).toEqual([
      { wrong: "b", right: "B" },
      { wrong: "a", right: "A" },
    ]);
  });
});

describe("removeLearnedCorrection", () => {
  it("removes one entry regardless of case", () => {
    expect(
      removeLearnedCorrection(
        [
          { wrong: "Ghosty", right: "Ghostty" },
          { wrong: "xcode", right: "Xcode" },
        ],
        "ghosty",
      ),
    ).toEqual([{ wrong: "xcode", right: "Xcode" }]);
  });
});
