import * as TestClock from "effect/testing/TestClock";
import { it, expect } from "@effect/vitest";
import { Deferred, Effect, Layer, Option } from "effect";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
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
  };
  let thread: OrchestrationThreadShell = {
    id: ThreadId.make("t"),
    projectId: project.id,
    title: "Fix notification routing",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make("turn"),
      state: "running",
      requestedAt: project.createdAt,
      startedAt: project.createdAt,
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
  const request = () => ({
    project,
    thread,
    state: projectThreadAwareness({ environmentId: EnvironmentId.make("env"), project, thread })!,
  });
  const layer = Layer.mock(ProjectionSnapshotQuery)({
    getThreadShellById: () => Effect.sync(() => Option.some(thread)),
    listRecentThreadActivitiesByKinds: () => Effect.succeed([]),
  });
  return {
    request,
    layer,
    change: (patch: Partial<OrchestrationThreadShell>) => {
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
      f.change({ hasPendingUserInput: true });
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
    f.change({ latestTurn: { ...f.request().thread.latestTurn!, turnId: TurnId.make("next") } });
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
