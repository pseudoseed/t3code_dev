import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";

export const MailboxId = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export const MailboxBody = TrimmedNonEmptyString.check(Schema.isMaxLength(8_000));
export const MailboxMessageState = Schema.Literals([
  "queued",
  "included",
  "acknowledged",
  "resolved",
  "dismissed",
]);
export const MailboxMessage = Schema.Struct({
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
export type MailboxMessage = typeof MailboxMessage.Type;

export const MailboxTurn = Schema.Struct({
  threadId: ThreadId,
  executionId: MessageId,
  turnId: Schema.NullOr(TurnId),
  state: Schema.Literals(["pending", "prepared", "submitted", "failed", "completed"]),
  source: Schema.optional(Schema.Literals(["user", "mailbox"])),
  incoming: Schema.Array(MailboxId),
  createdAt: IsoDateTime,
});
export type MailboxTurn = typeof MailboxTurn.Type;

const AutoWakeOperation = Schema.Struct({
  kind: Schema.Literal("auto-wake"),
  enabled: Schema.Boolean,
  reason: Schema.optional(Schema.String),
});

export const MailboxChange = Schema.Union([
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
export type MailboxChange = typeof MailboxChange.Type;

const LinkOperation = Schema.Struct({
  kind: Schema.Literal("link"),
  peerThreadId: ThreadId,
  linked: Schema.Boolean,
});
const StateOperation = Schema.Struct({
  kind: Schema.Literal("state"),
  messageId: MailboxId,
  state: Schema.Literals(["queued", "acknowledged", "resolved", "dismissed"]),
});
export const MailboxOperation = Schema.Union([
  AutoWakeOperation,
  Schema.Struct({ kind: Schema.Literal("wake"), executionId: MessageId, turnKey: Schema.String }),
  LinkOperation,
  StateOperation,
  Schema.Struct({
    kind: Schema.Literal("send"),
    id: MailboxId,
    toThreadId: ThreadId,
    executionId: MessageId,
    body: MailboxBody,
    replyTo: Schema.NullOr(MailboxId),
  }),
  Schema.Struct({
    kind: Schema.Literal("prepare"),
    executionId: MessageId,
    turnKey: Schema.String,
    providerSessionId: Schema.NullOr(Schema.String),
    contextBudget: NonNegativeInt,
    includeIncoming: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("finish"),
    executionId: MessageId,
    turnId: Schema.NullOr(TurnId),
    state: Schema.Literals(["submitted", "failed", "completed"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("read"),
    executionId: MessageId,
    messageIds: Schema.Array(MailboxId),
  }),
]);
export const ThreadMailboxCommand = Schema.Struct({
  type: Schema.Literal("thread.mailbox"),
  commandId: CommandId,
  threadId: ThreadId,
  operation: MailboxOperation,
  createdAt: IsoDateTime,
  actor: Schema.optional(
    Schema.Struct({ turnKey: Schema.String, providerSessionId: Schema.String }),
  ),
});
export type ThreadMailboxCommand = typeof ThreadMailboxCommand.Type;

export const MailboxCursor = Schema.Struct({ createdAt: IsoDateTime, id: MailboxId });
export const MailboxGetInput = Schema.Struct({
  threadId: ThreadId,
  before: Schema.optional(MailboxCursor),
  executionId: Schema.optional(MessageId),
  beforeTurn: Schema.optional(MessageId),
  messageId: Schema.optional(MailboxId),
});
export type MailboxGetInput = typeof MailboxGetInput.Type;
export const MailboxUpdateInput = Schema.Struct({
  threadId: ThreadId,
  commandId: CommandId,
  operation: Schema.Union([LinkOperation, StateOperation, AutoWakeOperation]),
});
export type MailboxUpdateInput = typeof MailboxUpdateInput.Type;
export const MailboxGetResult = Schema.Struct({
  autoWake: Schema.optional(
    Schema.Struct({ enabled: Schema.Boolean, reason: Schema.NullOr(Schema.String) }),
  ),
  peers: Schema.Array(ThreadId),
  pendingCount: NonNegativeInt,
  messages: Schema.Array(MailboxMessage),
  turns: Schema.Array(
    Schema.Struct({
      ...MailboxTurn.fields,
      read: Schema.Array(MailboxId),
      sent: Schema.Array(MailboxId),
    }),
  ),
  nextCursor: Schema.NullOr(MailboxCursor),
  nextTurnCursor: Schema.NullOr(MessageId),
});
export type MailboxGetResult = typeof MailboxGetResult.Type;

export class MailboxError extends Schema.TaggedErrorClass<MailboxError>()("MailboxError", {
  message: Schema.String,
}) {}
