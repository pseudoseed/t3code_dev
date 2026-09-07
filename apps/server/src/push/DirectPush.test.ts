import { it, expect } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import {
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  AuthOrchestrationReadScope,
  type DirectPushRegistration,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { DirectPush, make } from "./DirectPush.ts";
import { ApnsTransport, type ApnsRequest, type ApnsResult } from "./ApnsTransport.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { AuthSessionRecord, AuthSessionRepository } from "../persistence/AuthSessions.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { aggregateActivity, liveActivityPayload } from "./payloads.ts";

const sessionId = AuthSessionId.make("session");
const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const now = "2026-09-06T12:00:00.000Z";
const registration: DirectPushRegistration = {
  deviceId: "phone",
  bundleId: "test.app",
  apsEnvironment: "production",
  pushToken: "aabb",
  activityToken: "ccdd",
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
};

const activeSession = Schema.decodeUnknownSync(AuthSessionRecord)({
  sessionId,
  subject: "user",
  scopes: [AuthOrchestrationReadScope],
  method: "bearer-access-token",
  client: {
    label: null,
    ipAddress: null,
    userAgent: null,
    deviceType: "mobile",
    os: "iOS",
    browser: null,
  },
  issuedAt: now,
  expiresAt: "2099-01-01T00:00:00.000Z",
  lastConnectedAt: null,
  revokedAt: null,
});

function harness() {
  let thread: OrchestrationThreadShell = {
    id: threadId,
    projectId,
    title: "Fix notifications",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: {
      threadId,
      status: "running",
      providerName: "Codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    },
    latestUserMessageAt: now,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
  const project = {
    id: projectId,
    title: "Project",
    workspaceRoot: "/test",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  };
  const requests: ApnsRequest[] = [];
  let result: ApnsResult = { status: 200 };
  let revoked = false;
  const secrets = new Map<string, Uint8Array>();
  const layer = Layer.effect(DirectPush, make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ApnsTransport, {
          bundleId: "test.app",
          send: (request) =>
            Effect.sync(() => {
              requests.push(request);
              return result;
            }),
        }),
        Layer.mock(ServerSecretStore)({
          get: (key) => Effect.sync(() => Option.fromNullishOr(secrets.get(key))),
          set: (key, value) =>
            Effect.sync(() => {
              secrets.set(key, value);
            }),
        }),
        Layer.mock(AuthSessionRepository)({
          getById: () => Effect.sync(() => (revoked ? Option.none() : Option.some(activeSession))),
        }),
        Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) }),
        Layer.mock(OrchestrationEngineService)({}),
        Layer.mock(ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [project],
              threads: [thread],
              updatedAt: now,
            }),
          getThreadShellById: () => Effect.sync(() => Option.some(thread)),
          getProjectShellById: () => Effect.succeed(Option.some(project)),
        }),
      ),
    ),
  );
  return {
    layer,
    requests,
    secrets,
    change: (patch: Partial<OrchestrationThreadShell>) => {
      thread = { ...thread, ...patch };
    },
    revoke: () => {
      revoked = true;
    },
    response: (next: ApnsResult) => {
      result = next;
    },
  };
}

it.effect(
  "reconciles silently on registration and alerts once for each new attention phase",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const push = yield* DirectPush;
      expect((yield* push.register(sessionId, registration)).registered).toBe(true);
      expect(h.requests.some((request) => request.kind === "alert")).toBe(false);
      h.change({ hasPendingUserInput: true });
      yield* push.publishThread(threadId);
      yield* push.publishThread(threadId);
      h.change({ title: "Renamed thread", updatedAt: "2026-09-06T12:01:00.000Z" });
      yield* push.publishThread(threadId);
      expect(h.requests.filter((request) => request.kind === "alert")).toHaveLength(1);
      h.change({ hasPendingUserInput: false });
      yield* push.publishThread(threadId);
      h.change({ hasPendingUserInput: true });
      yield* push.publishThread(threadId);
      expect(h.requests.filter((request) => request.kind === "alert")).toHaveLength(2);
      const alert = h.requests.find((request) => request.kind === "alert")!;
      expect(alert.payload).toMatchObject({
        aps: { sound: "default", "content-available": 1 },
        environmentId,
        threadId,
        directWidget: { environmentId },
      });
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("does not send to revoked sessions and removes their persisted registrations", () => {
  const h = harness();
  return Effect.gen(function* () {
    const push = yield* DirectPush;
    yield* push.register(sessionId, registration);
    h.requests.length = 0;
    h.revoke();
    h.change({ hasPendingApprovals: true });
    yield* push.publishThread(threadId);
    expect(h.requests).toEqual([]);
    expect((yield* push.status(sessionId)).registered).toBe(false);
  }).pipe(Effect.provide(h.layer));
});

it.effect("does not replay an input alert when an overlapping approval resolves", () => {
  const h = harness();
  return Effect.gen(function* () {
    const push = yield* DirectPush;
    yield* push.register(sessionId, registration);
    h.change({ hasPendingUserInput: true });
    yield* push.publishThread(threadId);
    h.change({ hasPendingApprovals: true });
    yield* push.publishThread(threadId);
    h.change({ hasPendingApprovals: false });
    yield* push.publishThread(threadId);
    expect(h.requests.filter((request) => request.kind === "alert")).toHaveLength(2);
  }).pipe(Effect.provide(h.layer));
});

it.effect("rejects mismatched bundle IDs and ends activities when disabled or unregistered", () => {
  const h = harness();
  return Effect.gen(function* () {
    const push = yield* DirectPush;
    expect(
      (yield* push.register(sessionId, { ...registration, bundleId: "wrong.app" })).registered,
    ).toBe(false);
    expect(h.requests).toEqual([]);
    yield* push.register(sessionId, registration);
    h.requests.length = 0;
    yield* push.register(sessionId, {
      ...registration,
      liveActivitiesEnabled: false,
      activityToken: null,
    });
    expect(h.requests.find((request) => request.kind === "liveactivity")?.payload).toMatchObject({
      aps: { event: "end" },
    });
    yield* push.unregister(sessionId);
    expect((yield* push.status(sessionId)).registered).toBe(false);
  }).pipe(Effect.provide(h.layer));
});

it.effect("clears invalid tokens without retrying permanent APNs rejections", () => {
  const h = harness();
  return Effect.gen(function* () {
    const push = yield* DirectPush;
    h.response({ status: 410, reason: "Unregistered" });
    yield* push.register(sessionId, registration);
    expect(h.requests).toHaveLength(2);
    h.requests.length = 0;
    h.change({ hasPendingUserInput: true });
    yield* push.publishThread(threadId);
    expect(h.requests).toEqual([]);
  }).pipe(Effect.provide(h.layer));
});

it("bounds ActivityKit payload bytes with Unicode titles and uses the right layout", () => {
  const aggregate = aggregateActivity(
    Array.from({ length: 3 }, (_, index) => ({
      environmentId,
      threadId: ThreadId.make(`thread-${index}`),
      projectTitle: "😀".repeat(200),
      threadTitle: "😀".repeat(200),
      modelTitle: "😀".repeat(200),
      phase: "running" as const,
      headline: "Working",
      updatedAt: now,
      deepLink: "/threads/test",
    })),
    now,
  );
  const payload = liveActivityPayload(
    aggregate,
    1234,
    false,
    `DirectAgentActivity:${environmentId}`,
  );
  expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(4096);
  expect(payload.aps["content-state"].name).toBe(`DirectAgentActivity:${environmentId}`);
});
