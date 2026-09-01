/**
 * Issues, as the clients read and write them.
 *
 * Deliberately narrower than the change request contract next door: an issue has no branches,
 * no diff, no review and no merge, so what is left is a conversation with a state. The actor and
 * label shapes are the change request's own, because a person and a label are the same thing
 * whichever list they appear in.
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PullRequestActor, PullRequestLabel } from "./pullRequest.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

export const IssueActor = PullRequestActor;
export type IssueActor = typeof IssueActor.Type;

export const IssueLabel = PullRequestLabel;
export type IssueLabel = typeof IssueLabel.Type;

export const IssueState = Schema.Literals(["open", "closed"]);
export type IssueState = typeof IssueState.Type;

export const IssueListState = Schema.Literals(["all", "open", "closed"]);
export type IssueListState = typeof IssueListState.Type;

/**
 * Whose issues to show. `all` is everything in the repository; the other two are the reader's
 * own, which is the pair every host narrows by and the only pair worth a control.
 */
export const IssueInvolvement = Schema.Literals(["all", "authored", "assigned"]);
export type IssueInvolvement = typeof IssueInvolvement.Type;

/** What a host can do with issues; anything absent is never offered on the panel. */
export const IssueCapabilities = Schema.Struct({
  /** A comment can be posted, and the conversation read back. */
  comment: Schema.Boolean,
  /** A new issue can be opened. */
  create: Schema.Boolean,
  /** An issue can be closed, and opened again. */
  close: Schema.Boolean,
  /**
   * The host narrows a listing by free text itself. False means it answers unnarrowed and the
   * caller narrows what arrived, which reaches only as far as the page it was given.
   */
  search: Schema.Boolean,
});
export type IssueCapabilities = typeof IssueCapabilities.Type;

export const IssueListEntry = Schema.Struct({
  provider: SourceControlProviderKind,
  host: TrimmedNonEmptyString,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(IssueActor),
  state: IssueState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** The host's own count, which the conversation itself may be shorter than until it loads. */
  commentCount: NonNegativeInt,
  labels: Schema.Array(IssueLabel),
  assignees: Schema.Array(IssueActor),
});
export type IssueListEntry = typeof IssueListEntry.Type;

export const IssueComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(IssueActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  url: Schema.NullOr(Schema.String),
});
export type IssueComment = typeof IssueComment.Type;

export const IssueDetail = Schema.Struct({
  ...IssueListEntry.fields,
  body: Schema.String,
  closedAt: Schema.NullOr(IsoDateTime),
  comments: Schema.Array(IssueComment),
  /** The conversation was longer than one read; what is here is the start of it. */
  commentsTruncated: Schema.Boolean,
  capabilities: IssueCapabilities,
  /** False where the reader may look but not write, which is most public repositories. */
  viewerCanWrite: Schema.Boolean,
});
export type IssueDetail = typeof IssueDetail.Type;

export const IssueProviderSummary = Schema.Struct({
  host: TrimmedNonEmptyString,
  kind: SourceControlProviderKind,
  projectCount: PositiveInt,
  configured: Schema.Boolean,
  searchesOnHost: Schema.Boolean,
  detail: Schema.NullOr(TrimmedNonEmptyString),
});
export type IssueProviderSummary = typeof IssueProviderSummary.Type;

/** One project that could not be read; the healthy ones still answer with their issues. */
export const IssueListProjectError = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type IssueListProjectError = typeof IssueListProjectError.Type;

const ISSUE_QUERY_MAX_LENGTH = 200;
const ISSUE_TITLE_MAX_LENGTH = 500;
const ISSUE_BODY_MAX_LENGTH = 65_536;

export const IssueListInput = Schema.Struct({
  /**
   * Which project's issues to read. The panel follows the project it was opened beside, so this
   * is always named rather than being a whole-workspace listing.
   */
  projectId: ProjectId,
  state: IssueListState,
  involvement: Schema.optional(IssueInvolvement),
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_QUERY_MAX_LENGTH))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type IssueListInput = typeof IssueListInput.Type;

export const IssueListResult = Schema.Struct({
  entries: Schema.Array(IssueListEntry),
  provider: Schema.NullOr(IssueProviderSummary),
  errors: Schema.Array(IssueListProjectError),
  /** The repository had more issues than the listing asked for. */
  truncated: Schema.Boolean,
});
export type IssueListResult = typeof IssueListResult.Type;

export const IssueRef = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type IssueRef = typeof IssueRef.Type;

export const IssueDetailInput = IssueRef;
export type IssueDetailInput = typeof IssueDetailInput.Type;

export const IssueCommentInput = Schema.Struct({
  ...IssueRef.fields,
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_BODY_MAX_LENGTH)),
});
export type IssueCommentInput = typeof IssueCommentInput.Type;

export const IssueCreateInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_LENGTH)),
  /** Optional because a title alone is a usable issue, and often the honest one. */
  body: Schema.optional(Schema.String.check(Schema.isMaxLength(ISSUE_BODY_MAX_LENGTH))),
});
export type IssueCreateInput = typeof IssueCreateInput.Type;

export const IssueCreateResult = Schema.Struct({
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});
export type IssueCreateResult = typeof IssueCreateResult.Type;

export const IssueSetStateInput = Schema.Struct({
  ...IssueRef.fields,
  state: IssueState,
});
export type IssueSetStateInput = typeof IssueSetStateInput.Type;

export const IssueUnavailableReason = Schema.Literals([
  "cli-missing",
  "cli-unauthenticated",
  "provider-unsupported",
]);
export type IssueUnavailableReason = typeof IssueUnavailableReason.Type;

export class IssueUnavailableError extends Schema.TaggedErrorClass<IssueUnavailableError>()(
  "IssueUnavailableError",
  {
    reason: IssueUnavailableReason,
    provider: Schema.optional(SourceControlProviderKind),
    detail: Schema.optional(TrimmedNonEmptyString),
  },
) {
  override get message(): string {
    return this.detail ?? "Issues cannot be read for this project.";
  }
}

export class IssueOperationError extends Schema.TaggedErrorClass<IssueOperationError>()(
  "IssueOperationError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Issue operation ${this.operation} failed: ${this.detail}`;
  }
}

export const IssueRpcError = Schema.Union([IssueUnavailableError, IssueOperationError]);
export type IssueRpcError = typeof IssueRpcError.Type;

/** What a host needs before its issues can be read, as a sentence the panel can show. */
export function issueProviderRequirement(
  provider: SourceControlProviderKind,
  reason: IssueUnavailableReason,
): string | null {
  if (reason === "provider-unsupported") return null;
  switch (provider) {
    case "github":
      return reason === "cli-missing"
        ? "GitHub CLI (`gh`) is required to read issues on this host. Install it from https://cli.github.com/ and reload."
        : "GitHub CLI is not authenticated. Run `gh auth login` and retry.";
    case "forgejo":
      return reason === "cli-missing"
        ? "Forgejo CLI (`fj`) is required to sign in to an instance. Install it from https://codeberg.org/forgejo-contrib/forgejo-cli and run `fj auth login --host <host>`."
        : "Forgejo rejected the stored token, or it lacks the access this needs. Run `fj auth login --host <host>` again with issue read and write.";
    default:
      return null;
  }
}
