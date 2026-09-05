import { describe, expect, it } from "vite-plus/test";

import { aiUsageStatusToAccounts } from "./aiUsageDashboard.ts";

const checkedAt = "2026-09-04T23:40:00.000Z";

// Trimmed from a live `/api/usage`: a healthy Claude account with a scoped
// weekly bucket, a Codex account banking reset credits, and a Claude account
// the dashboard has parked after repeated failures.
const status = {
  companies: [
    {
      key: "claude",
      label: "Claude",
      accounts: [
        {
          id: "claude",
          provider: "claude",
          label: "aws",
          ok: true,
          account: "primary@example.com",
          plan: "Max 20x",
          fetched_at: "2026-09-04T23:33:03.434105+00:00",
          meters: [
            {
              id: "session",
              name: "Session (5h)",
              group: "session",
              percent: 10,
              resets_at: "2026-09-05T01:00:00.384734+00:00",
            },
            {
              id: "weekly_all",
              name: "Weekly (all models)",
              group: "weekly",
              percent: 2,
              resets_at: "2026-09-11T00:00:00.384753+00:00",
            },
            {
              id: "weekly_scoped:Weekly (Fable)",
              name: "Weekly (Fable)",
              group: "weekly",
              percent: 0,
              resets_at: null,
            },
          ],
        },
        {
          id: "claude-shopping",
          provider: "claude",
          label: "shopping",
          ok: false,
          inactive: "auto",
          meters: [],
        },
      ],
    },
    {
      key: "codex",
      label: "Codex",
      accounts: [
        {
          id: "codex",
          provider: "codex",
          label: "Shopping",
          ok: true,
          plan: "ChatGPT Plus",
          reset_credits: 3,
          meters: [
            {
              id: "primary",
              name: "Session (5h)",
              group: "session",
              percent: 0,
              resets_at: "2026-09-05T04:33:02+00:00",
            },
            { id: "extra0", name: "Limit 1", group: "other", percent: 0, resets_at: null },
          ],
        },
      ],
    },
    // The dashboard also polls Gemini and Grok; a company whose provider has
    // no driver here must be skipped rather than guessed at.
    {
      key: "mystery",
      accounts: [{ id: "mystery", provider: "somethingelse", meters: [] }],
    },
  ],
};

describe("aiUsageStatusToAccounts", () => {
  it("maps each polled account onto the windows the provider drivers use", () => {
    const accounts = aiUsageStatusToAccounts(status, checkedAt);

    expect(accounts.map((account) => account.id)).toEqual(["claude", "claude-shopping", "codex"]);

    const aws = accounts[0]!;
    expect(aws.driver).toBe("claudeAgent");
    expect(aws.label).toBe("aws");
    expect(aws.email).toBe("primary@example.com");
    expect(aws.plan).toBe("Max 20x");
    // Windows sort session-first, and the dashboard's own poll time is kept
    // rather than the moment this environment read it.
    expect(aws.usageLimits.checkedAt).toBe("2026-09-04T23:33:03.434Z");
    expect(aws.usageLimits.windows.map((window) => [window.id, window.kind])).toEqual([
      ["session", "session"],
      ["weekly_all", "weekly"],
      ["weekly_scoped:Weekly (Fable)", "weekly"],
    ]);
    expect(aws.usageLimits.windows[0]).toMatchObject({
      label: "Session (5h)",
      usedPercent: 10,
      windowDurationMins: 300,
      resetsAt: "2026-09-05T01:00:00.384Z",
    });
    // A meter with no reset carries no countdown rather than a bogus one.
    expect(aws.usageLimits.windows[2]?.resetsAt).toBeUndefined();
  });

  it("keeps a parked account as a row that says it cannot report", () => {
    const parked = aiUsageStatusToAccounts(status, checkedAt)[1]!;
    expect(parked.usageLimits.windows).toEqual([]);
    expect(parked.usageLimits.unavailable).toEqual({
      reason: "unsupported",
      message: "Parked by the dashboard.",
    });
  });

  it("carries banked reset credits so the card can offer to spend one", () => {
    const codex = aiUsageStatusToAccounts(status, checkedAt)[2]!;
    expect(codex.driver).toBe("codex");
    expect(codex.usageLimits.resetCredits).toEqual({ availableCount: 3 });
    // `other` has no fixed length, so it must not claim one.
    expect(codex.usageLimits.windows.at(-1)).toMatchObject({
      id: "extra0",
      kind: "other",
    });
    expect(codex.usageLimits.windows.at(-1)?.windowDurationMins).toBeUndefined();
  });

  it("omits reset credits when the account has none banked", () => {
    const [account] = aiUsageStatusToAccounts(
      {
        companies: [
          {
            key: "codex",
            accounts: [
              {
                id: "codex",
                provider: "codex",
                reset_credits: 0,
                meters: [{ id: "primary", name: "Session", group: "session", percent: 4 }],
              },
            ],
          },
        ],
      },
      checkedAt,
    );
    expect(account?.usageLimits.resetCredits).toBeUndefined();
  });
});
