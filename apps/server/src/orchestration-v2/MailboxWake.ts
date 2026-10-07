import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import { type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import { makeAgentMailbox } from "./AgentMailbox.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

/** Wake is a queued V2 message: racing user work can defer it, never interrupt it. */
export const startMailboxWake = Effect.gen(function* () {
  const mailbox = yield* makeAgentMailbox;
  const threads = yield* ThreadManagementService;
  const timers = new Map<ThreadId, Fiber.Fiber<void>>();
  const worker: DrainableWorker<ThreadId> = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* mailbox.wake(threadId, true);
      const until = yield* mailbox.repository.snoozedUntil(threadId);
      const remaining =
        until === null ? 0 : Date.parse(until) - DateTime.toEpochMillis(yield* DateTime.now);
      const prior = timers.get(threadId);
      if (prior) yield* Fiber.interrupt(prior);
      timers.delete(threadId);
      if (remaining > 0) {
        const timer = yield* Effect.sleep(remaining).pipe(
          Effect.andThen(worker.enqueue(threadId)),
          Effect.forkScoped,
        );
        timers.set(threadId, timer);
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Mailbox wake failed", { threadId, cause })),
    ),
  );
  yield* Stream.runForEach(threads.streamDomainEvents, (event) => {
    switch (event.type) {
      case "thread.mailbox-updated":
      case "run.updated":
      case "runtime-request.updated":
      case "subagent.updated":
      case "provider-thread.updated":
      case "thread.snoozed":
      case "thread.unsnoozed":
      case "thread.unarchived":
        return worker.enqueue(event.threadId);
      case "turn-item.updated":
        // Streaming assistant text cannot unblock an inbox. Observe only tool completion.
        return ["command_execution", "dynamic_tool", "subagent"].includes(event.payload.type) &&
          !["pending", "running", "waiting"].includes(event.payload.status)
          ? worker.enqueue(event.threadId)
          : Effect.void;
      default:
        return Effect.void;
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Mailbox wake listener stopped", { cause })),
    Effect.forkScoped,
  );
  const candidates = yield* mailbox.repository
    .wakeCandidates()
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Mailbox startup scan failed", { cause }).pipe(Effect.as([])),
      ),
    );
  for (const { threadId } of candidates) yield* worker.enqueue(threadId);
  return worker;
});
