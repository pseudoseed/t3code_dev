import * as NodeCrypto from "node:crypto";
import {
  MailboxBody,
  MailboxCursor,
  MailboxError,
  MailboxId,
  MailboxMessage,
  MailboxMessageState,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { McpInvocationContext } from "../McpInvocationContext.ts";
import { makeAgentMailbox } from "../../orchestration/AgentMailbox.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

const turnKey = Schema.String.annotate({
  description: "The mailbox turn key supplied in this turn's agent_mailbox context.",
});
const dependencies = [McpInvocationContext];
export const MailboxToolkit = Toolkit.make(
  Tool.make("mailbox_peers", {
    description:
      "Discover threads explicitly linked for collaboration, including their projects and titles.",
    parameters: Schema.Struct({ turnKey }),
    // MCP only allows object-shaped structured content, so the list is wrapped.
    success: Schema.Struct({
      peers: Schema.Array(
        Schema.Struct({ threadId: ThreadId, title: Schema.String, project: Schema.String }),
      ),
    }),
    failure: MailboxError,
    dependencies,
  }),
  Tool.make("mailbox_send", {
    description:
      "Persist a message for a linked thread. Mail automatically wakes an idle recipient. While it is working, mail waits without steering, interrupting, or cancelling it. Reuse the same retryKey if retrying the same send.",
    parameters: Schema.Struct({
      turnKey,
      toThreadId: ThreadId,
      body: MailboxBody,
      replyTo: Schema.optional(MailboxId),
      retryKey: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
    }),
    success: Schema.Struct({ messageId: MailboxId, status: MailboxMessageState }),
    failure: MailboxError,
    dependencies,
  }),
  Tool.make("mailbox_read", {
    description:
      "Read your mailbox voluntarily. Reading records which messages this turn was supplied; it does not acknowledge or resolve their work. Use messageId to retrieve a specific older message, or before to page history.",
    parameters: Schema.Struct({
      turnKey,
      messageId: Schema.optional(MailboxId),
      before: Schema.optional(MailboxCursor),
    }),
    success: Schema.Struct({
      messages: Schema.Array(MailboxMessage),
      nextCursor: Schema.NullOr(MailboxCursor),
    }),
    failure: MailboxError,
    dependencies,
  }),
  Tool.make("mailbox_acknowledge", {
    description:
      "Acknowledge an incoming message, or mark its request resolved after completing the work. This never sends a reply or starts another turn.",
    parameters: Schema.Struct({
      turnKey,
      messageId: MailboxId,
      state: Schema.Literals(["acknowledged", "resolved"]),
    }),
    success: Schema.Struct({
      messageId: MailboxId,
      state: Schema.Literals(["acknowledged", "resolved"]),
    }),
    failure: MailboxError,
    dependencies,
  }),
);

export const MailboxToolkitHandlersLive = MailboxToolkit.toLayer(
  Effect.gen(function* () {
    const mailbox = yield* makeAgentMailbox;
    const snapshots = yield* ProjectionSnapshotQuery;
    const error = (cause: { message: string }) => new MailboxError({ message: cause.message });
    return {
      mailbox_peers: Effect.fn("mcp.mailbox.peers")(function* (input) {
        const scope = yield* McpInvocationContext;
        yield* mailbox.agentTurn(scope, input.turnKey);
        const peers = yield* mailbox.repository.peers(scope.threadId);
        const snapshot = yield* snapshots.getShellSnapshot();
        return {
          peers: snapshot.threads
            .filter((thread) => peers.includes(thread.id))
            .map((thread) => ({
              threadId: thread.id,
              title: thread.title,
              project:
                snapshot.projects.find((project) => project.id === thread.projectId)?.title ??
                "Unknown project",
            })),
        };
      }, Effect.mapError(error)),
      mailbox_send: Effect.fn("mcp.mailbox.send")(function* (input) {
        const scope = yield* McpInvocationContext;
        const turn = yield* mailbox.agentTurn(scope, input.turnKey);
        const messageId = NodeCrypto.createHash("sha256")
          .update(`${scope.threadId.length}:${scope.threadId}${input.retryKey}`)
          .digest("hex");
        yield* mailbox.dispatch(
          scope.threadId,
          {
            kind: "send",
            id: messageId,
            executionId: turn.executionId,
            toThreadId: input.toThreadId,
            body: input.body,
            replyTo: input.replyTo ?? null,
          },
          { turnKey: input.turnKey, providerSessionId: scope.providerSessionId },
        );
        const message = (yield* mailbox.repository
          .messages(scope.threadId, { id: messageId })
          .pipe(Effect.mapError(error)))[0];
        return { messageId, status: message?.state ?? "queued" };
      }),
      mailbox_read: Effect.fn("mcp.mailbox.read")(function* (input) {
        const scope = yield* McpInvocationContext;
        const turn = yield* mailbox.agentTurn(scope, input.turnKey);
        const page = yield* mailbox.repository.get({
          threadId: scope.threadId,
          ...(input.before === undefined ? {} : { before: input.before }),
        });
        const messages =
          input.messageId === undefined
            ? page.messages
            : yield* mailbox.repository.messages(scope.threadId, { id: input.messageId });
        yield* mailbox.dispatch(
          scope.threadId,
          {
            kind: "read",
            executionId: turn.executionId,
            messageIds: messages
              .filter((message) => message.toThreadId === scope.threadId)
              .map((message) => message.id),
          },
          { turnKey: input.turnKey, providerSessionId: scope.providerSessionId },
        );
        return { messages, nextCursor: input.messageId === undefined ? page.nextCursor : null };
      }, Effect.mapError(error)),
      mailbox_acknowledge: Effect.fn("mcp.mailbox.acknowledge")(function* (input) {
        const scope = yield* McpInvocationContext;
        yield* mailbox.agentTurn(scope, input.turnKey);
        yield* mailbox.dispatch(
          scope.threadId,
          { kind: "state", messageId: input.messageId, state: input.state },
          { turnKey: input.turnKey, providerSessionId: scope.providerSessionId },
        );
        return { messageId: input.messageId, state: input.state };
      }),
    };
  }),
);
