import type {
  Project,
  OrchestrationV2ThreadShell,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2, type AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { Context, DateTime, Effect, Layer, PubSub, Stream } from "effect";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { activitySummaryContext, SUMMARY_INTERVAL_MS } from "./activitySummary.ts";

type Request = {
  state: AgentAwarenessState;
  thread: OrchestrationV2ThreadShell;
  project: Project;
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
  const query = yield* ThreadManagementService;
  const changes = yield* PubSub.unbounded<ThreadId>();
  const entries = new Map<ThreadId, Entry>();
  const pending = new Map<ThreadId, Request>();
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.gen(function* () {
      const input = pending.get(threadId);
      pending.delete(threadId);
      const entry = entries.get(threadId);
      if (!input || !entry) return;
      const projection = yield* query.getThreadRecords(threadId, ["turnItems"], {
        turnItemRunIds: input.thread.latestRunId ? [input.thread.latestRunId] : [],
      });
      const items = projection.turnItems.slice(-12);
      const activities = items.map((item) => ({
        turnId: item.runId,
        kind: item.type,
        summary:
          item.type === "assistant_message"
            ? item.text.slice(-350)
            : item.type === "command_execution"
              ? item.input.slice(0, 350)
              : "title" in item && typeof item.title === "string"
                ? item.title
                : item.type,
      }));
      const assistantText = items.findLast((item) => item.type === "assistant_message");
      const context = activitySummaryContext({
        assistantText: assistantText?.type === "assistant_message" ? assistantText.text : undefined,
        state: input.state,
        turnId: input.thread.latestRunId,
        activities,
      });
      if (context === entry.context) return;
      const result = yield* generate(context, input.project.workspaceRoot).pipe(
        Effect.timeout("30 seconds"),
      );
      // A failed or unavailable provider must be allowed to retry the same evidence.
      if (result) entry.context = context;
      // A delayed result must never describe a newer turn or overwrite an attention transition.
      const current = yield* query.getThreadShell(threadId);
      if (
        entries.get(threadId) !== entry ||
        current === null ||
        current.archivedAt !== null ||
        identity(
          current,
          projectThreadAwarenessV2({
            environmentId: input.state.environmentId,
            project: input.project,
            thread: current,
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

function identity(thread: OrchestrationV2ThreadShell, phase: string) {
  return `${thread.latestRunId ?? ""}:${phase}`;
}
const make = Effect.gen(function* () {
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
