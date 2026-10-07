import { MessageId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getMailboxConversationMessages, getMailboxThreadStatus } from "./mailboxPresentation.ts";

type ThreadStatusInput = NonNullable<Parameters<typeof getMailboxThreadStatus>[0]>;
const idle: ThreadStatusInput = {
  archivedAt: null,
  settledOverride: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  interactionMode: "default",
  latestTurn: null,
  session: null,
};
const session = {
  threadId: ThreadId.make("peer"),
  status: "running" as const,
  providerName: "Codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: TurnId.make("turn"),
  lastError: null,
  updatedAt: "2026-10-07T12:00:00.000Z",
};

describe("mailbox thread status", () => {
  it("shows blocked threads ahead of running or background work", () => {
    const working = { ...idle, session, backgroundLiveness: "working" as const };
    expect(getMailboxThreadStatus({ ...working, hasPendingApprovals: true })).toEqual({
      label: "Needs approval",
      tone: "warning",
    });
    expect(getMailboxThreadStatus({ ...working, hasPendingUserInput: true })).toEqual({
      label: "Awaiting input",
      tone: "warning",
    });
  });

  it("follows session changes from starting to working to idle", () => {
    expect(
      getMailboxThreadStatus({ ...idle, session: { ...session, status: "starting" } }).label,
    ).toBe("Starting");
    expect(getMailboxThreadStatus({ ...idle, session }).label).toBe("Working");
    expect(
      getMailboxThreadStatus({
        ...idle,
        session: { ...session, status: "ready", activeTurnId: null },
      }).label,
    ).toBe("Idle");
  });

  it("shows background work after a turn ends, and failures ahead of stale liveness", () => {
    expect(getMailboxThreadStatus({ ...idle, backgroundLiveness: "working" }).label).toBe(
      "Working",
    );
    expect(getMailboxThreadStatus({ ...idle, backgroundLiveness: "monitoring" }).label).toBe(
      "Monitoring",
    );
    expect(
      getMailboxThreadStatus({
        ...idle,
        backgroundLiveness: "working",
        session: { ...session, status: "error" },
      }),
    ).toEqual({ label: "Failed", tone: "error" });
  });

  it("distinguishes stopped sessions from idle threads", () => {
    for (const status of ["stopped", "interrupted"] as const) {
      expect(getMailboxThreadStatus({ ...idle, session: { ...session, status } }).label).toBe(
        "Stopped",
      );
    }
  });

  it("shows a completed plan needing a decision ahead of background monitoring", () => {
    const plan = {
      ...idle,
      interactionMode: "plan" as const,
      hasActionableProposedPlan: true,
      backgroundLiveness: "monitoring" as const,
      latestTurn: {
        turnId: TurnId.make("plan"),
        state: "completed" as const,
        requestedAt: "2026-10-07T12:00:00.000Z",
        startedAt: "2026-10-07T12:00:01.000Z",
        completedAt: "2026-10-07T12:00:02.000Z",
        assistantMessageId: null,
      },
    };
    expect(getMailboxThreadStatus(plan)).toEqual({ label: "Plan ready", tone: "warning" });
    expect(getMailboxThreadStatus({ ...plan, session }).label).toBe("Working");
    const failed = { ...plan, latestTurn: { ...plan.latestTurn, state: "error" as const } };
    expect(getMailboxThreadStatus(failed).label).toBe("Failed");
    expect(getMailboxThreadStatus({ ...failed, session }).label).toBe("Working");
  });

  it("identifies settled, archived, and unavailable existing links", () => {
    expect(getMailboxThreadStatus({ ...idle, settledOverride: "settled" }).label).toBe("Settled");
    expect(getMailboxThreadStatus({ ...idle, archivedAt: "2026-10-07T12:00:00.000Z" }).label).toBe(
      "Archived",
    );
    expect(getMailboxThreadStatus(undefined).label).toBe("Unavailable");
  });
});

describe("mailbox conversation", () => {
  const threadId = ThreadId.make("current");
  const peerThreadId = ThreadId.make("peer");
  const otherThreadId = ThreadId.make("other");
  const message = (
    id: string,
    fromThreadId: ThreadId,
    toThreadId: ThreadId,
    createdAt: string,
  ) => ({
    id,
    fromThreadId,
    toThreadId,
    createdAt,
    executionId: MessageId.make("sender-turn"),
    updatedAt: createdAt,
    body: id,
    replyTo: null,
    state: "queued" as const,
  });

  it("orders sent and received messages oldest first, excluding other conversations", () => {
    const messages = [
      message("reply", peerThreadId, threadId, "2026-10-07T12:01:00.000Z"),
      message("unrelated", otherThreadId, threadId, "2026-10-07T12:00:30.000Z"),
      message("request", threadId, peerThreadId, "2026-10-07T12:00:00.000Z"),
      message("foreign", peerThreadId, otherThreadId, "2026-10-07T12:00:00.000Z"),
    ];
    expect(
      getMailboxConversationMessages(messages, threadId, peerThreadId).map((entry) => entry.body),
    ).toEqual(["request", "reply"]);
    expect(messages.map((entry) => entry.id)).toEqual(["reply", "unrelated", "request", "foreign"]);
  });

  it("uses message IDs to keep equal timestamps in a stable order", () => {
    const createdAt = "2026-10-07T12:00:00.000Z";
    const messages = [
      message("b", peerThreadId, threadId, createdAt),
      message("a", threadId, peerThreadId, createdAt),
    ];
    expect(
      getMailboxConversationMessages(messages, threadId, peerThreadId).map((entry) => entry.id),
    ).toEqual(["a", "b"]);
  });
});
