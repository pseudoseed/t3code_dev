import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import {
  CommandId,
  EventId,
  MailboxError,
  MessageId,
  type ThreadId,
  type ThreadMailboxCommand,
} from "@t3tools/contracts";
import { randomUuidV4 } from "./RandomUuid.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { readMcpProviderSession } from "../mcp/McpProviderSession.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { makeMailboxRepository } from "./MailboxRepository.ts";
import { encodeMailboxSnapshot } from "./MailboxContext.ts";
import { mailboxTurnContext } from "./AgentMailbox.ts";

/** Provider delivery persists its snapshot before starting and acceptance afterward. */
export const makeMailboxDelivery = Effect.gen(function* () {
  const repository = yield* makeMailboxRepository;
  const sink = yield* EventSinkV2;
  const dispatch = Effect.fn("MailboxDelivery.dispatch")(function* (
    threadId: ThreadId,
    executionId: MessageId,
    operation: ThreadMailboxCommand["operation"],
  ) {
    const now = yield* DateTime.now;
    const commandId = CommandId.make(`mailbox:${executionId}:${operation.kind}`);
    const changes = yield* repository.decide({
      type: "thread.mailbox",
      commandId,
      threadId,
      operation,
      createdAt: DateTime.formatIso(now),
    });
    const events = [];
    for (const change of changes) {
      for (const participant of yield* repository.participants(threadId, change)) {
        events.push({
          id: EventId.make(yield* randomUuidV4),
          type: "thread.mailbox-updated" as const,
          threadId: participant,
          occurredAt: now,
          payload: { ownerThreadId: threadId, change },
        });
      }
    }
    yield* sink.commitCommand({
      commandId,
      threadId,
      commandType: "thread.mailbox",
      acceptedAt: now,
      events,
      effects: [],
    });
  });
  const prepare = Effect.fn("MailboxDelivery.prepare")(function* (
    threadId: ThreadId,
    executionId: MessageId,
  ) {
    const providerSessionId = readMcpProviderSession(threadId)?.providerSessionId ?? null;
    if (providerSessionId === null) return { context: "", accepted: Effect.void };
    const previous = (yield* repository.turns(threadId, executionId))[0];
    const turnKey = previous?.turnKey ?? (yield* randomUuidV4);
    if (!previous || previous.state === "pending")
      yield* dispatch(threadId, executionId, {
        kind: "prepare",
        executionId,
        providerSessionId,
        turnKey,
        contextBudget: 32_000,
        includeIncoming: true,
      });
    const turn = (yield* repository.turns(threadId, executionId))[0];
    if (!turn)
      return yield* new MailboxError({ message: "The mailbox snapshot could not be loaded." });
    const incoming = (yield* Effect.forEach(turn.incoming, (id) =>
      repository.messages(threadId, { id }),
    )).flat();
    const snapshot = yield* encodeMailboxSnapshot(incoming, 32_000);
    return {
      context: mailboxTurnContext(
        turnKey,
        snapshot.encoded,
        yield* repository.unresolvedCount(threadId),
      ),
      accepted: dispatch(threadId, executionId, {
        kind: "finish",
        executionId,
        turnId: null,
        state: "submitted",
      }),
    };
  });
  return { prepare };
});

// Isolated provider harnesses do not run a collaboration inbox. Production supplies the durable implementation.
export const MailboxDelivery = Context.Reference<Effect.Success<typeof makeMailboxDelivery>>(
  "t3/orchestration-v2/MailboxDelivery",
  {
    defaultValue: () => ({ prepare: () => Effect.succeed({ context: "", accepted: Effect.void }) }),
  },
);
export const layer = Layer.effect(MailboxDelivery, makeMailboxDelivery);
