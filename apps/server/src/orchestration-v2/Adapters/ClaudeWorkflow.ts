import type {
  OrchestrationV2SubagentTaskMetadata,
  RuntimeTaskStatus,
  TaskRunHandles,
} from "@t3tools/contracts";

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

const WORKFLOW_PHASE_CAP = 64;
const WORKFLOW_AGENT_CAP = 100;

interface ClaudeWorkflowAgentEntry {
  readonly index: number;
  readonly state: string;
  readonly label: string | undefined;
  readonly phaseIndex: number | undefined;
  readonly phaseTitle: string | undefined;
  readonly model: string | undefined;
  readonly attempt: number | undefined;
  readonly lastToolName: string | undefined;
  readonly startedAt: string | undefined;
  readonly error: string | undefined;
  readonly tokens: number | undefined;
  readonly toolCalls: number | undefined;
}

interface ClaudeWorkflowProgress {
  readonly phases: ReadonlyArray<{ index: number; title: string }>;
  readonly agents: ReadonlyArray<ClaudeWorkflowAgentEntry>;
}

/**
 * Defensive parse of the SDK's undeclared-but-real workflow_progress array on
 * task_progress messages (wire-confirmed; absent from sdk.d.ts). Unknown
 * shapes are skipped per-entry; phases and agents dedupe by index before
 * caps; a vanished field never throws. If the array disappears upstream the
 * caller keeps the coordinator row and plain task lifecycle.
 */
export function parseWorkflowProgress(value: unknown): ClaudeWorkflowProgress | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const phasesByIndex = new Map<number, string>();
  const agentsByIndex = new Map<number, ClaudeWorkflowAgentEntry>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const entryType = trimmedString(record.type);
    if (entryType === "workflow_phase") {
      const index = nonNegativeInt(record.index);
      const title = trimmedString(record.title);
      if (index !== undefined && title && !phasesByIndex.has(index)) {
        phasesByIndex.set(index, title);
      }
      continue;
    }
    if (entryType !== "workflow_agent") {
      continue;
    }
    const index = nonNegativeInt(record.index);
    const state = trimmedString(record.state);
    if (index === undefined || !state || agentsByIndex.has(index)) {
      continue;
    }
    agentsByIndex.set(index, {
      index,
      state,
      label: trimmedString(record.label),
      phaseIndex: nonNegativeInt(record.phaseIndex),
      phaseTitle: trimmedString(record.phaseTitle),
      model: trimmedString(record.model),
      attempt: nonNegativeInt(record.attempt),
      lastToolName: trimmedString(record.lastToolName),
      startedAt: trimmedString(record.startedAt),
      error: trimmedString(record.error),
      tokens: nonNegativeInt(record.tokens),
      toolCalls: nonNegativeInt(record.toolCalls),
    });
  }
  if (phasesByIndex.size === 0 && agentsByIndex.size === 0) {
    return undefined;
  }
  const phases = Array.from(phasesByIndex.entries())
    .map(([index, title]) => ({ index, title }))
    .toSorted((a, b) => a.index - b.index)
    .slice(0, WORKFLOW_PHASE_CAP);
  const agents = Array.from(agentsByIndex.values())
    .toSorted((a, b) => a.index - b.index)
    .slice(0, WORKFLOW_AGENT_CAP);
  return { phases, agents };
}

/**
 * Workflow member states from workflow_progress → shared task status.
 * Unknown states read running after startedAt, pending before it.
 */
export function workflowAgentStatus(entry: ClaudeWorkflowAgentEntry): RuntimeTaskStatus {
  switch (entry.state) {
    case "queued":
    case "pending":
      return "pending";
    case "start":
    case "running":
      return entry.startedAt === undefined ? "pending" : "running";
    case "done":
      return "completed";
    case "error":
      return "failed";
    default:
      return entry.startedAt === undefined ? "pending" : "running";
  }
}

export function workflowRunHandles(
  value: unknown,
): { taskId: string; handles: TaskRunHandles } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const taskId = trimmedString(record.taskId);
  if (!taskId) return undefined;
  const handles: {
    runId?: string;
    scriptPath?: string;
    transcriptDir?: string;
    sessionUrl?: string;
  } = {};
  for (const key of ["runId", "scriptPath", "transcriptDir"] as const) {
    const value = trimmedString(record[key]);
    if (value) handles[key] = value;
  }
  const sessionUrl = trimmedString(record.sessionUrl);
  if (sessionUrl) {
    try {
      const url = new URL(sessionUrl);
      if (url.protocol === "https:" || url.protocol === "http:")
        handles.sessionUrl = url.toString();
    } catch {
      /* Untrusted provider output may omit a usable session URL. */
    }
  }
  return Object.keys(handles).length > 0 ? { taskId, handles } : undefined;
}

export function claudeTaskMetadata(message: unknown): OrchestrationV2SubagentTaskMetadata {
  if (message === null || typeof message !== "object") return {};
  const record = message as Record<string, unknown>;
  const workflowName = trimmedString(record.workflow_name);
  const role = trimmedString(record.subagent_type);
  const lastToolName = trimmedString(record.last_tool_name);
  const outputFile = trimmedString(record.output_file);
  const progress = parseWorkflowProgress(record.workflow_progress);
  const taskType = trimmedString(record.task_type) ?? (progress ? "local_workflow" : undefined);
  const usage =
    record.usage !== null && typeof record.usage === "object"
      ? (record.usage as Record<string, unknown>)
      : {};
  const totalTokens = nonNegativeInt(usage.total_tokens);
  const toolUses = nonNegativeInt(usage.tool_uses);
  const durationMs = nonNegativeInt(usage.duration_ms);
  return {
    ...(taskType ? { taskType } : {}),
    ...(workflowName ? { workflowName } : {}),
    ...(role ? { role } : {}),
    ...(lastToolName ? { lastToolName } : {}),
    ...(outputFile ? { outputFile } : {}),
    ...(progress && progress.phases.length > 0 ? { phases: progress.phases } : {}),
    ...(totalTokens !== undefined
      ? {
          usage: {
            totalTokens,
            ...(toolUses !== undefined ? { toolUses } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
          },
        }
      : {}),
  };
}
