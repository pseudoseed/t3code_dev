import * as Crypto from "effect/Crypto";
import {
  OrchestratorMcpFailure,
  MailboxBody,
  MailboxCursor,
  MailboxError,
  MailboxId,
  MailboxMessage,
  MailboxMessageState,
  MailboxSearch,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { McpInvocationContext } from "../McpInvocationContext.ts";
import { makeAgentMailbox } from "../../orchestration-v2/AgentMailbox.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import * as McpToolAccess from "../McpToolAccess.ts";

const turnKey = Schema.String.annotate({
  description: "The mailbox turn key supplied in this turn's agent_mailbox context.",
});
const dependencies = [McpInvocationContext, ThreadManagementService];
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
    failure: Schema.Union([MailboxError, OrchestratorMcpFailure]),
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
    failure: Schema.Union([MailboxError, OrchestratorMcpFailure]),
    dependencies,
  }),
  Tool.make("mailbox_read", {
    description:
      "Read your mailbox voluntarily. Reading records which messages this turn was supplied; it does not acknowledge or resolve their work. Use peerThreadId to read a conversation, search to find text across its history, messageId to retrieve a specific older message, or before to page history.",
    parameters: Schema.Struct({
      turnKey,
      peerThreadId: Schema.optional(ThreadId),
      search: Schema.optional(MailboxSearch),
      messageId: Schema.optional(MailboxId),
      before: Schema.optional(MailboxCursor),
    }),
    success: Schema.Struct({
      messages: Schema.Array(MailboxMessage),
      nextCursor: Schema.NullOr(MailboxCursor),
    }),
    failure: Schema.Union([MailboxError, OrchestratorMcpFailure]),
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
    failure: Schema.Union([MailboxError, OrchestratorMcpFailure]),
    dependencies,
  }),
);

export const MailboxToolkitHandlersLive = McpToolAccess.toLayer(
  MailboxToolkit,
  Effect.gen(function* () {
    const mailbox = yield* makeAgentMailbox;
    const crypto = yield* Crypto.Crypto;
    const threads = yield* ThreadManagementService;
    const projects = yield* ProjectService;
    const error = (cause: { message: string }) => new MailboxError({ message: cause.message });
    return {
      mailbox_peers: McpToolAccess.readsAsCaller(
        Effect.fn("mcp.mailbox.peers")(function* (input) {
          const scope = yield* McpInvocationContext;
          yield* mailbox.agentTurn(scope, input.turnKey);
          const peers = yield* mailbox.repository.peers(scope.thread!.threadId);
          const snapshot = yield* threads.getShellSnapshot({});
          const projectList = yield* projects.listShells();
          return {
            peers: snapshot.threads
              .filter((thread) => peers.includes(thread.id))
              .map((thread) => ({
                threadId: thread.id,
                title: thread.title,
                project:
                  projectList.find((project) => project.id === thread.projectId)?.title ??
                  "Unknown project",
              })),
          };
        }, Effect.mapError(error)),
      ),
      mailbox_send: McpToolAccess.writesThreads(
        (input) => [input.toThreadId],
        Effect.fn("mcp.mailbox.send")(function* (input) {
          const scope = yield* McpInvocationContext;
          const turn = yield* mailbox.agentTurn(scope, input.turnKey);
          const digest = yield* crypto
            .digest(
              "SHA-256",
              new TextEncoder().encode(
                `${scope.thread!.threadId.length}:${scope.thread!.threadId}${input.retryKey}`,
              ),
            )
            .pipe(Effect.orDie);
          const messageId = Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
          yield* mailbox.dispatch(
            scope.thread!.threadId,
            {
              kind: "send",
              id: messageId,
              executionId: turn.executionId,
              toThreadId: input.toThreadId,
              body: input.body,
              replyTo: input.replyTo ?? null,
            },
            { turnKey: input.turnKey, providerSessionId: scope.thread!.providerSessionId },
          );
          const message = (yield* mailbox.repository
            .messages(scope.thread!.threadId, { id: messageId })
            .pipe(Effect.mapError(error)))[0];
          return { messageId, status: message?.state ?? "queued" };
        }),
      ),
      mailbox_read: McpToolAccess.actsAsCaller(
        Effect.fn("mcp.mailbox.read")(function* (input) {
          const scope = yield* McpInvocationContext;
          const turn = yield* mailbox.agentTurn(scope, input.turnKey);
          const page = yield* mailbox.repository.get({
            threadId: scope.thread!.threadId,
            ...(input.before === undefined || input.messageId !== undefined
              ? {}
              : { before: input.before }),
            ...(input.peerThreadId === undefined ? {} : { peerThreadId: input.peerThreadId }),
            ...(input.search === undefined ? {} : { search: input.search }),
            ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
          });
          const messages = page.messages;
          yield* mailbox.dispatch(
            scope.thread!.threadId,
            {
              kind: "read",
              executionId: turn.executionId,
              messageIds: messages
                .filter((message) => message.toThreadId === scope.thread!.threadId)
                .map((message) => message.id),
            },
            { turnKey: input.turnKey, providerSessionId: scope.thread!.providerSessionId },
          );
          return { messages, nextCursor: input.messageId === undefined ? page.nextCursor : null };
        }, Effect.mapError(error)),
      ),
      mailbox_acknowledge: McpToolAccess.actsAsCaller(
        Effect.fn("mcp.mailbox.acknowledge")(function* (input) {
          const scope = yield* McpInvocationContext;
          yield* mailbox.agentTurn(scope, input.turnKey);
          yield* mailbox.dispatch(
            scope.thread!.threadId,
            { kind: "state", messageId: input.messageId, state: input.state },
            { turnKey: input.turnKey, providerSessionId: scope.thread!.providerSessionId },
          );
          return { messageId: input.messageId, state: input.state };
        }),
      ),
    };
  }),
);
