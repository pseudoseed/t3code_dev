import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  agentWidgetContentKey,
  buildAgentWidgetSnapshot,
  mergeWidgetUpdate,
} from "./agentWidgetSnapshot";

const environmentId = EnvironmentId.make("environment-1");
const project = { environmentId, id: ProjectId.make("project-1"), title: "Project" };
type WidgetThread = Parameters<typeof buildAgentWidgetSnapshot>[0]["threads"][number];
function thread(overrides: Partial<WidgetThread> = {}): WidgetThread {
  return {
    environmentId,
    projectId: project.id,
    id: ThreadId.make("thread-1"),
    title: "Build staging",
    archivedAt: null,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    session: null,
    latestTurn: null,
    updatedAt: "2026-09-06T18:00:00Z",
    hasPendingApprovals: false,
    hasPendingUserInput: true,
    ...overrides,
  };
}

describe("agent widget snapshots", () => {
  it("keeps recent error details but excludes old failures from the widget", () => {
    const now = Date.parse("2026-09-06T18:10:00Z");
    const failed = thread({
      hasPendingUserInput: false,
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "error",
        providerName: "Codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: "Credential expired\nInternal stack details",
        updatedAt: "2026-09-06T18:00:00Z",
      },
    });
    const snapshot = buildAgentWidgetSnapshot({
      projects: [project],
      threads: [failed, { ...failed, id: ThreadId.make("old"), updatedAt: "2026-09-05T18:00:00Z" }],
      now,
    });
    expect(snapshot.activities).toHaveLength(1);
    expect(snapshot.activities[0]?.detail).toBe("Credential expired");
    expect(snapshot.activeCount).toBe(0);
    const changed = buildAgentWidgetSnapshot({
      projects: [project],
      threads: [{ ...failed, session: { ...failed.session!, lastError: "Provider rate limit" } }],
      now,
    });
    expect(agentWidgetContentKey(changed)).not.toBe(agentWidgetContentKey(snapshot));
  });
  it("merges background updates per environment and ignores late or removed-server pushes", () => {
    const secondEnvironment = EnvironmentId.make("environment-2");
    const snapshot = buildAgentWidgetSnapshot({
      projects: [project, { ...project, environmentId: secondEnvironment }],
      threads: [thread(), thread({ environmentId: secondEnvironment })],
    });
    const update = {
      environmentId,
      attentionCount: 0,
      activity: {
        title: "Agent activity",
        subtitle: "All caught up",
        activeCount: 0,
        activities: [],
        updatedAt: "2026-09-06T19:00:00Z",
      },
    };
    const merged = mergeWidgetUpdate(snapshot, update);
    expect(merged.activeCount).toBe(1);
    expect(merged.attentionCount).toBe(1);
    expect(merged.activities.map((row) => row.environmentId)).toEqual([secondEnvironment]);
    expect(
      mergeWidgetUpdate(merged, {
        ...update,
        activity: { ...update.activity, updatedAt: "2026-09-06T17:00:00Z" },
      }),
    ).toBe(merged);
    expect(
      mergeWidgetUpdate(merged, { ...update, environmentId: EnvironmentId.make("removed") }),
    ).toBe(merged);
  });
  it("publishes an empty state when no projects are connected", () => {
    expect(buildAgentWidgetSnapshot({ projects: [], threads: [] })).toEqual({
      activeCount: 0,
      attentionCount: 0,
      activities: [],
      updatedAt: null,
    });
  });

  it("prioritizes attention, counts all active work, and bounds the displayed rows", () => {
    const threads = Array.from({ length: 5 }, (_, index) =>
      thread({
        id: ThreadId.make(`thread-${index}`),
        hasPendingUserInput: index === 4,
        session: {
          threadId: ThreadId.make(`thread-${index}`),
          status: "running",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-09-06T18:00:00Z",
        },
      }),
    );
    const snapshot = buildAgentWidgetSnapshot({ projects: [project], threads });
    expect(snapshot.activeCount).toBe(5);
    expect(snapshot.attentionCount).toBe(1);
    expect(snapshot.activities).toHaveLength(5);
    expect(snapshot.activities[0]?.threadId).toBe("thread-4");
    expect(snapshot.activities[0]?.headline).toBe("Waiting for input");
  });

  it("keeps project names and deep links scoped to each environment", () => {
    const secondEnvironment = EnvironmentId.make("environment-2");
    const snapshot = buildAgentWidgetSnapshot({
      projects: [
        project,
        { ...project, environmentId: secondEnvironment, title: "Second project" },
      ],
      threads: [thread(), thread({ environmentId: secondEnvironment })],
    });
    expect(
      snapshot.activities.map((activity) => [activity.projectTitle, activity.deepLink]),
    ).toEqual([
      ["Project", "/threads/environment-1/thread-1"],
      ["Second project", "/threads/environment-2/thread-1"],
    ]);
  });

  it("drops archived threads, removed projects, and threads without activity", () => {
    const snapshot = buildAgentWidgetSnapshot({
      projects: [project],
      threads: [
        thread({ id: ThreadId.make("archived"), archivedAt: "2026-09-06T19:00:00Z" }),
        thread({ id: ThreadId.make("removed-project"), projectId: ProjectId.make("removed") }),
        thread({ id: ThreadId.make("idle"), hasPendingUserInput: false }),
      ],
    });
    expect(snapshot.activities).toEqual([]);
    expect(snapshot.activeCount).toBe(0);
  });

  it("does not reload for timestamp-only changes, but does for new requests or titles", () => {
    const initial = buildAgentWidgetSnapshot({ projects: [project], threads: [thread()] });
    const timestampOnly = buildAgentWidgetSnapshot({
      projects: [project],
      threads: [thread({ updatedAt: "2026-09-06T19:00:00Z" })],
    });
    const approval = buildAgentWidgetSnapshot({
      projects: [project],
      threads: [thread({ hasPendingApprovals: true })],
    });
    const renamed = buildAgentWidgetSnapshot({
      projects: [project],
      threads: [thread({ title: "New title" })],
    });
    expect(agentWidgetContentKey(timestampOnly)).toBe(agentWidgetContentKey(initial));
    expect(agentWidgetContentKey(approval)).not.toBe(agentWidgetContentKey(initial));
    expect(agentWidgetContentKey(renamed)).not.toBe(agentWidgetContentKey(initial));
  });
});
