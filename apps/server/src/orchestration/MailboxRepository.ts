import {
  MailboxError,
  MailboxMessage,
  MailboxTurn,
  type MailboxChange,
  type MailboxGetInput,
  type MailboxGetResult,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadId,
  type ThreadMailboxCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError, PersistenceDecodeError } from "../persistence/Errors.ts";
import { encodeMailboxSnapshot } from "./MailboxContext.ts";

const StoredTurn = Schema.Struct({
  ...MailboxTurn.fields,
  turnKey: Schema.String,
  providerSessionId: Schema.NullOr(Schema.String),
});
const decodeMessages = Schema.decodeUnknownEffect(Schema.Array(MailboxMessage));
const decodeTurns = Schema.decodeUnknownEffect(Schema.Array(StoredTurn));
const decodeIds = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const terminal = (state: MailboxMessage["state"]) => state === "resolved" || state === "dismissed";

/** All writes are projections of committed orchestration events. Callers never mutate the inbox directly. */
export const makeMailboxRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const messages = Effect.fn("Mailbox.messages")(function* (
    threadId: ThreadId,
    options: {
      id?: string;
      pending?: boolean;
      before?: MailboxGetInput["before"];
      executionId?: string;
      limit?: number;
    } = {},
  ) {
    return yield* sql`SELECT id, from_thread_id AS "fromThreadId", to_thread_id AS "toThreadId",
      execution_id AS "executionId", body, reply_to AS "replyTo", state,
      created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_mailbox_messages WHERE (from_thread_id = ${threadId} OR to_thread_id = ${threadId})
      ${options.id === undefined ? sql`` : sql`AND id = ${options.id}`}
      ${options.pending ? sql`AND to_thread_id = ${threadId} AND state = 'queued' AND from_thread_id IN (SELECT peer_thread_id FROM projection_mailbox_links WHERE thread_id = ${threadId})` : sql``}
      ${options.executionId === undefined ? sql`` : sql`AND from_thread_id = ${threadId} AND execution_id = ${options.executionId}`}
      ${options.before === undefined ? sql`` : sql`AND (created_at < ${options.before.createdAt} OR (created_at = ${options.before.createdAt} AND id < ${options.before.id}))`}
      ORDER BY ${options.pending ? sql`created_at ASC, id ASC` : sql`created_at DESC, id DESC`} LIMIT ${options.limit ?? 31}`.pipe(
      Effect.flatMap(decodeMessages),
    );
  });
  const turns = Effect.fn("Mailbox.turns")(function* (
    threadId: ThreadId,
    executionId?: string,
    beforeTurn?: string,
  ) {
    const rows = yield* sql<{
      threadId: string;
      executionId: string;
      turnId: string | null;
      state: string;
      incomingJson: string;
      createdAt: string;
      turnKey: string;
      providerSessionId: string | null;
    }>`
      SELECT thread_id AS "threadId", execution_id AS "executionId", turn_id AS "turnId", state,
        incoming_json AS "incomingJson", created_at AS "createdAt", turn_key AS "turnKey", provider_session_id AS "providerSessionId", source
      FROM projection_mailbox_turns WHERE thread_id = ${threadId} ${executionId === undefined ? sql`` : sql`AND execution_id = ${executionId}`} ${beforeTurn === undefined ? sql`` : sql`AND rowid < (SELECT rowid FROM projection_mailbox_turns WHERE thread_id = ${threadId} AND execution_id = ${beforeTurn})`} ORDER BY rowid DESC LIMIT 31`;
    return yield* Effect.forEach(rows, (row) =>
      decodeIds(row.incomingJson).pipe(Effect.map((incoming) => ({ ...row, incoming }))),
    ).pipe(Effect.flatMap(decodeTurns));
  });
  const peers = Effect.fn("Mailbox.peers")(function* (threadId: ThreadId) {
    const rows = yield* sql<{
      peerThreadId: ThreadId;
    }>`SELECT peer_thread_id AS "peerThreadId" FROM projection_mailbox_links WHERE thread_id = ${threadId}`;
    return rows.map((row) => row.peerThreadId);
  });

  const unresolvedCount = Effect.fn("Mailbox.unresolvedCount")(function* (threadId: ThreadId) {
    const rows = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM projection_mailbox_messages WHERE to_thread_id = ${threadId} AND state IN ('included', 'acknowledged')`;
    return rows[0]?.count ?? 0;
  });

  const autoWake = Effect.fn("Mailbox.autoWake")(function* (threadId: ThreadId) {
    const rows = yield* sql<{
      enabled: number;
      reason: string | null;
    }>`SELECT enabled, reason FROM projection_mailbox_controls WHERE thread_id = ${threadId}`;
    return { enabled: rows[0]?.enabled !== 0, reason: rows[0]?.reason ?? null };
  });

  /** Check durable turn admission, including starts whose provider has not responded yet. */
  const canWake = Effect.fn("Mailbox.canWake")(function* (
    threadId: ThreadId,
    executionId?: string,
  ) {
    const queued = yield* sql`SELECT 1 FROM projection_mailbox_messages m
      JOIN projection_mailbox_links l ON l.thread_id = m.to_thread_id AND l.peer_thread_id = m.from_thread_id
      WHERE m.to_thread_id = ${threadId} AND m.state = 'queued' LIMIT 1`;
    if (queued.length === 0) return false;
    if (!(yield* autoWake(threadId)).enabled) return false;
    const now = DateTime.formatIso(yield* DateTime.now);
    const busy = yield* sql`SELECT 1 FROM projection_threads t
      LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
      WHERE t.thread_id = ${threadId} AND (
        t.deleted_at IS NOT NULL OR t.archived_at IS NOT NULL OR t.snoozed_until > ${now}
        OR t.pending_approval_count > 0 OR t.pending_user_input_count > 0
        OR s.status IN ('starting', 'running') OR s.active_turn_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM projection_turns p WHERE p.thread_id = t.thread_id AND
          (p.state = 'running' OR (p.state = 'pending' AND ${executionId === undefined ? sql`1` : sql`p.pending_message_id != ${executionId}`})))
        OR EXISTS (SELECT 1 FROM projection_turns p WHERE p.thread_id = t.thread_id AND p.turn_id = t.latest_turn_id AND p.checkpoint_status IS NULL)
      )`;
    if (busy.length > 0) return false;
    const previous = (yield* turns(threadId))[0];
    if (
      previous &&
      previous.executionId !== executionId &&
      ["pending", "prepared", "submitted"].includes(previous.state)
    )
      return false;
    return true;
  });

  const wakeCandidates = Effect.fn("Mailbox.wakeCandidates")(function* () {
    return yield* sql<{
      threadId: ThreadId;
    }>`SELECT DISTINCT to_thread_id AS "threadId" FROM projection_mailbox_messages WHERE state = 'queued'`;
  });
  const snoozedUntil = Effect.fn("Mailbox.snoozedUntil")(function* (threadId: ThreadId) {
    const rows = yield* sql<{
      until: string | null;
    }>`SELECT snoozed_until AS until FROM projection_threads WHERE thread_id = ${threadId}
      AND mailbox_pending_count > 0 AND archived_at IS NULL AND deleted_at IS NULL`;
    return rows[0]?.until ?? null;
  });

  const get = Effect.fn("Mailbox.get")(function* (input: MailboxGetInput) {
    const page = yield* messages(input.threadId, {
      ...(input.messageId === undefined ? {} : { id: input.messageId }),
      ...(input.before === undefined ? {} : { before: input.before }),
    });
    const records = yield* turns(input.threadId, input.executionId, input.beforeTurn);
    const counts = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM projection_mailbox_messages WHERE to_thread_id = ${input.threadId} AND state = 'queued'`;
    const sent = yield* sql<{
      id: string;
      executionId: string;
    }>`SELECT id, execution_id AS "executionId" FROM projection_mailbox_messages WHERE from_thread_id = ${input.threadId} AND ${sql.in(
      "execution_id",
      records.map((record) => record.executionId),
    )}`;
    const read = yield* sql<{
      executionId: string;
      messageId: string;
    }>`SELECT execution_id AS "executionId", message_id AS "messageId" FROM projection_mailbox_reads WHERE thread_id = ${input.threadId} AND ${sql.in(
      "execution_id",
      records.map((record) => record.executionId),
    )}`;
    return {
      autoWake: yield* autoWake(input.threadId),
      peers: yield* peers(input.threadId),
      pendingCount: counts[0]?.count ?? 0,
      messages: page.slice(0, 30),
      turns: records.slice(0, 30).map((turn) => ({
        threadId: turn.threadId,
        executionId: turn.executionId,
        turnId: turn.turnId,
        state: turn.state,
        source: turn.source,
        incoming: turn.incoming,
        createdAt: turn.createdAt,
        read: read
          .filter((entry) => entry.executionId === turn.executionId)
          .map((entry) => entry.messageId),
        sent: sent
          .filter((message) => message.executionId === turn.executionId)
          .map((message) => message.id),
      })),
      nextTurnCursor: records.length > 30 ? records[29]!.executionId : null,
      nextCursor: page.length > 30 ? { createdAt: page[29]!.createdAt, id: page[29]!.id } : null,
    } satisfies MailboxGetResult;
  });

  const decide = Effect.fn("Mailbox.decide")(function* (
    command: ThreadMailboxCommand,
    readModel: OrchestrationReadModel,
  ) {
    const { threadId, operation: op, createdAt } = command;
    const thread = readModel.threads.find(
      (entry) => entry.id === threadId && entry.deletedAt === null,
    );
    if (!thread) return yield* new MailboxError({ message: "This thread no longer exists." });
    const fail = (message: string) => Effect.fail(new MailboxError({ message }));
    if (command.actor) {
      const current = (yield* turns(threadId)).find(
        (turn) => turn.turnKey === command.actor!.turnKey,
      );
      const latest = (yield* turns(threadId))[0];
      if (
        !current ||
        current.providerSessionId !== command.actor.providerSessionId ||
        current.executionId !== latest?.executionId ||
        (current.state !== "prepared" && current.state !== "submitted")
      )
        return yield* fail("This mailbox key does not belong to the current agent turn.");
      if (
        thread.session?.status === "stopped" ||
        thread.session?.status === "error" ||
        thread.session?.status === "interrupted"
      )
        return yield* fail("The agent session is no longer active.");
    }
    switch (op.kind) {
      case "auto-wake": {
        const previous = (yield* turns(threadId))[0];
        const changes: MailboxChange[] = [
          { kind: "auto-wake", enabled: op.enabled, ...(op.reason ? { reason: op.reason } : {}) },
        ];
        if (
          op.enabled &&
          previous?.state === "prepared" &&
          !thread.session?.activeTurnId &&
          thread.session?.status !== "starting" &&
          thread.session?.status !== "running"
        )
          changes.push({
            kind: "turn",
            turn: { ...previous, state: "failed" },
            turnKey: previous.turnKey,
            providerSessionId: previous.providerSessionId,
          });
        return changes;
      }
      case "wake": {
        const previous = (yield* turns(threadId, op.executionId))[0];
        if (
          !(yield* canWake(
            threadId,
            previous?.state === "pending" ? previous.executionId : undefined,
          ))
        )
          return [];
        return [
          {
            kind: "turn",
            turn: {
              threadId,
              executionId: op.executionId,
              turnId: null,
              state: "pending",
              source: "mailbox",
              incoming: [],
              createdAt,
            },
            turnKey: op.turnKey,
            providerSessionId: null,
          },
        ] satisfies MailboxChange[];
      }
      case "link": {
        if (op.peerThreadId === threadId)
          return yield* fail("Choose another thread to collaborate with.");
        const peer = readModel.threads.find(
          (entry) => entry.id === op.peerThreadId && entry.deletedAt === null,
        );
        if (!peer) return yield* fail("The other thread no longer exists.");
        return [
          { kind: "link", peerThreadId: op.peerThreadId, linked: op.linked },
        ] satisfies MailboxChange[];
      }
      case "send": {
        const existing = (yield* messages(threadId, { id: op.id })).find(
          (message) => message.id === op.id,
        );
        if (existing) {
          if (
            existing.fromThreadId !== threadId ||
            existing.toThreadId !== op.toThreadId ||
            existing.body !== op.body ||
            existing.replyTo !== op.replyTo ||
            existing.executionId !== op.executionId
          )
            return yield* fail("This message retry key was already used for a different message.");
          return [{ kind: "message", message: existing }] satisfies MailboxChange[];
        }
        if (!(yield* peers(threadId)).includes(op.toThreadId))
          return yield* fail("These threads are not linked for collaboration.");
        const recipient = readModel.threads.find(
          (entry) => entry.id === op.toThreadId && entry.deletedAt === null,
        );
        if (!recipient || recipient.archivedAt !== null)
          return yield* fail("The recipient thread is unavailable.");
        if (
          !(yield* turns(threadId, op.executionId)).some(
            (turn) =>
              turn.executionId === op.executionId &&
              (turn.state === "prepared" || turn.state === "submitted"),
          )
        )
          return yield* fail("The sending turn is no longer active.");
        if (
          op.replyTo !== null &&
          !(yield* messages(threadId, { id: op.replyTo })).some(
            (message) =>
              message.id === op.replyTo &&
              message.fromThreadId === op.toThreadId &&
              message.toThreadId === threadId,
          )
        )
          return yield* fail("The replied-to message must come from this recipient.");
        return [
          {
            kind: "message",
            message: {
              id: op.id,
              fromThreadId: threadId,
              toThreadId: op.toThreadId,
              executionId: op.executionId,
              body: op.body,
              replyTo: op.replyTo,
              state: "queued",
              createdAt,
              updatedAt: createdAt,
            },
          },
        ] satisfies MailboxChange[];
      }
      case "state": {
        const message = (yield* messages(threadId, { id: op.messageId })).find(
          (entry) => entry.id === op.messageId,
        );
        if (!message || message.toThreadId !== threadId)
          return yield* fail("Only the recipient can update this message.");
        const restoreDismissed =
          message.state === "dismissed" && op.state === "queued" && !command.actor;
        if (op.state === "queued" && !restoreDismissed)
          return yield* fail("Only a user can restore a dismissed message.");
        if (terminal(message.state) && message.state !== op.state && !restoreDismissed)
          return yield* fail("This message is already resolved or dismissed.");
        return [
          { kind: "state", messageId: op.messageId, state: op.state },
        ] satisfies MailboxChange[];
      }
      case "prepare": {
        const existing = (yield* turns(threadId, op.executionId)).find(
          (turn) => turn.executionId === op.executionId,
        );
        if (existing && existing.state !== "pending")
          return yield* fail("This turn already has a mailbox snapshot.");
        const previous = (yield* turns(threadId))[0];
        const active =
          thread.session?.activeTurnId != null ||
          (previous?.state === "prepared" && previous.providerSessionId === op.providerSessionId);
        const incoming =
          !active &&
          thread.archivedAt === null &&
          op.providerSessionId !== null &&
          op.includeIncoming
            ? (yield* encodeMailboxSnapshot(
                yield* messages(threadId, { pending: true, limit: 8 }),
                op.contextBudget,
              )).incoming
            : [];
        return [
          {
            kind: "turn",
            turn: {
              threadId,
              executionId: op.executionId,
              turnId: null,
              state: "prepared",
              source: existing?.source ?? "user",
              incoming,
              createdAt,
            },
            turnKey: op.turnKey,
            providerSessionId: op.providerSessionId,
          },
        ] satisfies MailboxChange[];
      }
      case "finish": {
        const existing = (yield* turns(threadId, op.executionId)).find(
          (turn) => turn.executionId === op.executionId,
        );
        if (!existing) return yield* fail("The turn has no mailbox snapshot.");
        const state = existing.state === "completed" ? "completed" : op.state;
        return [
          {
            kind: "turn",
            turn: { ...existing, turnId: op.turnId ?? existing.turnId, state },
            turnKey: existing.turnKey,
            providerSessionId: existing.providerSessionId,
          },
        ] satisfies MailboxChange[];
      }
      case "read": {
        const inbox = yield* Effect.forEach(op.messageIds, (id) => messages(threadId, { id }));
        if (
          !op.messageIds.every((id) =>
            inbox.flat().some((message) => message.id === id && message.toThreadId === threadId),
          )
        )
          return yield* fail("The message is not in this inbox.");
        return [
          { kind: "read", executionId: op.executionId, messageIds: op.messageIds },
        ] satisfies MailboxChange[];
      }
    }
  });

  const participants = Effect.fn("Mailbox.participants")(function* (
    threadId: ThreadId,
    change: MailboxChange,
  ) {
    const ids = new Set([threadId]);
    if (change.kind === "link") ids.add(change.peerThreadId);
    if (change.kind === "message") ids.add(change.message.toThreadId);
    const messageIds =
      change.kind === "state"
        ? [change.messageId]
        : change.kind === "read"
          ? change.messageIds
          : change.kind === "turn" &&
              (change.turn.state === "submitted" || change.turn.state === "completed")
            ? change.turn.incoming
            : [];
    if (messageIds.length > 0) {
      const rows = yield* sql<{
        fromThreadId: ThreadId;
      }>`SELECT DISTINCT from_thread_id AS "fromThreadId" FROM projection_mailbox_messages WHERE ${sql.in("id", messageIds)}`;
      for (const row of rows) ids.add(row.fromThreadId);
    }
    return [...ids];
  });

  const project = Effect.fn("Mailbox.project")(
    function* (event: OrchestrationEvent) {
      const pause = Effect.fn("Mailbox.pause")(function* (threadId: ThreadId, reason: string) {
        yield* sql`INSERT INTO projection_mailbox_controls (thread_id, enabled, reason) VALUES (${threadId}, 0, ${reason})
          ON CONFLICT(thread_id) DO UPDATE SET enabled = 0, reason = excluded.reason`;
        yield* sql`UPDATE projection_threads SET mailbox_revision = ${event.sequence} WHERE thread_id = ${threadId}`;
      });
      if (
        event.type === "thread.turn-interrupt-requested" ||
        (event.type === "thread.session-stop-requested" && !event.payload.preserveMailboxWake)
      ) {
        yield* pause(
          event.payload.threadId,
          "Paused after you stopped the agent. Resume automatic wake when ready.",
        );
        yield* sql`DELETE FROM projection_turns WHERE thread_id = ${event.payload.threadId} AND state = 'pending' AND pending_message_id IN
          (SELECT execution_id FROM projection_mailbox_turns WHERE thread_id = ${event.payload.threadId} AND source = 'mailbox' AND state = 'pending')`;
        yield* sql`UPDATE projection_mailbox_turns SET state = 'failed' WHERE thread_id = ${event.payload.threadId} AND state = 'pending'`;
        return;
      }
      if (event.type === "thread.turn-start-requested" && !event.payload.mailboxWake) {
        yield* sql`UPDATE projection_mailbox_turns SET state = 'failed' WHERE thread_id = ${event.payload.threadId} AND state = 'pending'`;
        return;
      }
      if (
        event.type === "thread.activity-appended" &&
        event.payload.activity.kind === "provider.turn.start.failed"
      ) {
        yield* pause(
          event.payload.threadId,
          "The agent could not start. Fix the reported error, then resume automatic wake to retry queued mail.",
        );
        yield* sql`UPDATE projection_mailbox_turns SET state = 'failed' WHERE thread_id = ${event.payload.threadId} AND state IN ('pending', 'prepared')`;
        return;
      }
      if (event.type === "thread.deleted") {
        yield* sql`DELETE FROM projection_mailbox_links WHERE thread_id = ${event.payload.threadId} OR peer_thread_id = ${event.payload.threadId}`;
        return;
      }
      if (event.type === "thread.session-set") {
        const { threadId, session } = event.payload;
        if (session.status === "error" || session.status === "interrupted") {
          yield* pause(
            threadId,
            "The agent stopped with an error or interruption. Resume automatic wake when ready.",
          );
        }
        if (session.status === "running" && session.activeTurnId !== null) {
          yield* sql`UPDATE projection_mailbox_turns SET turn_id = ${session.activeTurnId}, state = 'submitted'
          WHERE thread_id = ${threadId} AND state = 'prepared' AND rowid = (SELECT MAX(rowid) FROM projection_mailbox_turns WHERE thread_id = ${threadId})`;
          yield* sql`UPDATE projection_mailbox_messages SET state = 'included', updated_at = ${event.occurredAt}
          WHERE state = 'queued' AND id IN (SELECT j.value FROM projection_mailbox_turns t, json_each(t.incoming_json) j WHERE t.thread_id = ${threadId} AND t.turn_id = ${session.activeTurnId} AND projection_mailbox_messages.queued_sequence <= t.prepared_sequence)`;
        } else if (session.status !== "running" && session.status !== "starting") {
          yield* sql`UPDATE projection_mailbox_turns SET state = 'completed' WHERE thread_id = ${threadId} AND state = 'submitted'`;
        }
        yield* sql`UPDATE projection_threads SET mailbox_pending_count = (SELECT COUNT(*) FROM projection_mailbox_messages WHERE to_thread_id = ${threadId} AND state = 'queued'), mailbox_revision = ${event.sequence} WHERE thread_id = ${threadId}`;
        return;
      }
      if (event.type !== "thread.mailbox-updated") return;
      const { threadId, change, createdAt } = event.payload;
      switch (change.kind) {
        case "auto-wake":
          yield* sql`INSERT INTO projection_mailbox_controls (thread_id, enabled, reason) VALUES (${threadId}, ${change.enabled ? 1 : 0}, ${change.reason ?? null})
            ON CONFLICT(thread_id) DO UPDATE SET enabled = excluded.enabled, reason = excluded.reason`;
          break;
        case "link":
          for (const [left, right] of [
            [threadId, change.peerThreadId],
            [change.peerThreadId, threadId],
          ]) {
            if (change.linked)
              yield* sql`INSERT OR IGNORE INTO projection_mailbox_links (thread_id, peer_thread_id) VALUES (${left}, ${right})`;
            else
              yield* sql`DELETE FROM projection_mailbox_links WHERE thread_id = ${left} AND peer_thread_id = ${right}`;
          }
          break;
        case "message": {
          const m = change.message;
          yield* sql`INSERT OR IGNORE INTO projection_mailbox_messages (id, from_thread_id, to_thread_id, execution_id, body, reply_to, state, created_at, updated_at, queued_sequence)
          VALUES (${m.id}, ${m.fromThreadId}, ${m.toThreadId}, ${m.executionId}, ${m.body}, ${m.replyTo}, ${m.state}, ${m.createdAt}, ${m.updatedAt}, ${event.sequence})`;
          break;
        }
        case "state":
          yield* sql`UPDATE projection_mailbox_messages SET state = ${change.state}, updated_at = ${createdAt}, queued_sequence = CASE WHEN ${change.state} = 'queued' THEN ${event.sequence} ELSE queued_sequence END WHERE id = ${change.messageId}`;
          break;
        case "turn": {
          const t = change.turn;
          const incomingJson = yield* encodeIds(t.incoming).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError("Mailbox.project", cause),
            ),
          );
          yield* sql`INSERT INTO projection_mailbox_turns (thread_id, execution_id, turn_id, state, incoming_json, created_at, turn_key, provider_session_id, prepared_sequence, source)
          VALUES (${threadId}, ${t.executionId}, ${t.turnId}, ${t.state}, ${incomingJson}, ${t.createdAt}, ${change.turnKey}, ${change.providerSessionId}, ${event.sequence}, ${t.source ?? "user"})
          ON CONFLICT (thread_id, execution_id) DO UPDATE SET turn_id = excluded.turn_id, state = excluded.state,
            incoming_json = CASE WHEN projection_mailbox_turns.state = 'pending' THEN excluded.incoming_json ELSE projection_mailbox_turns.incoming_json END,
            turn_key = CASE WHEN projection_mailbox_turns.state = 'pending' THEN excluded.turn_key ELSE projection_mailbox_turns.turn_key END,
            provider_session_id = CASE WHEN projection_mailbox_turns.state = 'pending' THEN excluded.provider_session_id ELSE projection_mailbox_turns.provider_session_id END,
            prepared_sequence = CASE WHEN projection_mailbox_turns.state = 'pending' THEN excluded.prepared_sequence ELSE projection_mailbox_turns.prepared_sequence END`;
          if (t.state === "failed")
            yield* sql`DELETE FROM projection_turns WHERE thread_id = ${threadId} AND pending_message_id = ${t.executionId} AND state = 'pending'`;
          if (t.state === "submitted" || t.state === "completed") {
            for (const id of t.incoming)
              yield* sql`UPDATE projection_mailbox_messages SET state = 'included', updated_at = ${createdAt} WHERE id = ${id} AND state = 'queued' AND queued_sequence <= (SELECT prepared_sequence FROM projection_mailbox_turns WHERE thread_id = ${threadId} AND execution_id = ${t.executionId})`;
          }
          break;
        }
        case "read":
          for (const id of change.messageIds) {
            yield* sql`INSERT OR IGNORE INTO projection_mailbox_reads (thread_id, execution_id, message_id) VALUES (${threadId}, ${change.executionId}, ${id})`;
            yield* sql`UPDATE projection_mailbox_messages SET state = 'included', updated_at = ${createdAt} WHERE id = ${id} AND state = 'queued'`;
          }
      }
      for (const id of yield* participants(threadId, change))
        yield* sql`UPDATE projection_threads SET
      mailbox_pending_count = (SELECT COUNT(*) FROM projection_mailbox_messages WHERE to_thread_id = ${id} AND state = 'queued'),
      mailbox_revision = ${event.sequence} WHERE thread_id = ${id}`;
    },
    Effect.catchTag("SqlError", (error) =>
      Effect.fail(toPersistenceSqlError("Mailbox.project")(error)),
    ),
  );
  const exists = Effect.fn("Mailbox.exists")(function* (threadId: ThreadId) {
    const rows =
      yield* sql`SELECT 1 FROM projection_threads WHERE thread_id = ${threadId} AND deleted_at IS NULL`;
    return rows.length > 0;
  });
  return {
    messages,
    turns,
    peers,
    get,
    decide,
    project,
    participants,
    unresolvedCount,
    exists,
    autoWake,
    canWake,
    wakeCandidates,
    snoozedUntil,
  };
});
