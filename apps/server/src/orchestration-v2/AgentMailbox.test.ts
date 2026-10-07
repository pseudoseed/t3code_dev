import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadMailboxCommand,
} from "@t3tools/contracts";
import { randomUuidV4 } from "./RandomUuid.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { makeMailboxRepository } from "./MailboxRepository.ts";
import { encodeMailboxSnapshot } from "./MailboxContext.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(database),
);
const layer = EventSink.layer.pipe(Layer.provideMerge(stores));

const fixture = Effect.gen(function* () {
  const prefix = yield* randomUuidV4;
  const sender = ThreadId.make(`${prefix}:sender`);
  const recipient = ThreadId.make(`${prefix}:recipient`);
  const executionId = MessageId.make(`${prefix}:source-turn`);
  const sink = yield* EventSink.EventSinkV2;
  const repository = yield* makeMailboxRepository;
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  let next = 0;
  const dispatch = Effect.fn("mailbox.test.dispatch")(function* (
    threadId: ThreadId,
    operation: ThreadMailboxCommand["operation"],
    actor?: ThreadMailboxCommand["actor"],
  ) {
    const commandId = CommandId.make(`${prefix}:command:${++next}`);
    const scopedOperation =
      operation.kind === "send"
        ? { ...operation, id: `${prefix}:${operation.id}` }
        : operation.kind === "state"
          ? { ...operation, messageId: `${prefix}:${operation.messageId}` }
          : operation.kind === "read"
            ? { ...operation, messageIds: operation.messageIds.map((id) => `${prefix}:${id}`) }
            : operation;
    const changes = yield* repository.decide({
      type: "thread.mailbox",
      threadId,
      commandId,
      createdAt: DateTime.formatIso(now),
      operation: scopedOperation,
      ...(actor ? { actor } : {}),
    });
    const events = [];
    for (const change of changes)
      for (const participant of yield* repository.participants(threadId, change)) {
        events.push({
          id: EventId.make(`${prefix}:event:${++next}`),
          type: "thread.mailbox-updated" as const,
          threadId: participant,
          occurredAt: now,
          payload: { ownerThreadId: threadId, change },
        });
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
  for (const threadId of [sender, recipient])
    yield* sink.write({
      events: [
        {
          id: EventId.make(`create:${threadId}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            id: threadId,
            projectId: ProjectId.make("project"),
            title: threadId,
            providerInstanceId: ProviderInstanceId.make("codex"),
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
            forkedFrom: null,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            deletedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
          },
        },
      ],
    });
  yield* dispatch(sender, { kind: "link", peerThreadId: recipient, linked: true });
  yield* dispatch(sender, {
    kind: "prepare",
    executionId,
    turnKey: `${prefix}:source-key`,
    providerSessionId: "source-session",
    contextBudget: 32_000,
    includeIncoming: true,
  });
  const send = (id: string, body = "Please review the implementation.") =>
    dispatch(sender, { kind: "send", id, toThreadId: recipient, executionId, body, replyTo: null });
  return { repository, sink, sql, dispatch, send, now, sender, recipient, executionId, prefix };
});

it.layer(layer)("V2 durable mailbox", (it) => {
  it.effect(
    "commits linked histories and both shell revisions atomically, with idempotent send keys",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const { sender, recipient } = f;
        yield* f.send("request");
        yield* f.send("request");
        assert.lengthOf((yield* f.repository.get({ threadId: recipient })).messages, 1);
        assert.deepStrictEqual(yield* f.repository.peers(recipient), [sender]);
        const projection = yield* ProjectionStore.ProjectionStoreV2;
        assert.equal((yield* projection.getThread(recipient)).mailboxPendingCount, 1);
        assert.isAbove((yield* projection.getThread(sender)).mailboxRevision ?? 0, 0);
        assert.isTrue(yield* f.repository.canWake(recipient));
        assert.isTrue(
          (yield* Effect.result(f.send("request", "different body")))._tag === "Failure",
        );
      }),
  );
  it.effect("keeps delivery, read, acknowledgement and resolution as separate durable states", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const { recipient } = f;
      yield* f.send("request");
      const recipientExecution = MessageId.make("recipient-turn");
      yield* f.dispatch(recipient, {
        kind: "prepare",
        executionId: recipientExecution,
        turnKey: "recipient-key",
        providerSessionId: "recipient-session",
        contextBudget: 32_000,
        includeIncoming: true,
      });
      assert.equal((yield* f.repository.get({ threadId: recipient })).messages[0]?.state, "queued");
      yield* f.dispatch(recipient, {
        kind: "finish",
        executionId: recipientExecution,
        turnId: null,
        state: "submitted",
      });
      assert.equal(
        (yield* f.repository.get({ threadId: recipient })).messages[0]?.state,
        "included",
      );
      yield* f.dispatch(recipient, {
        kind: "read",
        executionId: recipientExecution,
        messageIds: ["request"],
      });
      yield* f.dispatch(recipient, { kind: "state", messageId: "request", state: "acknowledged" });
      let inbox = yield* f.repository.get({ threadId: recipient });
      assert.deepStrictEqual(inbox.turns[0]?.read, [`${f.prefix}:request`]);
      assert.deepStrictEqual(inbox.turns[0]?.incoming, [`${f.prefix}:request`]);
      assert.equal(inbox.messages[0]?.state, "acknowledged");
      yield* f.dispatch(recipient, { kind: "state", messageId: "request", state: "resolved" });
      inbox = yield* f.repository.get({ threadId: recipient });
      assert.equal(inbox.messages[0]?.state, "resolved");
      assert.isTrue(
        (yield* Effect.result(
          f.dispatch(recipient, { kind: "state", messageId: "request", state: "queued" }),
        ))._tag === "Failure",
      );
    }),
  );
  it.effect("requeues dismissed mail only for users and keeps history when unlinked", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const { sender, recipient } = f;
      yield* f.send("request");
      yield* f.dispatch(recipient, { kind: "state", messageId: "request", state: "dismissed" });
      yield* f.dispatch(recipient, { kind: "state", messageId: "request", state: "queued" });
      yield* f.dispatch(sender, { kind: "link", peerThreadId: recipient, linked: false });
      assert.isFalse(yield* f.repository.canWake(recipient));
      assert.lengthOf((yield* f.repository.get({ threadId: recipient })).messages, 1);
    }),
  );
  it.effect("rejects stale turn keys and cross-session mailbox access", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const { sender, recipient, executionId } = f;
      const result = yield* Effect.result(
        f.dispatch(
          sender,
          {
            kind: "send",
            id: "forged",
            toThreadId: recipient,
            executionId,
            body: "forged",
            replyTo: null,
          },
          { turnKey: `${f.prefix}:source-key`, providerSessionId: "another-session" },
        ),
      );
      assert.equal(result._tag, "Failure");
      assert.lengthOf((yield* f.repository.get({ threadId: recipient })).messages, 0);
    }),
  );
  it.effect(
    "preserves queued messages across pause/resume and applies bounded context references",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const { recipient } = f;
        yield* f.send("large", String.fromCharCode(1).repeat(8_000));
        yield* f.send("small", "The next request");
        yield* f.dispatch(recipient, { kind: "auto-wake", enabled: false });
        assert.isFalse(yield* f.repository.canWake(recipient));
        yield* f.dispatch(recipient, { kind: "auto-wake", enabled: true });
        assert.isTrue(yield* f.repository.canWake(recipient));
        const snapshot = yield* encodeMailboxSnapshot(
          yield* f.repository.messages(recipient, { pending: true }),
          32_000,
        );
        assert.include(snapshot.encoded, "mailbox_read");
        assert.include(snapshot.encoded, "The next request");
        assert.isBelow(snapshot.encoded.length, 32_000);
      }),
  );
  it.effect("does not admit mail over a queued user run or a pending request", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const { recipient } = f;
      yield* f.send("request");
      yield* f.sql`INSERT INTO orchestration_v2_projection_runtime_requests (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json) VALUES ('approval', ${recipient}, 'node', 'approval', 'pending', ${DateTime.formatIso(f.now)}, '{}')`;
      assert.isFalse(yield* f.repository.canWake(recipient));
      yield* f.sql`DELETE FROM orchestration_v2_projection_runtime_requests`;
      yield* f.sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json) VALUES ('queued-user', ${recipient}, 1, 'codex', 'codex', 'queued', ${DateTime.formatIso(f.now)}, '{}')`;
      assert.isFalse(yield* f.repository.canWake(recipient));
      yield* f.sql`DELETE FROM orchestration_v2_projection_runs`;
      assert.isTrue(yield* f.repository.canWake(recipient));
    }),
  );
});
