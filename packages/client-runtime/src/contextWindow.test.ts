import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import {
  deriveLatestContextWindowSnapshot,
  deriveThreadCostSnapshot,
  formatContextWindowPercentage,
  formatThreadCostUsd,
} from "./contextWindow.ts";

const updatedAt = DateTime.makeUnsafe("2026-09-07T00:00:00.000Z");

describe("deriveLatestContextWindowSnapshot cost", () => {
  it("carries accumulated thread cost alongside live context usage", () => {
    const snapshot = deriveLatestContextWindowSnapshot(
      [],
      {
        usedTokens: 79_062,
        maxTokens: 1_000_000,
        updatedAt: DateTime.formatIso(updatedAt),
      },
      {
        contextUsage: { usedTokens: 10, costUsd: 1.2345, costSource: "providerReported" },
        updatedAt,
      },
    );
    expect(snapshot).toMatchObject({
      usedTokens: 79_062,
      costUsd: 1.2345,
      costSource: "providerReported",
    });
  });

  it("treats a zero cost as unknown rather than free", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], undefined, {
      contextUsage: { usedTokens: 100, costUsd: 0 },
      updatedAt,
    });
    expect(snapshot?.costUsd).toBeNull();
  });

  it("never reports a provider session total as the thread total", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], undefined, {
      contextUsage: { usedTokens: 100, sessionCostUsd: 9.99 },
      updatedAt,
    });
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

describe("whole-thread cost across providers", () => {
  it("adds the imported baseline once and includes inactive providers", () => {
    expect(
      deriveThreadCostSnapshot({ usedTokens: 0, costUsd: 3, costSource: "providerReported" }, [
        { contextUsage: { usedTokens: 100, costUsd: 2, costSource: "providerReported" } },
        { contextUsage: { usedTokens: 200, costUsd: 1, costSource: "modelPriced" } },
      ]),
    ).toEqual({ costUsd: 6, costSource: "modelPriced" });
  });
  it("keeps unknown or invalid costs out of the total", () => {
    expect(
      deriveThreadCostSnapshot(null, [{ contextUsage: { usedTokens: 0, costUsd: NaN } }]),
    ).toEqual({ costUsd: null, costSource: null });
  });
});
