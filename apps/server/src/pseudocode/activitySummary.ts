import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";

export const SUMMARY_INTERVAL_MS = 90_000;

/** Only the current turn is evidence; tool payloads and transcripts stay on the host. */
export function activitySummaryContext(input: {
  state: AgentAwarenessState;
  turnId: string | null;
  activities: ReadonlyArray<{ turnId: string | null; kind: string; summary: string }>;
  assistantText?: string | undefined;
}): string {
  return JSON.stringify({
    thread: input.state.threadTitle.slice(0, 160),
    status: input.state.phase,
    error: input.state.detail?.slice(0, 160),
    latestAssistantUpdate: input.assistantText?.slice(-2400),
    recentActivity: input.activities
      .filter((row) => row.turnId === input.turnId)
      .slice(-8)
      .map((row) => ({ kind: row.kind, description: row.summary.slice(0, 350) })),
  });
}
