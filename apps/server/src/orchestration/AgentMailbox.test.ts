import { McpServer, McpSchema } from "effect/unstable/ai";
import { MailboxToolkit, MailboxToolkitHandlersLive } from "../mcp/toolkits/mailbox.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  CommandId,
  MailboxBody,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { makeAgentMailbox } from "./AgentMailbox.ts";

const sender = ThreadId.make("backend-agent");
const recipient = ThreadId.make("frontend-agent");
const now = "2026-09-07T12:00:00.000Z";
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const sourceExecution = MessageId.make("backend-turn-1");
const decodeMailboxBody = Schema.decodeUnknownEffect(MailboxBody);

const runtimeAt = Effect.fn("mailbox.test.store")(function* (path: string) {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const context = yield* Layer.buildWithScope(
    McpServer.toolkit(MailboxToolkit).pipe(
      Layer.provide(MailboxToolkitHandlersLive),
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          OrchestrationEngineLive.pipe(
            Layer.provide(OrchestrationProjectionSnapshotQueryLive),
            Layer.provide(OrchestrationProjectionPipelineLive),
          ),
          OrchestrationProjectionSnapshotQueryLive,
        ),
      ),
      Layer.provideMerge(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(makeSqlitePersistenceLive(path)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mailbox-test-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
    scope,
  );
  return { run: Effect.provide(context), dispose: () => Scope.close(scope, Exit.void) };
});

function seed(runtime: Effect.Success<ReturnType<typeof runtimeAt>>) {
  return runtime.run(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      for (const threadId of [sender, recipient]) {
        const projectId = ProjectId.make(`project-${threadId}`);
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(`project-${threadId}`),
          projectId,
          title: threadId,
          workspaceRoot: `/tmp/${threadId}`,
          defaultModelSelection: modelSelection,
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`thread-${threadId}`),
          threadId,
          projectId,
          title: threadId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });
      }
      const mailbox = yield* makeAgentMailbox;
      yield* mailbox.update({
        threadId: sender,
        commandId: CommandId.make("link"),
        operation: { kind: "link", peerThreadId: recipient, linked: true },
      });
      yield* mailbox.prepare(sender, sourceExecution, "sender-session");
    }),
  );
}

const send = (id: string, body = "API contract is ready") =>
  Effect.gen(function* () {
    const mailbox = yield* makeAgentMailbox;
    yield* mailbox.dispatch(sender, {
      kind: "send",
      id,
      executionId: sourceExecution,
      toThreadId: recipient,
      body,
      replyTo: null,
    });
  });

const expectFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, message: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(effect);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) expect(String(Cause.squash(result.cause))).toContain(message);
  });

