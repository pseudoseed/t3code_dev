import { describe, expect, it } from "vite-plus/test";

import {
  extractCorrections,
  forgetPair,
  isDistinctive,
  learnFromPairs,
  MAX_RULES,
  PendingDictations,
  saveRule,
  type LearningState,
} from "./correctionLearning";

const EMPTY: LearningState = { rules: [], candidates: [], dismissed: [] };
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const KUBECTL = { heard: "cube control", written: "kubectl" };
const THEIR = { heard: "there", written: "their" };

describe("extractCorrections", () => {
  it.each([
    {
      name: "a phrase rewritten as one term",
      dictated: "open the sudo code repo and run tests",
      sent: "open the PseudoCode repo and run tests",
      pairs: [{ heard: "sudo code", written: "PseudoCode" }],
    },
    {
      name: "a fix inside text typed around the dictation",
      dictated: "please check the cube control logs today",
      sent: "Hey team, please check the kubectl logs today before lunch",
      pairs: [KUBECTL],
    },
    {
      name: "a fix to the first and the last word of a whole message",
      dictated: "cloud says the tests pass on mane",
      sent: "Claude says the tests pass on main",
      pairs: [
        { heard: "cloud", written: "Claude" },
        { heard: "mane", written: "main" },
      ],
    },
    {
      name: "a capital added inside a word",
      dictated: "push it to github now please",
      sent: "push it to GitHub now please",
      pairs: [{ heard: "github", written: "GitHub" }],
    },
    {
      name: "nothing for a capital at the start of a word",
      dictated: "hello world how are you",
      sent: "Hello world how are you",
      pairs: [],
    },
    {
      name: "nothing for a change of ending",
      dictated: "run the test now okay",
      sent: "run the tests now okay",
      pairs: [],
    },
    {
      name: "nothing for a reworded passage",
      dictated: "the build is quick today",
      sent: "the build is slow today",
      pairs: [],
    },
    {
      name: "nothing for a long rewrite",
      dictated: "tell them to ship it when ready and then update the release notes",
      sent: "tell them to ship it after the security review completes and then update the release notes",
      pairs: [],
    },
  ])("finds $name", ({ dictated, sent, pairs }) => {
    expect(extractCorrections(dictated, sent)).toEqual({ matched: true, pairs });
  });

  it("does not match a message the dictation is not in", () => {
    expect(extractCorrections("check the cube control logs", "what is for lunch today")).toEqual({
      matched: false,
      pairs: [],
    });
  });
});

describe("isDistinctive", () => {
  it.each([
    [KUBECTL, true],
    [{ heard: "github", written: "GitHub" }, true],
    [{ heard: "kates", written: "k8s" }, true],
    [{ heard: "see sharp", written: "c#" }, true],
    [{ heard: "iphone", written: "iPhone" }, true],
    [{ heard: "chris", written: "@chris" }, true],
    [THEIR, false],
    [{ heard: "cloud", written: "Claude" }, false],
    [{ heard: "your", written: "you're" }, false],
    [{ heard: "its", written: "it’s" }, false],
    [{ heard: "wellknown", written: "well-known" }, false],
    [{ heard: "not", written: "NOT" }, false],
  ])("%j is %j", (pair, expected) => {
    expect(isDistinctive(pair)).toBe(expected);
  });
});

describe("learnFromPairs", () => {
  it("makes a rule from a distinctive pair seen in 2 dictations within 7 days", () => {
    const first = learnFromPairs(EMPTY, [KUBECTL], 0);
    expect(first.rules).toEqual([]);
    expect(first.candidates).toEqual([{ ...KUBECTL, sightings: [0], suggested: false }]);

    const second = learnFromPairs(first, [KUBECTL], 6 * DAY);
    expect(second.rules).toEqual([{ ...KUBECTL, source: "learned", addedAt: 6 * DAY }]);
    expect(second.candidates).toEqual([]);
  });

  it("only suggests an ordinary word swap, however often it is seen", () => {
    let state = learnFromPairs(EMPTY, [THEIR], 0);
    state = learnFromPairs(state, [THEIR], DAY);
    state = learnFromPairs(state, [THEIR], 2 * DAY);
    expect(state.rules).toEqual([]);
    expect(state.candidates).toEqual([{ ...THEIR, sightings: [0, DAY, 2 * DAY], suggested: true }]);
  });

  it("does not promote sightings more than 7 days apart", () => {
    const state = learnFromPairs(learnFromPairs(EMPTY, [KUBECTL], 0), [KUBECTL], 8 * DAY);
    expect(state.rules).toEqual([]);
    expect(state.candidates).toEqual([{ ...KUBECTL, sightings: [0, 8 * DAY], suggested: false }]);
  });

  it("forgets a sighting after 30 days", () => {
    const state = learnFromPairs(learnFromPairs(EMPTY, [KUBECTL], 0), [THEIR], 31 * DAY);
    expect(state.candidates).toEqual([{ ...THEIR, sightings: [31 * DAY], suggested: false }]);
  });

  it("counts a pair once per dictation", () => {
    const state = learnFromPairs(EMPTY, [KUBECTL, KUBECTL], 0);
    expect(state.rules).toEqual([]);
    expect(state.candidates).toEqual([{ ...KUBECTL, sightings: [0], suggested: false }]);
  });

  it("never learns a pair the user turned down", () => {
    let state = forgetPair(learnFromPairs(EMPTY, [KUBECTL], 0), KUBECTL);
    state = learnFromPairs(state, [KUBECTL], DAY);
    state = learnFromPairs(state, [KUBECTL], 2 * DAY);
    expect(state.rules).toEqual([]);
    expect(state.candidates).toEqual([]);
  });

  it("leaves a heard form alone once it has a rule", () => {
    const ruled = saveRule(EMPTY, { heard: "cube control", written: "kubectl" }, "manual", 0);
    const state = learnFromPairs(ruled, [{ heard: "cube control", written: "Kubectl" }], DAY);
    expect(state).toEqual(ruled);
  });
});

