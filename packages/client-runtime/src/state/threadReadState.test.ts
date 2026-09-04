import { describe, expect, it } from "vite-plus/test";
import { TurnId } from "@t3tools/contracts";

import {
  threadHasUnreadCompletion,
  threadNeedsViewRecord,
  type ThreadReadStateShell,
} from "./threadReadState.ts";

const COMPLETED_AT = "2026-01-02T00:00:00.000Z";

function shell(input: {
  readonly completedAt?: string | null;
  readonly lastViewedAt?: string | null;
}): ThreadReadStateShell {
  const completedAt = input.completedAt === undefined ? COMPLETED_AT : input.completedAt;
  return {
    latestTurn:
      completedAt === null
        ? {
            turnId: TurnId.make("turn-1"),
            state: "running",
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: null,
            assistantMessageId: null,
          }
        : {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt,
            assistantMessageId: null,
          },
    ...(input.lastViewedAt === undefined ? {} : { lastViewedAt: input.lastViewedAt }),
  };
}

describe("threadHasUnreadCompletion", () => {
  it("marks a turn that completed after the last recorded view", () => {
    expect(threadHasUnreadCompletion(shell({ lastViewedAt: "2026-01-01T12:00:00.000Z" }))).toBe(
      true,
    );
  });

  it("clears once a view lands after the completion", () => {
    expect(threadHasUnreadCompletion(shell({ lastViewedAt: "2026-01-03T00:00:00.000Z" }))).toBe(
      false,
    );
  });

  it("treats a never-viewed thread as seen, so adopting read state lights up nothing", () => {
    expect(threadHasUnreadCompletion(shell({ lastViewedAt: null }))).toBe(false);
  });

  it("ignores a turn that is still running", () => {
    expect(
      threadHasUnreadCompletion(
        shell({ completedAt: null, lastViewedAt: "2026-01-01T00:00:00.000Z" }),
      ),
    ).toBe(false);
  });

  it("prefers the server's read state over this device's record", () => {
    // Read on another device after the completion: the local record is stale.
    expect(
      threadHasUnreadCompletion(shell({ lastViewedAt: "2026-01-03T00:00:00.000Z" }), {
        localLastViewedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("falls back to the device record only when the server omits the field", () => {
    expect(
      threadHasUnreadCompletion(shell({}), { localLastViewedAt: "2026-01-01T00:00:00.000Z" }),
    ).toBe(true);
  });

  it("shows a completion the user has not seen when stored read state is corrupt", () => {
    expect(threadHasUnreadCompletion(shell({ lastViewedAt: "not-a-date" }))).toBe(true);
  });
});

describe("threadNeedsViewRecord", () => {
  it("records the first view of a thread, which is what arms the indicator", () => {
    expect(threadNeedsViewRecord(shell({ lastViewedAt: null }))).toBe(true);
  });

  it("records again once a newer turn completes", () => {
    expect(threadNeedsViewRecord(shell({ lastViewedAt: "2026-01-01T12:00:00.000Z" }))).toBe(true);
  });

  it("writes nothing when re-opening an already-read thread", () => {
    expect(threadNeedsViewRecord(shell({ lastViewedAt: "2026-01-03T00:00:00.000Z" }))).toBe(false);
  });

  it("writes nothing while a turn is still streaming", () => {
    expect(
      threadNeedsViewRecord(shell({ completedAt: null, lastViewedAt: "2026-01-01T00:00:00.000Z" })),
    ).toBe(false);
  });
});
