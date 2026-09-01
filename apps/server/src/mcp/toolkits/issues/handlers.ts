/**
 * What the issue tools actually do.
 *
 * Each one resolves the agent's thread to its project and hands the rest to `IssueService`, so
 * an agent reads and writes issues through exactly the path the panel does — same providers,
 * same capability gating, same errors.
 */
import { IssueOperationError, IssueUnavailableError, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as IssueService from "../../../issue/IssueService.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { IssueToolkit } from "./tools.ts";

const DEFAULT_LIST_LIMIT = 30;

export const IssueToolkitHandlersLive = IssueToolkit.toLayer(
  Effect.gen(function* () {
    const issues = yield* IssueService.IssueService;
    const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

    /**
     * The project the calling agent is working in.
     *
     * A credential without the issues capability is refused here rather than at the provider:
     * the agent should be told it may not do this at all, not that a repository could not be
     * read.
     */
    const currentProject = Effect.fn("mcp.issues.currentProject")(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      if (!invocation.capabilities.has("issues")) {
        return yield* new IssueUnavailableError({
          reason: "provider-unsupported",
          detail: "This agent session may not read issues.",
        });
      }
      const snapshot = yield* projections.getShellSnapshot().pipe(
        Effect.mapError(
          () =>
            new IssueOperationError({
              operation: "resolveThread",
              detail: "The thread list could not be read.",
            }),
        ),
      );
      const thread = snapshot.threads.find((candidate) => candidate.id === invocation.threadId);
      if (thread === undefined) {
        return yield* new IssueOperationError({
          operation: "resolveThread",
          detail: "This agent's thread could not be found.",
        });
      }
      return thread.projectId satisfies ProjectId;
    });

    return {
      issue_list: Effect.fn("mcp.issues.list")(function* (input) {
        const projectId = yield* currentProject();
        const result = yield* issues.list({
          projectId,
          state: input.state ?? "open",
          ...(input.query === undefined || input.query.trim().length === 0
            ? {}
            : { query: input.query.trim() }),
          limit: input.limit ?? DEFAULT_LIST_LIMIT,
        });
        return { issues: result.entries, truncated: result.truncated };
      }),

      issue_read: Effect.fn("mcp.issues.read")(function* (input) {
        const projectId = yield* currentProject();
        // No repository: the project's own is authoritative, so it is not something an agent
        // could name wrongly.
        return yield* issues.detail({ projectId, number: input.number });
      }),

      issue_comment: Effect.fn("mcp.issues.comment")(function* (input) {
        const projectId = yield* currentProject();
        yield* issues.comment({ projectId, number: input.number, body: input.body });
      }),

      issue_create: Effect.fn("mcp.issues.create")(function* (input) {
        const projectId = yield* currentProject();
        return yield* issues.create({
          projectId,
          title: input.title,
          ...(input.body === undefined ? {} : { body: input.body }),
        });
      }),

      issue_set_state: Effect.fn("mcp.issues.setState")(function* (input) {
        const projectId = yield* currentProject();
        yield* issues.setState({ projectId, number: input.number, state: input.state });
      }),
    };
  }),
);