describe("saveRule and forgetPair", () => {
  it("replaces the rule for a heard form and clears its candidates", () => {
    let state = learnFromPairs(EMPTY, [THEIR], 0);
    state = saveRule(state, { heard: " There, ", written: " they're " }, "manual", 5);
    expect(state.rules).toEqual([
      { heard: "there", written: "they're", source: "manual", addedAt: 5 },
    ]);
    expect(state.candidates).toEqual([]);

    state = saveRule(state, THEIR, "learned", 9);
    expect(state.rules).toEqual([{ ...THEIR, source: "learned", addedAt: 9 }]);
  });

  it("makes room for a new rule by dropping the oldest one", () => {
    const rules = Array.from({ length: MAX_RULES }, (_, index) => ({
      heard: `word${index}`,
      written: `Word${index}`,
      source: "learned" as const,
      addedAt: index === 7 ? 0 : 100 + index,
    }));
    const state = saveRule({ ...EMPTY, rules }, KUBECTL, "manual", 999);
    expect(state.rules).toHaveLength(MAX_RULES);
    expect(state.rules[0]).toEqual({ ...KUBECTL, source: "manual", addedAt: 999 });
    expect(state.rules.map((rule) => rule.heard)).not.toContain("word7");
  });

  it("ignores a rule with nothing to hear or nothing to write", () => {
    expect(saveRule(EMPTY, { heard: "?!", written: "x" }, "manual", 0)).toBe(EMPTY);
    expect(saveRule(EMPTY, { heard: "x", written: "  " }, "manual", 0)).toBe(EMPTY);
  });

  it("lets the user write a rule they turned down earlier, and learn it again", () => {
    const dismissed = forgetPair(saveRule(EMPTY, KUBECTL, "learned", 0), KUBECTL);
    expect(dismissed.rules).toEqual([]);

    const restored = saveRule(dismissed, KUBECTL, "manual", 1);
    expect(restored.rules).toEqual([{ ...KUBECTL, source: "manual", addedAt: 1 }]);
    expect(restored.dismissed).toEqual([]);
  });
});

describe("PendingDictations", () => {
  const DICTATED = "please check the cube control logs today";
  const SENT = "please check the kubectl logs today";

  it("gives a dictation's corrections once, to the first message it is found in", () => {
    const pending = new PendingDictations();
    pending.note(DICTATED, 0);
    expect(pending.resolve("what is for lunch", MINUTE)).toEqual([]);
    expect(pending.resolve(SENT, 2 * MINUTE)).toEqual([KUBECTL]);
    expect(pending.resolve(SENT, 3 * MINUTE)).toEqual([]);
  });

  it("drops a dictation that was not sent within 30 minutes", () => {
    const pending = new PendingDictations();
    pending.note(DICTATED, 0);
    expect(pending.resolve(SENT, 31 * MINUTE)).toEqual([]);
    expect(pending.resolve(SENT, 31 * MINUTE)).toEqual([]);
  });

  it("reports a pair once when 2 dictations in one message carry it", () => {
    const pending = new PendingDictations();
    pending.note("check the cube control logs", 0);
    pending.note("then restart cube control please", 0);
    expect(pending.resolve("check the kubectl logs then restart kubectl please", MINUTE)).toEqual([
      KUBECTL,
    ]);
  });

  it("keeps the 5 newest dictations", () => {
    const pending = new PendingDictations();
    pending.note(DICTATED, 0);
    for (let index = 0; index < 5; index += 1) pending.note(`filler dictation number ${index}`, 0);
    expect(pending.resolve(SENT, MINUTE)).toEqual([]);
  });
});
