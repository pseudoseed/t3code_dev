import type { OrchestrationV2SubagentTaskMetadata } from "@t3tools/contracts";

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function claudeTaskMetadata(message: unknown): OrchestrationV2SubagentTaskMetadata {
  if (message === null || typeof message !== "object") return {};
  const record = message as Record<string, unknown>;
  const workflowName = trimmedString(record.workflow_name);
  const role = trimmedString(record.subagent_type);
  const lastToolName = trimmedString(record.last_tool_name);
  const outputFile = trimmedString(record.output_file);
  const taskType = trimmedString(record.task_type);
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
