import { describe, expect, it } from "vite-plus/test";

import { resetOutcomeOf } from "./UsageLimitSources.ts";

describe("resetOutcomeOf", () => {
  it("passes through the outcomes Codex names", () => {
    expect(resetOutcomeOf("reset")).toBe("reset");
    expect(resetOutcomeOf("noCredit")).toBe("noCredit");
    expect(resetOutcomeOf("alreadyRedeemed")).toBe("alreadyRedeemed");
  });

  it("reads an outcome the vendor spelled differently or nested", () => {
    expect(resetOutcomeOf("nothing_to_reset")).toBe("nothingToReset");
    expect(resetOutcomeOf("NOTHINGTORESET")).toBe("nothingToReset");
    expect(resetOutcomeOf({ outcome: "no-credit" })).toBe("noCredit");
  });

  it("reads an unnameable answer as a spent credit rather than a failure", () => {
    // The dashboard only replies at all once the vendor returned 200 on a
    // balance it had already checked, so silence here means it worked.
    expect(resetOutcomeOf(undefined)).toBe("reset");
    expect(resetOutcomeOf({ status: "ok" })).toBe("reset");
    expect(resetOutcomeOf("something new")).toBe("reset");
  });
});
