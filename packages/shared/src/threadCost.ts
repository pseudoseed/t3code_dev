import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";

// Provider status snapshots can have been captured before the latest usage event.
// Keep the persisted accounting baseline so replay or a reconnect cannot bill twice.
export function preserveThreadCost(
  previous: ThreadTokenUsageSnapshot | null | undefined,
  next: ThreadTokenUsageSnapshot | null | undefined,
): ThreadTokenUsageSnapshot | null | undefined {
  if (
    previous === null ||
    previous === undefined ||
    (previous.costRevision === undefined && previous.costUsd === undefined) ||
    (next?.costRevision ?? -1) > (previous.costRevision ?? 0)
  )
    return next;
  return {
    ...(next ?? previous),
    pendingCostTokens: previous.pendingCostTokens,
    costRevision: previous.costRevision,
    costSessionId: previous.costSessionId,
    costUsd: previous.costUsd,
    costSource: previous.costSource,
    sessionCostUsd: previous.sessionCostUsd,
    sessionInputTokens: previous.sessionInputTokens,
    sessionCachedInputTokens: previous.sessionCachedInputTokens,
    sessionCacheCreationTokens: previous.sessionCacheCreationTokens,
    sessionOutputTokens: previous.sessionOutputTokens,
  };
}
