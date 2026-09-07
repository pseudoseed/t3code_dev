import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowPercentage,
  formatThreadCostUsd,
} from "./contextWindow.ts";

function makeActivity(id: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-09-07T00:00:00.000Z",
  };
}

describe("deriveLatestContextWindowSnapshot cost", () => {
  it("carries the running cost the server stamped", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", {
        usedTokens: 79_062,
        maxTokens: 1_000_000,
        costUsd: 1.2345,
        costSource: "providerReported",
      }),
    ]);

    expect(snapshot?.costUsd).toBe(1.2345);
    expect(snapshot?.costSource).toBe("providerReported");
  });

  it("treats a zero or malformed cost as unknown rather than free", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", { usedTokens: 100, costUsd: 0, costSource: "guessed" }),
    ]);

    expect(snapshot?.costUsd).toBeNull();
    expect(snapshot?.costSource).toBeNull();
  });

  it("never reports a provider's session total as the thread total", () => {
    // A thread outlives its provider sessions, so only the figure the server
    // accumulated across them is displayable.
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", { usedTokens: 100, sessionCostUsd: 9.99 }),
    ]);

    expect(snapshot?.sessionCostUsd).toBeNull();
    expect(snapshot?.costUsd).toBeNull();
  });
});

describe("formatContextWindowPercentage", () => {
  it("keeps a decimal below ten percent and rounds above it", () => {
    expect(formatContextWindowPercentage(7.91)).toBe("7.9%");
    expect(formatContextWindowPercentage(35.4)).toBe("35%");
  });

  it("drops a trailing zero decimal", () => {
    expect(formatContextWindowPercentage(8)).toBe("8%");
  });

  it("has nothing to print without a known window", () => {
    expect(formatContextWindowPercentage(null)).toBeNull();
  });
});

describe("formatThreadCostUsd", () => {
  it("never rounds a real cost down to zero", () => {
    expect(formatThreadCostUsd(0.004)).toBe("<$0.01");
  });

  it("shows cents up to a thousand dollars and drops them past it", () => {
    expect(formatThreadCostUsd(1.239)).toBe("$1.24");
    expect(formatThreadCostUsd(1234.56)).toBe("$1,235");
  });

  it("has nothing to print when no cost is known", () => {
    expect(formatThreadCostUsd(null)).toBeNull();
    expect(formatThreadCostUsd(0)).toBeNull();
  });
});
