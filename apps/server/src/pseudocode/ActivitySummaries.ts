import type {
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import { projectThreadAwareness, type AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { Context, DateTime, Effect, Layer, Option, PubSub, Stream } from "effect";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { activitySummaryContext, SUMMARY_INTERVAL_MS } from "./activitySummary.ts";

type Request = {
  state: AgentAwarenessState;
  thread: OrchestrationThreadShell;
  project: OrchestrationProjectShell;
};
type Entry = {
  identity: string;
  requestedAt: number;
  summary?: string;
  updatedAt?: string;
  context?: string;
};

export class ActivitySummaries extends Context.Service<
  ActivitySummaries,
  {
    readonly enrich: (input: Request) => Effect.Effect<AgentAwarenessState>;
    readonly changes: Stream.Stream<ThreadId>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/pseudocode/ActivitySummaries") {}

export const makeActivitySummaries = Effect.fn("makeActivitySummaries")(function* (
  generate: (
    context: string,
    cwd: string,
  ) => Effect.Effect<{ summary: string } | undefined, TextGenerationError>,
) {
  const query = yield* ProjectionSnapshotQuery;
  const changes = yield* PubSub.unbounded<ThreadId>();
  const entries = new Map<ThreadId, Entry>();
  const pending = new Map<ThreadId, Request>();
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.gen(function* () {
      const input = pending.get(threadId);
      pending.delete(threadId);
      const entry = entries.get(threadId);
      if (!input || !entry) return;
      const activities = yield* query.listRecentThreadActivitiesByKinds(
        threadId,
        [
          "tool.completed",
          "tool.started",
          "approval.requested",
          "user-input.requested",
          "runtime.error",
        ],
        12,
      );
      const messageId = input.thread.latestTurn?.assistantMessageId;
      const message = messageId
        ? yield* query.getTurnStartMessage({ threadId, messageId })
        : Option.none();
      const assistantText =
        Option.isSome(message) && message.value.message.turnId === input.thread.latestTurn?.turnId
          ? message.value.message.text
          : undefined;
      const context = activitySummaryContext({
        assistantText,
        state: input.state,
        turnId: input.thread.latestTurn?.turnId ?? null,
        activities,
      });
      if (context === entry.context) return;
      const result = yield* generate(context, input.project.workspaceRoot).pipe(
        Effect.timeout("30 seconds"),
      );
      // A failed or unavailable provider must be allowed to retry the same evidence.
      if (result) entry.context = context;
      // A delayed result must never describe a newer turn or overwrite an attention transition.
      const current = yield* query.getThreadShellById(threadId);
      if (
        entries.get(threadId) !== entry ||
        Option.isNone(current) ||
        current.value.archivedAt !== null ||
        identity(
          current.value,
          projectThreadAwareness({
            environmentId: input.state.environmentId,
            project: input.project,
            thread: current.value,
          })?.phase ?? "",
        ) !== entry.identity
      )
        return;
      if (!result?.summary || result.summary === entry.summary) return;
      entry.summary = result.summary;
      entry.updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* PubSub.publish(changes, threadId);
    }).pipe(
      Effect.catch(() =>
        Effect.logDebug("Widget summary unavailable; keeping factual activity status."),
      ),
    ),
  );

  const enrich = Effect.fn("ActivitySummaries.enrich")(function* (input: Request) {
    const now = (yield* DateTime.now).epochMilliseconds;
    const key = identity(input.thread, input.state.phase);
    let entry = entries.get(input.thread.id);
    const changed = entry?.identity !== key;
    if (changed || !entry) {
      entry = { identity: key, requestedAt: -Infinity };
      entries.set(input.thread.id, entry);
      if (entries.size > 512) entries.delete(entries.keys().next().value!);
    }
    if (now - entry.requestedAt >= SUMMARY_INTERVAL_MS) {
      entry.requestedAt = now;
      const queued = pending.has(input.thread.id);
      pending.set(input.thread.id, input);
      if (!queued) yield* worker.enqueue(input.thread.id);
    }
    return entry.summary
      ? {
          ...input.state,
          summary: entry.summary,
          updatedAt:
            entry.updatedAt && entry.updatedAt > input.state.updatedAt
              ? entry.updatedAt
              : input.state.updatedAt,
        }
      : input.state;
  });
  return ActivitySummaries.of({ enrich, changes: Stream.fromPubSub(changes), drain: worker.drain });
});

function identity(thread: OrchestrationThreadShell, phase: string) {
  return `${thread.latestTurn?.turnId ?? ""}:${phase}`;
}
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  return yield* makeActivitySummaries(
    Effect.fn("ActivitySummaries.generate")(function* (context: string, cwd: string) {
      const instance = (yield* registry.listInstances).find(
        (instance) =>
          instance.enabled &&
          instance.driverKind === "claudeAgent" &&
          instance.textGeneration.generateActivitySummary,
      );
      if (!instance?.textGeneration.generateActivitySummary) return;
      return yield* instance.textGeneration.generateActivitySummary({
        cwd,
        context,
        modelSelection: { instanceId: instance.instanceId, model: "haiku" },
      });
    }),
  );
});
export const layer = Layer.effect(ActivitySummaries, make);
