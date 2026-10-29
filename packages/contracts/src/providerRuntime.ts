import { UsageTokenTotals } from "./usage.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

const RuntimeTurnState = Schema.Literals(["completed", "failed", "interrupted", "cancelled"]);
export type RuntimeTurnState = typeof RuntimeTurnState.Type;

const RuntimeItemStatus = Schema.Literals(["inProgress", "completed", "failed", "declined"]);
export type RuntimeItemStatus = typeof RuntimeItemStatus.Type;

const TOOL_LIFECYCLE_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view",
] as const;

export const ToolLifecycleItemType = Schema.Literals(TOOL_LIFECYCLE_ITEM_TYPES);
export type ToolLifecycleItemType = typeof ToolLifecycleItemType.Type;

export function isToolLifecycleItemType(value: string): value is ToolLifecycleItemType {
  return TOOL_LIFECYCLE_ITEM_TYPES.includes(value as ToolLifecycleItemType);
}

/**
 * `UsageCostSource` minus `unpriced`: a thread with no usable cost omits `costUsd` rather than
 * carrying a zero that reads as free.
 */
export const ThreadCostSource = Schema.Literals(["providerReported", "modelPriced"]);
export type ThreadCostSource = typeof ThreadCostSource.Type;

export const ThreadTokenUsageSnapshot = Schema.Struct({
  usedTokens: NonNegativeInt,
  totalProcessedTokens: Schema.optional(NonNegativeInt),
  maxTokens: Schema.optional(PositiveInt),
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningOutputTokens: Schema.optional(NonNegativeInt),
  lastUsedTokens: Schema.optional(NonNegativeInt),
  lastInputTokens: Schema.optional(NonNegativeInt),
  lastCachedInputTokens: Schema.optional(NonNegativeInt),
  lastOutputTokens: Schema.optional(NonNegativeInt),
  lastReasoningOutputTokens: Schema.optional(NonNegativeInt),
  toolUses: Schema.optional(NonNegativeInt),
  durationMs: Schema.optional(NonNegativeInt),
  compactsAutomatically: Schema.optional(Schema.Boolean),
  autoCompactThreshold: Schema.optional(PositiveInt),
  /**
   * Session-cumulative billed tokens from providers that report running totals (Codex), including
   * cached and cache-creation input. A drop means the session restarted; orchestration carries the
   * earlier session's cost forward.
   */
  pendingCostTokens: Schema.optional(Schema.Record(Schema.String, UsageTokenTotals)),
  costRevision: Schema.optional(NonNegativeInt),
  costSessionId: Schema.optional(Schema.String),
  sessionInputTokens: Schema.optional(NonNegativeInt),
  sessionCachedInputTokens: Schema.optional(NonNegativeInt),
  sessionCacheCreationTokens: Schema.optional(NonNegativeInt),
  sessionOutputTokens: Schema.optional(NonNegativeInt),
  /**
   * Provider-reported session total in USD, not per turn (Claude's result carries the session total
   * beside per-turn usage), so orchestration charges the increase between snapshots.
   */
  sessionCostUsd: Schema.optional(Schema.Number),
  /**
   * Running USD cost for the whole thread, stamped by orchestration rather
   * than by an adapter. It is API-equivalent cost, not money spent: a
   * subscription plan bills separately. Absent when no cost is knowable.
   */
  costUsd: Schema.optional(Schema.Number),
  costSource: Schema.optional(ThreadCostSource),
  cost: Schema.optional(
    Schema.Struct({
      amount: Schema.Number.check(Schema.isFinite()),
      currency: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(32)),
    }),
  ),
});
export type ThreadTokenUsageSnapshot = typeof ThreadTokenUsageSnapshot.Type;

// Input includes cache reads/writes; output includes the optional reasoningTokens subset.
const TurnTokenUsageCommonFields = {
  usageScope: Schema.Literal("main_agent"),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  cacheCreationTokens: Schema.optional(NonNegativeInt),
  reasoningTokens: Schema.optional(NonNegativeInt),
  hasSubagents: Schema.Boolean,
};
export const TurnTokenUsage = Schema.Union([
  Schema.Struct({
    ...TurnTokenUsageCommonFields,
    usageStatus: Schema.Literal("complete"),
    inputTokens: NonNegativeInt,
    outputTokens: NonNegativeInt,
  }),
  Schema.Struct({
    ...TurnTokenUsageCommonFields,
    usageStatus: Schema.Literals(["partial", "unavailable"]),
    inputTokens: Schema.optional(NonNegativeInt),
    outputTokens: Schema.optional(NonNegativeInt),
  }),
]);
export type TurnTokenUsage = typeof TurnTokenUsage.Type;

