/**
 * Issues, as tools an agent can call.
 *
 * The project is not a parameter: an agent runs inside a thread, and that thread already belongs
 * to a project. Asking it to name one would only let it name the wrong one.
 */
import {
  IssueCreateResult,
  IssueDetail,
  IssueListEntry,
  IssueListState,
  IssueOperationError,
  IssueState,
  IssueUnavailableError,
  PositiveInt,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

const IssueToolError = Schema.Union([IssueUnavailableError, IssueOperationError]);

const IssueListToolInput = Schema.Struct({
  state: Schema.optional(IssueListState).annotate({
    description: "Which issues to list. Defaults to open.",
  }),
  query: Schema.optional(Schema.String).annotate({
    description:
      "Free text the host searches for, matching titles and descriptions. Omit to list everything.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))).annotate(
    { description: "How many issues to return. Defaults to 30." },
  ),
});

const IssueListToolResult = Schema.Struct({
  issues: Schema.Array(IssueListEntry),
  truncated: Schema.Boolean,
});

const IssueNumberInput = Schema.Struct({
  number: PositiveInt.annotate({
    description: "The issue number, as it appears in the repository.",
  }),
});

const readonlyIssueTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true) as T;

const writingIssueTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.Readonly, false).annotate(Tool.Destructive, false) as T;

export const IssueListTool = readonlyIssueTool(
  Tool.make("issue_list", {
    description:
      "List issues on the repository this thread's project belongs to. Works on GitHub and on Forgejo or Gitea. Use `query` to search titles and descriptions on the host.",
    parameters: IssueListToolInput,
    success: IssueListToolResult,
    failure: IssueToolError,
    dependencies,
  }).annotate(Tool.Title, "List issues"),
);

export const IssueReadTool = readonlyIssueTool(
  Tool.make("issue_read", {
    description:
      "Read one issue with its description and its whole conversation, so the argument in the comments is available and not just the original report.",
    parameters: IssueNumberInput,
    success: IssueDetail,
    failure: IssueToolError,
    dependencies,
  }).annotate(Tool.Title, "Read an issue"),
);

export const IssueCommentTool = writingIssueTool(
  Tool.make("issue_comment", {
    description:
      "Post a comment on an issue. Visible to everyone who can see the repository, so say something worth saying.",
    parameters: Schema.Struct({
      ...IssueNumberInput.fields,
      body: Schema.String.annotate({ description: "The comment, as Markdown." }),
    }),
    success: Schema.Void,
    failure: IssueToolError,
    dependencies,
  }).annotate(Tool.Title, "Comment on an issue"),
);

export const IssueCreateTool = writingIssueTool(
  Tool.make("issue_create", {
    description:
      "Open a new issue on this project's repository. Check `issue_list` first: filing a duplicate is worse than filing nothing.",
    parameters: Schema.Struct({
      title: Schema.String.annotate({ description: "A one-line summary." }),
      body: Schema.optional(Schema.String).annotate({
        description: "The description, as Markdown.",
      }),
    }),
    success: IssueCreateResult,
    failure: IssueToolError,
    dependencies,
  }).annotate(Tool.Title, "Open an issue"),
);

export const IssueSetStateTool = writingIssueTool(
  Tool.make("issue_set_state", {
    description: "Close an issue, or open it again.",
    parameters: Schema.Struct({
      ...IssueNumberInput.fields,
      state: IssueState.annotate({ description: "The state to move the issue to." }),
    }),
    success: Schema.Void,
    failure: IssueToolError,
    dependencies,
  }).annotate(Tool.Title, "Close or reopen an issue"),
);

export const IssueToolkit = Toolkit.make(
  IssueListTool,
  IssueReadTool,
  IssueCommentTool,
  IssueCreateTool,
  IssueSetStateTool,
);
