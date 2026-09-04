import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

// The effect test clock stands still at the epoch, so every fixture timestamp
// is placed relative to it.
const NOW = "1970-01-01T00:00:00.000Z";
const CREATED_AT = "1969-12-28T00:00:00.000Z";
const UPDATED_AT = "1969-12-30T00:00:00.000Z";
const EARLIER_VIEWED_AT = "1969-12-29T00:00:00.000Z";
const FUTURE_VIEWED_AT = "2999-01-01T00:00:00.000Z";

function makeReadModel(input: { readonly lastViewedAt?: string | null }): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "completed",
          requestedAt: CREATED_AT,
          startedAt: CREATED_AT,
          completedAt: UPDATED_AT,
          assistantMessageId: null,
        },
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        lastViewedAt: input.lastViewedAt ?? null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: UPDATED_AT,
  };
}

function decideView(readModel: OrchestrationReadModel, viewedAt?: string) {
  return decideOrchestrationCommand({
    command: {
      type: "thread.view",
      commandId: CommandId.make("cmd-view"),
      threadId: ThreadId.make("thread-1"),
      ...(viewedAt === undefined ? {} : { viewedAt }),
    },
    readModel,
  });
}

it.layer(NodeServices.layer)("viewed thread decider", (it) => {
  it.effect("records the first view without touching updatedAt", () =>
    Effect.gen(function* () {
      const event = yield* decideView(makeReadModel({}));
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.viewed");
      if (events[0]?.type === "thread.viewed") {
        // Reading is not activity: the sort anchor must not move.
        expect(events[0].payload.updatedAt).toBe(UPDATED_AT);
        expect(events[0].payload.lastViewedAt).toBe(NOW);
      }
    }),
  );

  it.effect("advances an earlier recorded view", () =>
    Effect.gen(function* () {
      const event = yield* decideView(makeReadModel({ lastViewedAt: EARLIER_VIEWED_AT }));
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.viewed") {
        expect(events[0].payload.lastViewedAt).toBe(NOW);
      }
    }),
  );

  it.effect("keeps a newer recorded view, so an out-of-order receipt projects as a no-op", () =>
    Effect.gen(function* () {
      const event = yield* decideView(makeReadModel({ lastViewedAt: FUTURE_VIEWED_AT }));
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.viewed") {
        expect(events[0].payload.lastViewedAt).toBe(FUTURE_VIEWED_AT);
        expect(events[0].payload.updatedAt).toBe(UPDATED_AT);
      }
    }),
  );

  it.effect("rewinds read state for an explicit mark as unread", () =>
    Effect.gen(function* () {
      // "I have not actually seen this": the rewind must beat the newer
      // receipt already on the server, otherwise the action does nothing.
      const event = yield* decideView(makeReadModel({ lastViewedAt: NOW }), CREATED_AT);
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.viewed") {
        expect(events[0].payload.lastViewedAt).toBe(CREATED_AT);
        expect(events[0].payload.updatedAt).toBe(UPDATED_AT);
      }
    }),
  );

  it.effect("replaces unparseable stored read state", () =>
    Effect.gen(function* () {
      const event = yield* decideView(makeReadModel({ lastViewedAt: "not-a-date" }));
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.viewed") {
        expect(events[0].payload.lastViewedAt).toBe(NOW);
      }
    }),
  );
});