export const ToolActivitySurface = Schema.Literals(["browser", "computer"]);
export type ToolActivitySurface = typeof ToolActivitySurface.Type;

export const ToolActivityNativeAppReference = Schema.Union([
  Schema.TaggedStruct("app-id", {
    appId: TrimmedNonEmptyStringSchema.check(
      Schema.isMaxLength(512),
      Schema.isPattern(/^[A-Za-z0-9._-]+$/u),
    ),
  }),
  Schema.TaggedStruct("display-name", {
    displayName: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(160)),
  }),
]);
export type ToolActivityNativeAppReference = typeof ToolActivityNativeAppReference.Type;

export const ToolActivityIcon = Schema.Union([
  Schema.TaggedStruct("website", {
    pageUrl: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096)),
    faviconUrl: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096))),
    faviconUrlDark: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096))),
  }),
  Schema.TaggedStruct("native-app", {
    app: ToolActivityNativeAppReference,
  }),
  Schema.TaggedStruct("themed-logo", {
    logoUrl: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096)),
    logoUrlDark: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096))),
  }),
]);
export type ToolActivityIcon = typeof ToolActivityIcon.Type;

export const ToolActivitySource = Schema.Struct({
  key: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(512)),
  name: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(160)),
  kind: Schema.Literals(["browser", "computer", "integration"]),
  icon: Schema.optional(ToolActivityIcon),
});
export type ToolActivitySource = typeof ToolActivitySource.Type;

const UserInputQuestionOption = Schema.Struct({
  label: TrimmedNonEmptyStringSchema,
  description: Schema.String,
  value: Schema.optional(Schema.String),
});

export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  header: TrimmedNonEmptyStringSchema,
  question: TrimmedNonEmptyStringSchema,
  options: Schema.Array(UserInputQuestionOption),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  initialAnswer: Schema.optional(Schema.String),
  multiSelect: Schema.optional(Schema.Boolean).pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
});
export type UserInputQuestion = typeof UserInputQuestion.Type;

/** Claude reports activation deltas; Codex reports cumulative totals. Merge per provider in client-runtime. */
export const RuntimeTaskUsage = Schema.Struct({
  totalTokens: NonNegativeInt,
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningOutputTokens: Schema.optional(NonNegativeInt),
  toolUses: Schema.optional(NonNegativeInt),
  durationMs: Schema.optional(NonNegativeInt),
});
export type RuntimeTaskUsage = typeof RuntimeTaskUsage.Type;

export const TaskWorkflowPhase = Schema.Struct({
  index: NonNegativeInt,
  title: TrimmedNonEmptyStringSchema,
});
export type TaskWorkflowPhase = typeof TaskWorkflowPhase.Type;

export const TaskRunHandles = Schema.Struct({
  runId: Schema.optional(TrimmedNonEmptyStringSchema),
  scriptPath: Schema.optional(TrimmedNonEmptyStringSchema),
  transcriptDir: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Only http/https URLs, sanitized by the adapter. */
  sessionUrl: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TaskRunHandles = typeof TaskRunHandles.Type;

// Repeat on progress and terminal rows so agents survive start-row eviction.
const taskAgentLinkageFields = {
  taskType: Schema.optional(TrimmedNonEmptyStringSchema),
  agentKind: Schema.optional(Schema.Literals(["agent", "background"])),
  agentId: Schema.optional(TrimmedNonEmptyStringSchema),
  title: Schema.optional(TrimmedNonEmptyStringSchema),
  role: Schema.optional(TrimmedNonEmptyStringSchema),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  effort: Schema.optional(TrimmedNonEmptyStringSchema),
  toolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
  parentAgentId: Schema.optional(TrimmedNonEmptyStringSchema),
  workflowName: Schema.optional(TrimmedNonEmptyStringSchema),
  agentIndex: Schema.optional(NonNegativeInt),
  phaseIndex: Schema.optional(NonNegativeInt),
  phaseTitle: Schema.optional(TrimmedNonEmptyStringSchema),
  phases: Schema.optional(Schema.Array(TaskWorkflowPhase)),
  attempt: Schema.optional(NonNegativeInt),
  runHandles: Schema.optional(TaskRunHandles),
  outputFile: Schema.optional(TrimmedNonEmptyStringSchema),
  agentPath: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Provider-synthesized child events belong in Agents, never the parent timeline. */
  timelineBypass: Schema.optional(Schema.Boolean),
} as const;

export const TaskAgentLinkage = Schema.Struct(taskAgentLinkageFields);
export type TaskAgentLinkage = typeof TaskAgentLinkage.Type;
