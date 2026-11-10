import { expect, it } from "vite-plus/test";

import { recommendedDictationModel } from "./dictationModels";

const GB = 1_000_000_000;

it.each([
  { memory: 8 * GB, locale: "en-US", expected: "parakeet-110m" },
  { memory: 8 * GB, locale: "de-DE", expected: "parakeet-v3" },
  // A "4 GB" iPhone reports a little under 4 GiB; a "3 GB" one must stay on Apple's recognizer.
  { memory: 3.7 * GB, locale: "en_GB", expected: "parakeet-110m" },
  { memory: 3.7 * GB, locale: "fr-FR", expected: "parakeet-v3" },
  { memory: 2.9 * GB, locale: "en-US", expected: "apple" },
  { memory: 2.9 * GB, locale: "fr-FR", expected: "apple" },
])(
  "suggests $expected for $locale with $memory bytes of memory",
  ({ memory, locale, expected }) => {
    expect(recommendedDictationModel({ physicalMemoryBytes: memory, locale })).toBe(expected);
  },
);