describe("durable agent mailbox", () => {
  it.effect(
    "delivers oversized encoded bodies by reference without blocking subsequent messages",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mailbox-reference-")),
        );
        const runtime = yield* runtimeAt(NodePath.join(directory, "state.sqlite"));
        try {
          yield* seed(runtime);
          yield* runtime.run(
            Effect.gen(function* () {
              const mailbox = yield* makeAgentMailbox;
              const server = yield* McpServer.McpServer;
              const body = yield* decodeMailboxBody(String.fromCharCode(1).repeat(8_000));
              yield* send("first-large", body);
              yield* send("second-small", "The next integration request");
              const execution = MessageId.make("reference-recipient");
              const prepared = yield* mailbox.prepare(recipient, execution, "recipient-session");
              expect(prepared.context.length).toBeLessThanOrEqual(32_000);
              expect(prepared.context).toContain('"bodyAvailableVia":"mailbox_read"');
              expect(prepared.context).toContain("The next integration request");
              expect((yield* mailbox.get({ threadId: recipient })).turns[0]?.incoming).toEqual([
                "first-large",
                "second-small",
              ]);
              yield* mailbox.finish(
                recipient,
                execution,
                TurnId.make("reference-turn"),
                "submitted",
              );
              expect((yield* mailbox.get({ threadId: recipient })).pendingCount).toBe(0);
              const turn = (yield* mailbox.repository.turns(recipient))[0]!;
              const read = yield* server
                .callTool({
                  name: "mailbox_read",
                  arguments: { turnKey: turn.turnKey, messageId: "first-large" },
                })
                .pipe(
                  Effect.provideService(McpInvocationContext, {
                    environmentId: EnvironmentId.make("env"),
                    threadId: recipient,
                    providerSessionId: "recipient-session",
                    providerInstanceId: modelSelection.instanceId,
                    capabilities: new Set<"mailbox">(["mailbox"]),
                    issuedAt: 0,
                  }),
                  Effect.provideService(
                    McpSchema.McpServerClient,
                    McpSchema.McpServerClient.of({
                      clientId: 1,
                      protocolVersion: "2025-06-18",
                      initializePayload: {
                        protocolVersion: "2025-06-18",
                        capabilities: {},
                        clientInfo: { name: "mailbox-test", version: "1" },
                      },
                      getClient: Effect.die("unused"),
                    }),
                  ),
                );
              expect(read.isError).toBe(false);
              expect(read.structuredContent).toMatchObject({
                messages: [{ id: "first-large", body }],
              });
              expect((yield* mailbox.get({ threadId: recipient })).turns[0]?.read).toEqual([
                "first-large",
              ]);
            }),
          );
        } finally {
          yield* runtime.dispose();
          yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "executes MCP sends and reads against persisted state with authenticated sender attribution",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mailbox-mcp-")),
        );
        const runtime = yield* runtimeAt(NodePath.join(directory, "state.sqlite"));
        try {
          yield* seed(runtime);
          yield* runtime.run(
            Effect.gen(function* () {
              const mailbox = yield* makeAgentMailbox;
              const server = yield* McpServer.McpServer;
              const senderTurn = (yield* mailbox.repository.turns(sender))[0]!;
              const invocation = {
                environmentId: EnvironmentId.make("env"),
                threadId: sender,
                providerSessionId: "sender-session",
                providerInstanceId: modelSelection.instanceId,
                capabilities: new Set<"mailbox">(["mailbox"]),
                issuedAt: 0,
              };
              const client = McpSchema.McpServerClient.of({
                clientId: 1,
                protocolVersion: "2025-06-18",
                initializePayload: {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  clientInfo: { name: "mailbox-test", version: "1" },
                },
                getClient: Effect.die("unused"),
              });
              const peers = yield* server
                .callTool({ name: "mailbox_peers", arguments: { turnKey: senderTurn.turnKey } })
                .pipe(
                  Effect.provideService(McpInvocationContext, invocation),
                  Effect.provideService(McpSchema.McpServerClient, client),
                );
              expect(peers.isError).toBe(false);
              const sent = yield* server
                .callTool({
                  name: "mailbox_send",
                  arguments: {
                    turnKey: senderTurn.turnKey,
                    toThreadId: recipient,
                    body: "Use API v2",
                    retryKey: "api-v2",
                  },
                })
                .pipe(
                  Effect.provideService(McpInvocationContext, invocation),
                  Effect.provideService(McpSchema.McpServerClient, client),
                );
              expect(sent.isError).toBe(false);
              expect(sent.structuredContent).toMatchObject({ status: "queued" });
              const message = (yield* mailbox.get({ threadId: recipient })).messages[0]!;
              expect(message.fromThreadId).toBe(sender);
              expect(message.executionId).toBe(sourceExecution);
              yield* mailbox.prepare(
                recipient,
                MessageId.make("mcp-read-turn"),
                "recipient-session",
              );
              const recipientTurn = (yield* mailbox.repository.turns(recipient))[0]!;
              const recipientScope = {
                ...invocation,
                threadId: recipient,
                providerSessionId: "recipient-session",
              };
              const read = yield* server
                .callTool({
                  name: "mailbox_read",
                  arguments: { turnKey: recipientTurn.turnKey, messageId: message.id },
                })
                .pipe(
                  Effect.provideService(McpInvocationContext, recipientScope),
                  Effect.provideService(McpSchema.McpServerClient, client),
                );
              expect(read.isError).toBe(false);
              expect(read.structuredContent).toMatchObject({ messages: [{ body: "Use API v2" }] });
              const acknowledged = yield* server
                .callTool({
                  name: "mailbox_acknowledge",
                  arguments: {
                    turnKey: recipientTurn.turnKey,
                    messageId: message.id,
                    state: "acknowledged",
                  },
                })
                .pipe(
                  Effect.provideService(McpInvocationContext, recipientScope),
                  Effect.provideService(McpSchema.McpServerClient, client),
                );
              expect(acknowledged.isError).toBe(false);
              const inbox = yield* mailbox.get({ threadId: recipient });
              expect(inbox.messages[0]?.state).toBe("acknowledged");
              expect(inbox.turns[0]?.read).toEqual([message.id]);
              const rejected = yield* server
                .callTool({
                  name: "mailbox_send",
                  arguments: {
                    turnKey: senderTurn.turnKey,
                    toThreadId: sender,
                    body: "Spoof sender",
                    retryKey: "spoof",
                  },
                })
                .pipe(
                  Effect.provideService(McpInvocationContext, recipientScope),
                  Effect.provideService(McpSchema.McpServerClient, client),
                );
              expect(rejected.isError).toBe(true);
              expect((yield* mailbox.get({ threadId: sender })).messages).toHaveLength(1);
              const snapshots = yield* ProjectionSnapshotQuery;
              const shell = yield* snapshots.getShellSnapshot();
              expect(
                shell.threads.find((thread) => thread.id === recipient)?.mailboxPendingCount,
              ).toBeUndefined();
              expect(
                shell.threads.find((thread) => thread.id === sender)?.mailboxRevision,
              ).toBeGreaterThan(0);
            }),
          );
        } finally {
          yield* runtime.dispose();
          yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "survives a database reopen, deduplicates retries, rejects conflicting retries, and preserves both histories",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mailbox-")),
        );
        const path = NodePath.join(directory, "state.sqlite");
        let runtime = yield* runtimeAt(path);
        try {
          yield* seed(runtime);
          yield* runtime.run(send("message-1"));
          yield* runtime.run(send("message-1"));
          yield* expectFailure(runtime.run(send("message-1", "Different body")), "retry key");
          yield* runtime.dispose();
          runtime = yield* runtimeAt(path);
          yield* runtime.run(
            Effect.gen(function* () {
              const mailbox = yield* makeAgentMailbox;
              const inbox = yield* mailbox.get({ threadId: recipient });
              const outbox = yield* mailbox.get({ threadId: sender });
              expect(inbox.messages).toHaveLength(1);
              expect(inbox.messages[0]?.body).toBe("API contract is ready");
              expect(inbox.pendingCount).toBe(1);
              expect(outbox.messages).toEqual(inbox.messages);
              expect(outbox.turns[0]?.sent).toEqual(["message-1"]);
              expect(inbox.peers).toEqual([sender]);
              const snapshots = yield* ProjectionSnapshotQuery;
              const detail = yield* snapshots.getSnapshot();
              for (const id of [sender, recipient])
                expect(
                  detail.threads
                    .find((thread) => thread.id === id)
                    ?.activities.some((activity) => activity.summary === "Agent message queued"),
                ).toBe(true);
            }),
          );
        } finally {
          yield* runtime.dispose();
          yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "freezes incoming IDs, leaves later arrivals pending, and retains mail after a failed start",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mailbox-")),
        );
        const runtime = yield* runtimeAt(NodePath.join(directory, "state.sqlite"));
        try {
          yield* seed(runtime);
          yield* runtime.run(send("before"));
          yield* runtime.run(
            Effect.gen(function* () {
              const mailbox = yield* makeAgentMailbox;
              const executionId = MessageId.make("recipient-turn");
              const prepared = yield* mailbox.prepare(recipient, executionId, "recipient-session");
              expect(prepared.context).toContain("before");
              yield* send("after");
              const snapshot = (yield* mailbox.get({ threadId: recipient })).turns[0];
              expect(snapshot?.incoming).toEqual(["before"]);
              yield* mailbox.finish(recipient, executionId, null, "failed");
              expect((yield* mailbox.get({ threadId: recipient })).pendingCount).toBe(2);
              yield* mailbox.prepare(recipient, MessageId.make("retry-turn"), "new-session");
              yield* mailbox.finish(
                recipient,
                MessageId.make("retry-turn"),
                TurnId.make("provider-turn"),
                "submitted",
              );
              const result = yield* mailbox.get({ threadId: recipient });
              expect(result.pendingCount).toBe(0);
              expect(result.turns[0]?.incoming).toHaveLength(2);
              expect(result.turns[0]?.sent).toEqual([]);
              expect(result.turns[0]?.read).toEqual([]);
              expect(result.turns[0]?.turnId).toBe("provider-turn");
            }),
          );
        } finally {
          yield* runtime.dispose();
          yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
        }
      }).pipe(Effect.scoped),
  );

  it.effect("serializes a send racing turn preparation without losing the message", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mailbox-")),
      );
      const runtime = yield* runtimeAt(NodePath.join(directory, "state.sqlite"));
      try {
        yield* seed(runtime);
        yield* Effect.all(
          [
            runtime.run(send("racing-message")),
            runtime.run(
              Effect.gen(function* () {
                const mailbox = yield* makeAgentMailbox;
                yield* mailbox.prepare(recipient, MessageId.make("racing-turn"), "session");
              }),
            ),
          ],
          { concurrency: "unbounded" },
        );
        yield* runtime.run(
          Effect.gen(function* () {
            const mailbox = yield* makeAgentMailbox;
            yield* mailbox.finish(
              recipient,
              MessageId.make("racing-turn"),
              TurnId.make("race-provider-turn"),
              "submitted",
            );
            const result = yield* mailbox.get({ threadId: recipient });
            expect(result.messages).toHaveLength(1);
            const included = result.turns[0]!.incoming.includes("racing-message");
            expect(result.pendingCount).toBe(included ? 0 : 1);
          }),
        );
      } finally {
        yield* runtime.dispose();
        yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "enforces links, recipient ownership, terminal states, and current session/turn identity",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mailbox-")),
        );
        const runtime = yield* runtimeAt(NodePath.join(directory, "state.sqlite"));
        try {
          yield* seed(runtime);
          yield* runtime.run(send("request"));
          const mailbox = yield* runtime.run(makeAgentMailbox);
          yield* runtime.run(
            mailbox.prepare(recipient, MessageId.make("read-turn"), "recipient-session"),
          );
          const turn = (yield* runtime.run(mailbox.repository.turns(recipient)))[0]!;
          const scope = {
            environmentId: EnvironmentId.make("env"),
            threadId: recipient,
            providerSessionId: "recipient-session",
            providerInstanceId: modelSelection.instanceId,
            capabilities: new Set<"mailbox">(["mailbox"]),
            issuedAt: 0,
          };
          yield* runtime.run(mailbox.agentTurn(scope, turn.turnKey));
          yield* expectFailure(
            runtime.run(
              mailbox.agentTurn({ ...scope, providerSessionId: "spoofed" }, turn.turnKey),
            ),
            "current turn",
          );
          yield* runtime.run(
            mailbox.dispatch(
              recipient,
              { kind: "read", executionId: turn.executionId, messageIds: ["request"] },
              { turnKey: turn.turnKey, providerSessionId: scope.providerSessionId },
            ),
          );
          expect((yield* runtime.run(mailbox.get({ threadId: recipient }))).turns[0]?.read).toEqual(
            ["request"],
          );
          yield* expectFailure(
            runtime.run(
              mailbox.dispatch(sender, { kind: "state", messageId: "request", state: "resolved" }),
            ),
            "Only the recipient",
          );
          yield* runtime.run(
            mailbox.update({
              threadId: recipient,
              commandId: CommandId.make("dismiss"),
              operation: { kind: "state", messageId: "request", state: "dismissed" },
            }),
          );
          yield* expectFailure(
            runtime.run(
              mailbox.dispatch(recipient, {
                kind: "state",
                messageId: "request",
                state: "acknowledged",
              }),
            ),
            "already resolved",
          );
          yield* runtime.run(
            mailbox.update({
              threadId: sender,
              commandId: CommandId.make("unlink"),
              operation: { kind: "link", peerThreadId: recipient, linked: false },
            }),
          );
          yield* expectFailure(runtime.run(send("unlinked-message")), "not linked");
          expect(
            (yield* runtime.run(mailbox.get({ threadId: recipient }))).messages[0]?.state,
          ).toBe("dismissed");
          yield* runtime.run(
            mailbox.update({
              threadId: recipient,
              commandId: CommandId.make("restore"),
              operation: { kind: "state", messageId: "request", state: "queued" },
            }),
          );
          expect((yield* runtime.run(mailbox.get({ threadId: recipient }))).pendingCount).toBe(1);
          const paused = MessageId.make("unlinked-inbox");
          yield* runtime.run(mailbox.finish(recipient, turn.executionId, null, "completed"));
          yield* runtime.run(mailbox.prepare(recipient, paused, "recipient-session"));
          expect(
            (yield* runtime.run(mailbox.get({ threadId: recipient }))).turns[0]?.incoming,
          ).toEqual([]);
          yield* runtime.run(
            mailbox.update({
              threadId: sender,
              commandId: CommandId.make("relink"),
              operation: { kind: "link", peerThreadId: recipient, linked: true },
            }),
          );
          yield* runtime.run(mailbox.finish(recipient, paused, null, "completed"));
          yield* runtime.run(
            mailbox.prepare(recipient, MessageId.make("linked-again"), "recipient-session"),
          );
          expect(
            (yield* runtime.run(mailbox.get({ threadId: recipient }))).turns[0]?.incoming,
          ).toEqual(["request"]);
          yield* expectFailure(runtime.run(mailbox.agentTurn(scope, turn.turnKey)), "current turn");
        } finally {
          yield* runtime.dispose();
          yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
        }
      }).pipe(Effect.scoped),
  );

  it.effect("retries a cross-thread command without duplicating links or either history", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mailbox-retry-")),
      );
      const runtime = yield* runtimeAt(NodePath.join(directory, "state.sqlite"));
      try {
        yield* seed(runtime);
        yield* runtime.run(
          Effect.gen(function* () {
            const mailbox = yield* makeAgentMailbox;
            const snapshots = yield* ProjectionSnapshotQuery;
            const before = yield* snapshots.getSnapshot();
            yield* mailbox.update({
              threadId: sender,
              commandId: CommandId.make("link"),
              operation: { kind: "link", peerThreadId: recipient, linked: true },
            });
            expect(yield* snapshots.getSnapshot()).toEqual(before);
            expect((yield* mailbox.get({ threadId: recipient })).peers).toEqual([sender]);
          }),
        );
      } finally {
        yield* runtime.dispose();
        yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "rolls back the message, both histories and event log if recipient projection fails",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mailbox-atomic-")),
        );
        const runtime = yield* runtimeAt(NodePath.join(directory, "state.sqlite"));
        try {
          yield* seed(runtime);
          yield* runtime.run(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const snapshots = yield* ProjectionSnapshotQuery;
              const before = yield* snapshots.getSnapshot();
              const events = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
              yield* sql`CREATE TRIGGER reject_recipient_activity BEFORE INSERT ON projection_thread_activities WHEN NEW.thread_id = 'frontend-agent' BEGIN SELECT RAISE(ABORT, 'recipient projection unavailable'); END`;
              const result = yield* Effect.exit(send("atomic-message"));
              expect(result._tag).toBe("Failure");
              const mailbox = yield* makeAgentMailbox;
              expect((yield* mailbox.get({ threadId: recipient })).messages).toEqual([]);
              expect(yield* snapshots.getSnapshot()).toEqual(before);
              expect(yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`).toEqual(
                events,
              );
              yield* sql`DROP TRIGGER reject_recipient_activity`;
              yield* send("atomic-message");
              expect((yield* mailbox.get({ threadId: recipient })).messages).toHaveLength(1);
            }),
          );
        } finally {
          yield* runtime.dispose();
          yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "pages identical timestamps without gaps and retrieves older turn messages directly",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mailbox-history-")),
        );
        const runtime = yield* runtimeAt(NodePath.join(directory, "state.sqlite"));
        try {
          yield* seed(runtime);
          yield* runtime.run(
            Effect.gen(function* () {
              const engine = yield* OrchestrationEngineService;
              const mailbox = yield* makeAgentMailbox;
              for (let i = 0; i < 35; i++) {
                const id = `page-${String(i).padStart(2, "0")}`;
                yield* engine.dispatch({
                  type: "thread.mailbox",
                  commandId: CommandId.make(id),
                  threadId: sender,
                  createdAt: now,
                  operation: {
                    kind: "send",
                    id,
                    executionId: sourceExecution,
                    toThreadId: recipient,
                    body: id,
                    replyTo: null,
                  },
                });
                const executionId = MessageId.make(`history-${i}`);
                yield* mailbox.prepare(recipient, executionId, null);
                yield* mailbox.finish(
                  recipient,
                  executionId,
                  TurnId.make(`provider-${i}`),
                  "completed",
                );
              }
              const first = yield* mailbox.get({ threadId: recipient });
              const next = yield* mailbox.get({
                threadId: recipient,
                before: first.nextCursor!,
                beforeTurn: first.nextTurnCursor!,
              });
              expect(first.messages).toHaveLength(30);
              expect(next.messages).toHaveLength(5);
              expect(new Set([...first.messages, ...next.messages].map((m) => m.id)).size).toBe(35);
              expect(first.turns[0]?.executionId).toBe("history-34");
              expect(next.turns.at(-1)?.executionId).toBe("history-0");
              expect(next.nextCursor).toBeNull();
              expect(next.nextTurnCursor).toBeNull();
              const selected = yield* mailbox.get({ threadId: recipient, messageId: "page-00" });
              expect(selected.messages.map((message) => message.body)).toEqual(["page-00"]);
              expect(
                (yield* mailbox.get({ threadId: sender, executionId: sourceExecution })).turns[0]
                  ?.sent,
              ).toHaveLength(35);
            }),
          );
        } finally {
          yield* runtime.dispose();
          yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "bounds injected context, references bodies that do not fit, and adds no inbox to a continuation or active turn",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mailbox-budget-")),
        );
        const runtime = yield* runtimeAt(NodePath.join(directory, "state.sqlite"));
        try {
          yield* seed(runtime);
          yield* runtime.run(
            Effect.gen(function* () {
              const mailbox = yield* makeAgentMailbox;
              yield* send("large", '"'.repeat(8_000));
              const small = MessageId.make("too-small");
              const blocked = yield* mailbox.prepare(recipient, small, "recipient-session", 2_000);
              expect(blocked.context.length).toBeLessThanOrEqual(2_000);
              expect((yield* mailbox.get({ threadId: recipient })).turns[0]?.incoming).toEqual([
                "large",
              ]);
              expect(blocked.context).toContain('"bodyAvailableVia":"mailbox_read"');
              yield* mailbox.finish(recipient, small, null, "failed");
              const full = MessageId.make("full-budget");
              const prepared = yield* mailbox.prepare(recipient, full, "recipient-session", 32_000);
              expect(prepared.context.length).toBeLessThanOrEqual(32_000);
              expect((yield* mailbox.get({ threadId: recipient })).turns[0]?.incoming).toEqual([
                "large",
              ]);
              const overlapping = MessageId.make("active-steer");
              yield* mailbox.prepare(recipient, overlapping, "recipient-session");
              expect((yield* mailbox.get({ threadId: recipient })).turns[0]?.incoming).toEqual([]);
              yield* mailbox.finish(recipient, overlapping, null, "failed");
              const continuation = MessageId.make("continuation");
              yield* mailbox.prepare(recipient, continuation, "resumed-session", 32_000, false);
              yield* mailbox.finish(recipient, continuation, TurnId.make("continued"), "submitted");
              expect((yield* mailbox.get({ threadId: recipient })).pendingCount).toBe(1);
              expect((yield* mailbox.get({ threadId: recipient })).turns[0]?.incoming).toEqual([]);
              yield* mailbox.finish(recipient, continuation, null, "completed");
              const noRoom = yield* mailbox.prepare(
                recipient,
                MessageId.make("no-room"),
                "next-session",
                500,
              );
              expect(noRoom.context).toBe("");
              expect((yield* mailbox.get({ threadId: recipient })).turns[0]?.incoming).toEqual([]);
            }),
          );
        } finally {
          yield* runtime.dispose();
          yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "rebuilds the mailbox from events and invalidates a previous session's turn key after restart",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mailbox-replay-")),
        );
        const path = NodePath.join(directory, "state.sqlite");
        let runtime = yield* runtimeAt(path);
        try {
          yield* seed(runtime);
          yield* runtime.run(send("recover-me"));
          const original = yield* runtime.run(
            Effect.gen(function* () {
              const mailbox = yield* makeAgentMailbox;
              const original = yield* mailbox.get({ threadId: sender });
              const sql = yield* SqlClient.SqlClient;
              yield* sql`DELETE FROM projection_mailbox_links`;
              yield* sql`DELETE FROM projection_mailbox_messages`;
              yield* sql`DELETE FROM projection_mailbox_turns`;
              yield* sql`DELETE FROM projection_mailbox_reads`;
              yield* sql`DELETE FROM projection_state WHERE projector = 'projection.mailbox'`;
              return original;
            }),
          );
          yield* runtime.dispose();
          runtime = yield* runtimeAt(path);
          yield* runtime.run(
            Effect.gen(function* () {
              const mailbox = yield* makeAgentMailbox;
              expect(yield* mailbox.get({ threadId: sender })).toEqual(original);
              const old = (yield* mailbox.repository.turns(sender))[0]!;
              yield* mailbox.prepare(sender, MessageId.make("after-restart"), "new-sender-session");
              const result = yield* Effect.exit(
                mailbox.dispatch(
                  sender,
                  {
                    kind: "send",
                    id: "stale",
                    executionId: old.executionId,
                    toThreadId: recipient,
                    body: "stale",
                    replyTo: null,
                  },
                  { turnKey: old.turnKey, providerSessionId: "sender-session" },
                ),
              );
              expect(result._tag).toBe("Failure");
              expect(
                (yield* mailbox.get({ threadId: recipient })).messages.map((m) => m.id),
              ).toEqual(["recover-me"]);
            }),
          );
        } finally {
          yield* runtime.dispose();
          yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
        }
      }).pipe(Effect.scoped),
  );
  it.effect("preserves communication history when a peer is archived or deleted", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mailbox-lifecycle-")),
      );
      const runtime = yield* runtimeAt(NodePath.join(directory, "state.sqlite"));
      try {
        yield* seed(runtime);
        yield* runtime.run(send("historical"));
        yield* runtime.run(
          Effect.gen(function* () {
            const mailbox = yield* makeAgentMailbox;
            const engine = yield* OrchestrationEngineService;
            yield* engine.dispatch({
              type: "thread.archive",
              threadId: recipient,
              commandId: CommandId.make("archive-recipient"),
            });
            yield* expectFailure(send("archived-recipient"), "unavailable");
            expect((yield* mailbox.get({ threadId: recipient })).messages[0]?.id).toBe(
              "historical",
            );
            yield* engine.dispatch({
              type: "thread.unarchive",
              threadId: recipient,
              commandId: CommandId.make("unarchive-recipient"),
            });
            yield* send("unarchived-recipient");
            yield* engine.dispatch({
              type: "thread.delete",
              threadId: recipient,
              commandId: CommandId.make("delete-recipient"),
            });
            const outbox = yield* mailbox.get({ threadId: sender });
            expect(outbox.messages).toHaveLength(2);
            expect(outbox.peers).toEqual([]);
            yield* expectFailure(mailbox.get({ threadId: recipient }), "unavailable");
            yield* expectFailure(send("deleted-recipient"), "not linked");
          }),
        );
      } finally {
        yield* runtime.dispose();
        yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
      }
    }).pipe(Effect.scoped),
  );
});

describe("automatic mailbox turn admission", () => {
  it.effect(
    "admits one turn for concurrent sends, persists it across restart, and resumes the same execution",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mailbox-wake-")),
        );
        const path = NodePath.join(directory, "state.sqlite");
        const runtime = yield* runtimeAt(path);
        yield* seed(runtime);
        const executionId = yield* runtime.run(
          Effect.gen(function* () {
            const mailbox = yield* makeAgentMailbox;
            yield* Effect.all([send("wake-a"), send("wake-b")], { concurrency: "unbounded" });
            yield* Effect.all([mailbox.wake(recipient), mailbox.wake(recipient)], {
              concurrency: "unbounded",
            });
            const inbox = yield* mailbox.get({ threadId: recipient });
            expect(inbox.turns).toHaveLength(1);
            expect(inbox.turns[0]).toMatchObject({
              source: "mailbox",
              state: "pending",
              incoming: [],
            });
            expect(inbox.pendingCount).toBe(2);
            const snapshot = yield* (yield* ProjectionSnapshotQuery).getSnapshot();
            expect(snapshot.threads.find((t) => t.id === recipient)?.messages).toHaveLength(1);
            return inbox.turns[0]!.executionId;
          }),
        );
        yield* runtime.dispose();
        const reopened = yield* runtimeAt(path);
        yield* reopened.run(
          Effect.gen(function* () {
            const mailbox = yield* makeAgentMailbox;
            yield* mailbox.wake(recipient, true);
            expect(
              (yield* mailbox.get({ threadId: recipient })).turns.map((t) => t.executionId),
            ).toEqual([executionId]);
            const prepared = yield* mailbox.prepare(recipient, executionId, "recipient-session");
            expect(prepared.context).toContain("wake-a");
            expect(prepared.context).toContain("wake-b");
            const turns = yield* mailbox.repository.turns(recipient);
            expect(turns[0]?.source).toBe("mailbox");
            expect(turns[0]?.state).toBe("prepared");
            yield* mailbox.finish(
              recipient,
              executionId,
              TurnId.make("wake-provider-turn"),
              "submitted",
            );
            expect((yield* mailbox.get({ threadId: recipient })).pendingCount).toBe(0);
            yield* mailbox.wake(recipient);
            expect((yield* mailbox.get({ threadId: recipient })).turns).toHaveLength(1);
          }),
        );
        yield* reopened.dispose();
        yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
      }),
  );

  it.effect("honors pause, unlink and user stop, and resumes preserved messages explicitly", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mailbox-pause-")),
      );
      const runtime = yield* runtimeAt(NodePath.join(directory, "state.sqlite"));
      yield* seed(runtime);
      yield* runtime.run(
        Effect.gen(function* () {
          const mailbox = yield* makeAgentMailbox;
          const engine = yield* OrchestrationEngineService;
          yield* send("paused-message");
          yield* mailbox.update({
            threadId: recipient,
            commandId: CommandId.make("pause"),
            operation: { kind: "auto-wake", enabled: false },
          });
          yield* mailbox.wake(recipient);
          expect((yield* mailbox.get({ threadId: recipient })).turns).toEqual([]);
          yield* mailbox.update({
            threadId: recipient,
            commandId: CommandId.make("resume"),
            operation: { kind: "auto-wake", enabled: true },
          });
          yield* mailbox.update({
            threadId: recipient,
            commandId: CommandId.make("unlink-wake"),
            operation: { kind: "link", peerThreadId: sender, linked: false },
          });
          yield* mailbox.wake(recipient);
          expect((yield* mailbox.get({ threadId: recipient })).turns).toEqual([]);
          yield* mailbox.update({
            threadId: recipient,
            commandId: CommandId.make("relink-wake"),
            operation: { kind: "link", peerThreadId: sender, linked: true },
          });
          yield* mailbox.wake(recipient);
          const pending = (yield* mailbox.get({ threadId: recipient })).turns[0]!;
          yield* engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make("stop-wake"),
            threadId: recipient,
            createdAt: now,
          });
          const paused = yield* mailbox.get({ threadId: recipient });
          expect(paused.autoWake?.enabled).toBe(false);
          expect(paused.autoWake?.reason).toContain("stopped");
          expect(paused.turns[0]?.state).toBe("failed");
          yield* mailbox.wake(recipient);
          expect((yield* mailbox.get({ threadId: recipient })).turns).toHaveLength(1);
          yield* mailbox.finish(recipient, pending.executionId, null, "failed");
          yield* mailbox.update({
            threadId: recipient,
            commandId: CommandId.make("resume-stopped"),
            operation: { kind: "auto-wake", enabled: true },
          });
          yield* mailbox.wake(recipient);
          expect((yield* mailbox.get({ threadId: recipient })).turns[0]?.state).toBe("pending");
          expect((yield* mailbox.get({ threadId: recipient })).pendingCount).toBe(1);
        }),
      );
      yield* runtime.dispose();
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }),
  );

  it.effect("does not overtake a user turn pending across restart even with an old timestamp", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mailbox-admission-")),
      );
      const path = NodePath.join(directory, "state.sqlite");
      const runtime = yield* runtimeAt(path);
      yield* seed(runtime);
      yield* runtime.run(
        Effect.gen(function* () {
          const engine = yield* OrchestrationEngineService;
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("older-user-start"),
            threadId: recipient,
            message: {
              messageId: MessageId.make("older-user-message"),
              role: "user",
              text: "Run the integration tests",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: "2020-01-01T00:00:00.000Z",
          });
          yield* send("queued-behind-user");
        }),
      );
      yield* runtime.dispose();
      const reopened = yield* runtimeAt(path);
      yield* reopened.run(
        Effect.gen(function* () {
          const mailbox = yield* makeAgentMailbox;
          yield* mailbox.wake(recipient, true);
          expect((yield* mailbox.get({ threadId: recipient })).turns).toEqual([]);
          expect((yield* mailbox.get({ threadId: recipient })).pendingCount).toBe(1);
        }),
      );
      yield* reopened.dispose();
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }),
  );
});

it.effect.each(["approval", "user-input", "background"] as const)(
  "defers idle wake while %s work is pending, then admits preserved mail",
  (blocker) =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mailbox-blocker-")),
      );
      const runtime = yield* runtimeAt(NodePath.join(directory, "state.sqlite"));
      yield* seed(runtime);
      yield* runtime.run(
        Effect.gen(function* () {
          const mailbox = yield* makeAgentMailbox;
          const engine = yield* OrchestrationEngineService;
          const liveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;
          yield* send("held-by-blocker");
          if (blocker === "background") {
            liveness.recordTaskLiveness({
              threadId: recipient,
              taskId: "background-test",
              taskType: "agent",
              status: "running",
              kind: "started",
            });
          } else {
            yield* engine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make("blocker-request"),
              threadId: recipient,
              activity: {
                id: EventId.make("blocker-request"),
                kind: `${blocker}.requested`,
                tone: "approval",
                summary: "Waiting for user",
                payload: { requestId: "pending-request", requestKind: "command" },
                turnId: null,
                createdAt: now,
              },
              createdAt: now,
            });
          }
          yield* mailbox.wake(recipient);
          expect((yield* mailbox.get({ threadId: recipient })).turns).toEqual([]);
          expect((yield* mailbox.get({ threadId: recipient })).pendingCount).toBe(1);
          if (blocker === "background") {
            liveness.recordTaskLiveness({
              threadId: recipient,
              taskId: "background-test",
              taskType: "agent",
              status: "completed",
              kind: "completed",
            });
          } else {
            yield* engine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make("blocker-resolved"),
              threadId: recipient,
              activity: {
                id: EventId.make("blocker-resolved"),
                kind: `${blocker}.resolved`,
                tone: "info",
                summary: "User answered",
                payload: { requestId: "pending-request", requestKind: "command" },
                turnId: null,
                createdAt: now,
              },
              createdAt: now,
            });
          }
          yield* mailbox.wake(recipient);
          expect((yield* mailbox.get({ threadId: recipient })).turns[0]?.state).toBe("pending");
        }),
      );
      yield* runtime.dispose();
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }),
);
