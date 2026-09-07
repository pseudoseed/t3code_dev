/**
 * Derives the composer's context-window readout from a thread's activity log.
 *
 * Adapters emit `context-window.updated` activities as a turn runs, and
 * orchestration stamps the thread's running cost onto them. Clients only ever
 * care about the newest resolvable one, so this walks backwards and stops at
 * the first row with a usable `usedTokens`.
 *
 * @module contextWindow
 */
import type {
  OrchestrationThreadActivity,
  ThreadCostSource,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asCostSource(value: unknown): ThreadCostSource | null {
  return value === "providerReported" || value === "modelPriced" ? value : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const usedTokens = asFiniteNumber(payload?.usedTokens);
    if (usedTokens === null || usedTokens < 0) {
      continue;
    }

    const maxTokens = asFiniteNumber(payload?.maxTokens);
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;
    const costUsd = asFiniteNumber(payload?.costUsd);

    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload?.totalProcessedTokens),
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: asFiniteNumber(payload?.inputTokens),
      cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
      outputTokens: asFiniteNumber(payload?.outputTokens),
      reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
      lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
      sessionInputTokens: asFiniteNumber(payload?.sessionInputTokens),
      sessionCachedInputTokens: asFiniteNumber(payload?.sessionCachedInputTokens),
      sessionCacheCreationTokens: asFiniteNumber(payload?.sessionCacheCreationTokens),
      sessionOutputTokens: asFiniteNumber(payload?.sessionOutputTokens),
      // A provider's own session total is server bookkeeping, not the thread
      // figure: a thread outlives its sessions. Only `costUsd` is displayable.
      sessionCostUsd: null,
      // Zero here means "not known", not "free".
      costUsd: costUsd !== null && costUsd > 0 ? costUsd : null,
      costSource: asCostSource(payload?.costSource),
      toolUses: asFiniteNumber(payload?.toolUses),
      durationMs: asFiniteNumber(payload?.durationMs),
      compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
      autoCompactThreshold: asFiniteNumber(payload?.autoCompactThreshold),
      updatedAt: activity.createdAt,
    };
  }

  return null;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/**
 * Percentage of the window in use, as the composer prints it.
 *
 * Under 10% keeps one decimal so a long thread's early growth is visible;
 * above that a whole number is enough and stays a stable width.
 */
export function formatContextWindowPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

/**
 * Formats a running thread cost for a space-constrained control.
 *
 * Sub-cent totals round up to `<$0.01` rather than to `$0.00`, which would
 * read as "this turn was free". Past a dollar the cents stop mattering next to
 * the number itself, so four figures drop them entirely.
 */
export function formatThreadCostUsd(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value < 0.01) {
    return "<$0.01";
  }
  if (value < 1000) {
    return `$${value.toFixed(2)}`;
  }
  return `$${Math.round(value).toLocaleString("en-US")}`;
}
