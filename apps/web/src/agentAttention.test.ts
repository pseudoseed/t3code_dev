import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createAgentAttentionTracker } from "./agentAttention";

const thread = {
  id: ThreadId.make("thread-1"),
  title: "Fix staging",
  archivedAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
};

describe("agent attention transitions", () => {
  it("does not replay pending requests on startup or reconnect", () => {
    const track = createAgentAttentionTracker();
    const pending = { ...thread, hasPendingUserInput: true };
    expect(track([pending], false)).toEqual([]);
    expect(track([pending], true)).toEqual([]);
    expect(track([thread], true)).toEqual([]);
    expect(track([thread], false)).toEqual([]);
    expect(track([pending], true)).toEqual([]);
  });

  it("alerts once on input, ignores unrelated changes, and alerts again after resolution", () => {
    const track = createAgentAttentionTracker();
    const pending = { ...thread, hasPendingUserInput: true };
    track([thread], true);
    expect(track([pending], true)).toEqual([
      { threadId: thread.id, title: thread.title, kind: "input" },
    ]);
    expect(track([{ ...pending, title: "Updated title" }], true)).toEqual([]);
    expect(track([thread], true)).toEqual([]);
    expect(track([pending], true)).toHaveLength(1);
  });

  it("does not re-alert on input when an overlapping approval clears", () => {
    const track = createAgentAttentionTracker();
    track([thread], true);
    expect(
      track([{ ...thread, hasPendingApprovals: true, hasPendingUserInput: true }], true),
    ).toEqual([{ threadId: thread.id, title: thread.title, kind: "approval" }]);
    expect(track([{ ...thread, hasPendingUserInput: true }], true)).toEqual([]);
  });

  it("detects new input while an approval is already pending", () => {
    const track = createAgentAttentionTracker();
    track([{ ...thread, hasPendingApprovals: true }], true);
    expect(
      track([{ ...thread, hasPendingApprovals: true, hasPendingUserInput: true }], true),
    ).toEqual([{ threadId: thread.id, title: thread.title, kind: "input" }]);
  });

  it("alerts for threads created after the live baseline", () => {
    const track = createAgentAttentionTracker();
    track([], true);
    expect(track([{ ...thread, hasPendingApprovals: true }], true)).toEqual([
      { threadId: thread.id, title: thread.title, kind: "approval" },
    ]);
  });

  it("ignores archived requests and forgets deleted threads", () => {
    const track = createAgentAttentionTracker();
    track([thread], true);
    expect(
      track([{ ...thread, hasPendingUserInput: true, archivedAt: "2026-09-06T00:00:00Z" }], true),
    ).toEqual([]);
    expect(track([], true)).toEqual([]);
    expect(track([{ ...thread, hasPendingUserInput: true }], true)).toHaveLength(1);
  });

  it("keeps identical thread IDs on different environments independent", () => {
    const first = createAgentAttentionTracker();
    const second = createAgentAttentionTracker();
    first([thread], true);
    second([thread], true);
    expect(first([{ ...thread, hasPendingUserInput: true }], true)).toHaveLength(1);
    expect(second([{ ...thread, hasPendingUserInput: true }], true)).toHaveLength(1);
  });
});
