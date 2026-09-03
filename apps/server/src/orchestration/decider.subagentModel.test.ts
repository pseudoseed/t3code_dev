import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CODEX = ProviderInstanceId.make("codex");

const claudeSelection: ModelSelection = { instanceId: CLAUDE, model: "claude-opus-5" };

function readModelWithSubagentSelection(
  subagentModelSelection: ModelSelection | null,
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: claudeSelection,
        subagentModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: UPDATED_AT,
        updatedAt: UPDATED_AT,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
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

it.layer(NodeServices.layer)("subagent model selection decider", (it) => {
  it.effect("records an override on the thread's own instance", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-set-subagent"),
          threadId: ThreadId.make("thread-1"),
          subagentModelSelection: { instanceId: CLAUDE, model: "claude-haiku-4-5" },
        },
        readModel: readModelWithSubagentSelection(null),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload.subagentModelSelection).toEqual({
          instanceId: CLAUDE,
          model: "claude-haiku-4-5",
        });
      }
    }),
  );

  it.effect("clears the override back to inherit", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-clear-subagent"),
          threadId: ThreadId.make("thread-1"),
          subagentModelSelection: null,
        },
        readModel: readModelWithSubagentSelection({
          instanceId: CLAUDE,
          model: "claude-haiku-4-5",
        }),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload.subagentModelSelection).toBeNull();
      }
    }),
  );

  it.effect("rejects an override aimed at another provider instance", () =>
    Effect.gen(function* () {
      const failure = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-cross-instance"),
          threadId: ThreadId.make("thread-1"),
          subagentModelSelection: { instanceId: CODEX, model: "gpt-5.4" },
        },
        readModel: readModelWithSubagentSelection(null),
      }).pipe(Effect.flip);

      expect(failure._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("clears an override stranded by a main-model instance switch", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-switch-instance"),
          threadId: ThreadId.make("thread-1"),
          modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
        },
        readModel: readModelWithSubagentSelection({
          instanceId: CLAUDE,
          model: "claude-haiku-4-5",
        }),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload.subagentModelSelection).toBeNull();
      }
    }),
  );

  it.effect("leaves the override alone when the instance does not change", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-same-instance"),
          threadId: ThreadId.make("thread-1"),
          modelSelection: { instanceId: CLAUDE, model: "claude-sonnet-5" },
        },
        readModel: readModelWithSubagentSelection({
          instanceId: CLAUDE,
          model: "claude-haiku-4-5",
        }),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload.subagentModelSelection).toBeUndefined();
      }
    }),
  );
});
