import { expect, it } from "vite-plus/test";

import { removeFillers, usesEnglish } from "./textCleanup";

it.each([
  ["Um, I think we should ship.", "I think we should ship."],
  ["I think, um, we should ship.", "I think, we should ship."],
  ["We should ship, uh.", "We should ship."],
  ["Uh, hello. Um, world", "Hello. World"],
  ["So uh the build is um broken", "So the build is broken"],
  ["Um.", ""],
  ["Done. Um. Next step.", "Done. Next step."],
  ["The umbrella can hum", "The umbrella can hum"],
  ["UM is in Ann Arbor", "UM is in Ann Arbor"],
  ["The ER was full", "The ER was full"],
])("removeFillers(%j)", (text, expected) => {
  expect(removeFillers(text)).toBe(expected);
});

it.each([
  ["en", true],
  ["en-US", true],
  ["en_GB", true],
  ["EN-au", true],
  ["de-DE", false],
  ["enm", false],
])("usesEnglish(%j) is %j", (locale, expected) => {
  expect(usesEnglish(locale)).toBe(expected);
});
