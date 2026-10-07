import * as TestClock from "effect/testing/TestClock";
import { it, expect } from "@effect/vitest";
import { Deferred, Effect, Layer, DateTime } from "effect";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type { ProjectionRecords } from "../orchestration-v2/ProjectionStore.ts";
import { makeActivitySummaries } from "./ActivitySummaries.ts";
import { cleanActivitySummary } from "./activitySummary.ts";

function fixture() {
  const project = {
    id: ProjectId.make("p"),
    title: "Project",
    workspaceRoot: "/tmp",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-09T00:00:00Z",
    updatedAt: "2026-09-09T00:00:00Z",
    deletedAt: null,
  };
  let thread: OrchestrationV2ThreadShell = {
    id: ThreadId.make("t"),
    projectId: project.id,
    title: "Fix notification routing",
    pullRequests: [],
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    createdBy: "user",
    creationSource: "web",
    activeProviderThreadId: null,
    lineage: { rootThreadId: ThreadId.make("t"), parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    activeRunId: null,
    latestRunId: RunId.make("run"),
    latestVisibleMessage: null,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    status: "running",
    pendingRuntimeRequest: null,
    latestRunStartedAt: DateTime.makeUnsafe(project.createdAt),
    createdAt: DateTime.makeUnsafe(project.createdAt),
    updatedAt: DateTime.makeUnsafe(project.updatedAt),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
  };
  const request = () => ({
    project,
    thread,
    state: projectThreadAwarenessV2({ environmentId: EnvironmentId.make("env"), project, thread })!,
  });
  const layer = Layer.mock(ThreadManagementService)({
    getThreadShell: () => Effect.sync(() => thread),
    getThreadRecords: (_threadId, fields) =>
      Effect.succeed(
        Object.fromEntries([
          ["thread", thread],
          ...fields.map((field) => [field, []]),
        ]) as ProjectionRecords<(typeof fields)[number]>,
      ),
  });
  return {
    request,
    layer,
    change: (patch: Partial<OrchestrationV2ThreadShell>) => {
      thread = { ...thread, ...patch };
    },
  };
}

it.effect(
  "publishes status immediately, deduplicates evidence, and clears summaries on attention transitions",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      let calls = 0;
      const service = yield* makeActivitySummaries(() =>
        Effect.sync(() => {
          calls++;
          return { summary: "Checking notification routing." };
        }),
      );
      expect((yield* service.enrich(f.request())).summary).toBeUndefined();
      yield* service.drain;
      expect((yield* service.enrich(f.request())).summary).toBe("Checking notification routing.");
      yield* TestClock.adjust("2 minutes");
      yield* service.enrich(f.request());
      yield* service.drain;
      expect(calls).toBe(1);
      f.change({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("input"),
          kind: "user_input",
          createdAt: DateTime.makeUnsafe(f.request().project.createdAt),
        },
      });
      const next = yield* service.enrich(f.request());
      expect(next.phase).toBe("waiting_for_input");
      expect(next.summary).toBeUndefined();
      yield* service.drain;
      expect(calls).toBe(2);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);

it.effect("discards an in-flight summary when a new turn starts", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const service = yield* makeActivitySummaries(() =>
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);
        return { summary: "Old turn result." };
      }),
    );
    yield* service.enrich(f.request());
    yield* Deferred.await(started);
    f.change({ latestRunId: RunId.make("next") });
    yield* Deferred.succeed(release, undefined);
    yield* service.drain;
    expect((yield* service.enrich(f.request())).summary).toBeUndefined();
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect("keeps factual status when generation fails", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* makeActivitySummaries(() =>
      Effect.fail(
        new TextGenerationError({ operation: "generateActivitySummary", detail: "unavailable" }),
      ),
    );
    const before = yield* service.enrich(f.request());
    yield* service.drain;
    expect(yield* service.enrich(f.request())).toEqual(before);
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it("removes emoji and bounds generated text", () => {
  expect(cleanActivitySummary("  ✨ Checking\n routing.  ")).toBe("Checking routing.");
  expect(cleanActivitySummary("a".repeat(200))).toHaveLength(160);
});

it.effect("retries identical evidence after a transient generation failure", () => {
  const f = fixture();
  return Effect.gen(function* () {
    let calls = 0;
    const service = yield* makeActivitySummaries(() =>
      Effect.suspend(() => {
        calls++;
        return calls === 1
          ? Effect.fail(
              new TextGenerationError({
                operation: "generateActivitySummary",
                detail: "temporary failure",
              }),
            )
          : Effect.succeed({ summary: "Checking notification routing." });
      }),
    );
    yield* service.enrich(f.request());
    yield* service.drain;
    yield* TestClock.adjust("2 minutes");
    yield* service.enrich(f.request());
    yield* service.drain;
    expect((yield* service.enrich(f.request())).summary).toBe("Checking notification routing.");
    expect(calls).toBe(2);
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});
