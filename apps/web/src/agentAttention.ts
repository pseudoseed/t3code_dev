import type { OrchestrationThreadShell } from "@t3tools/contracts";

type AttentionThread = Pick<
  OrchestrationThreadShell,
  "id" | "title" | "archivedAt" | "hasPendingApprovals" | "hasPendingUserInput"
>;

export type AgentAttentionRequest = {
  readonly threadId: OrchestrationThreadShell["id"];
  readonly title: string;
  readonly kind: "approval" | "input";
};

/** One tracker per environment. Hydration/reconnection establishes a silent
 * baseline; only new requests in a live stream produce alerts. */
export function createAgentAttentionTracker() {
  let previous: Map<string, AttentionThread> | null = null;
  return (threads: readonly AttentionThread[], live: boolean): AgentAttentionRequest[] => {
    if (!live) {
      previous = null;
      return [];
    }
    const next = new Map(threads.map((thread) => [thread.id, thread]));
    const requests: AgentAttentionRequest[] = [];
    if (previous !== null) {
      for (const thread of threads) {
        if (thread.archivedAt !== null) continue;
        const before = previous.get(thread.id);
        const approval = thread.hasPendingApprovals && !before?.hasPendingApprovals;
        const input = thread.hasPendingUserInput && !before?.hasPendingUserInput;
        if (approval || input) {
          requests.push({
            threadId: thread.id,
            title: thread.title,
            kind: approval ? "approval" : "input",
          });
        }
      }
    }
    previous = next;
    return requests;
  };
}
