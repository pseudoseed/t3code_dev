import * as Schema from "effect/Schema";
import { IsoDateTime, MessageId, ThreadId, TrimmedNonEmptyString, TurnId } from "./baseSchemas.ts";

const MailboxId = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const MailboxBody = TrimmedNonEmptyString.check(Schema.isMaxLength(8_000));
const MailboxMessageState = Schema.Literals([
  "queued",
  "included",
  "acknowledged",
  "resolved",
  "dismissed",
]);
const MailboxMessage = Schema.Struct({
  id: MailboxId,
  fromThreadId: ThreadId,
  toThreadId: ThreadId,
  executionId: MessageId,
  body: MailboxBody,
  replyTo: Schema.NullOr(MailboxId),
  state: MailboxMessageState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

const MailboxTurn = Schema.Struct({
  threadId: ThreadId,
  executionId: MessageId,
  turnId: Schema.NullOr(TurnId),
  state: Schema.Literals(["pending", "prepared", "submitted", "failed", "completed"]),
  source: Schema.optional(Schema.Literals(["user", "mailbox"])),
  incoming: Schema.Array(MailboxId),
  createdAt: IsoDateTime,
});

const AutoWakeOperation = Schema.Struct({
  kind: Schema.Literal("auto-wake"),
  enabled: Schema.Boolean,
  reason: Schema.optional(Schema.String),
});

// Released fork histories retain these events after the mailbox feature is retired.
export const LegacyMailboxChange = Schema.Union([
  AutoWakeOperation,
  Schema.Struct({ kind: Schema.Literal("link"), peerThreadId: ThreadId, linked: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("message"), message: MailboxMessage }),
  Schema.Struct({
    kind: Schema.Literal("state"),
    messageId: MailboxId,
    state: MailboxMessageState,
  }),
  Schema.Struct({
    kind: Schema.Literal("turn"),
    turn: MailboxTurn,
    turnKey: Schema.String,
    providerSessionId: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("read"),
    executionId: MessageId,
    messageIds: Schema.Array(MailboxId),
  }),
]);
