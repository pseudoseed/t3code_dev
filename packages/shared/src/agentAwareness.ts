import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  Project,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";

export type AgentAwarenessPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface AgentAwarenessState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectTitle: string;
  readonly projectId?: string | undefined;
  readonly threadTitle: string;
  readonly phase: AgentAwarenessPhase;
  readonly headline: string;
  readonly detail?: string | undefined;
  readonly summary?: string | undefined;
  readonly turnId?: string | undefined;
  readonly projectIcon?: string;
  readonly modelTitle: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

/** Keep active work and recent outcomes on glanceable surfaces, never old failures forever. */
export function selectWidgetActivities(states: Iterable<AgentAwarenessState>, now: number) {
  const priority = (state: AgentAwarenessState) =>
    state.phase.startsWith("waiting")
      ? 0
      : state.phase === "running" || state.phase === "starting"
        ? 1
        : 2;
  return [...states]
    .filter((state) => priority(state) < 2 || now - Date.parse(state.updatedAt) < 60 * 60_000)
    .sort((a, b) => priority(a) - priority(b) || b.updatedAt.localeCompare(a.updatedAt))
    .map((state) => {
      const { detail, ...summary } = state;
      const reason =
        state.phase === "failed" ? detail?.trim().split(/\r?\n/)[0]?.slice(0, 140) : undefined;
      return { ...summary, ...(reason ? { detail: reason } : {}) };
    });
}

function buildAgentAwarenessDeepLink(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): string {
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

export interface ProjectThreadAwarenessV2Input {
  readonly environmentId: EnvironmentId;
  readonly project: Pick<Project, "title"> & Partial<Pick<Project, "id">>;
  readonly thread: Pick<
    OrchestrationV2ThreadShell,
    | "activityRunStatus"
    | "activeRunId"
    | "latestRunId"
    | "id"
    | "lineage"
    | "modelSelection"
    | "pendingBackgroundTasks"
    | "pendingRuntimeRequest"
    | "status"
    | "title"
    | "updatedAt"
  >;
}

/** Build relay activity directly from the V2 shell projection. */
export function projectThreadAwarenessV2(
  input: ProjectThreadAwarenessV2Input,
): AgentAwarenessState | null {
  const { environmentId, project, thread } = input;
  if (thread.lineage.relationshipToParent === "subagent") return null;
  const phase = resolveThreadAwarenessPhaseV2(thread);
  if (phase === null) {
    return null;
  }
  const detail =
    phase === "completed"
      ? "Review the completed task."
      : phase === "failed"
        ? "The agent run failed."
        : undefined;
  return {
    environmentId,
    threadId: thread.id,
    projectTitle: project.title,
    ...(project.id ? { projectId: project.id } : {}),
    threadTitle: thread.title,
    ...((thread.activeRunId ?? thread.latestRunId)
      ? { turnId: String(thread.activeRunId ?? thread.latestRunId) }
      : {}),
    phase,
    headline: headlineForPhase(phase),
    ...(detail === undefined ? {} : { detail }),
    modelTitle: thread.modelSelection.model,
    updatedAt: DateTime.formatIso(thread.updatedAt),
    deepLink: buildAgentAwarenessDeepLink({ environmentId, threadId: thread.id }),
  };
}

function resolveThreadAwarenessPhaseV2(
  thread: ProjectThreadAwarenessV2Input["thread"],
): AgentAwarenessPhase | null {
  if (thread.pendingRuntimeRequest?.kind === "user_input") {
    return "waiting_for_input";
  }
  if (
    thread.pendingRuntimeRequest !== null &&
    thread.pendingRuntimeRequest.kind !== "auth_refresh"
  ) {
    return "waiting_for_approval";
  }
  switch (thread.activityRunStatus ?? thread.status) {
    case "preparing":
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "completed":
      // Work that will wake the agent keeps the run going; a dev server does not.
      return backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
        ? "running"
        : "completed";
    case "failed":
      return "failed";
    case "idle":
    case "queued":
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return null;
  }
}

function headlineForPhase(phase: AgentAwarenessPhase): string {
  switch (phase) {
    case "starting":
      return "Starting agent";
    case "running":
      return "Agent is working";
    case "waiting_for_approval":
      return "Approval needed";
    case "waiting_for_input":
      return "Waiting for input";
    case "completed":
      return "Agent finished";
    case "failed":
      return "Agent failed";
    case "stale":
      return "Update delayed";
  }
}
