/**
 * One host's issues, as the issue service needs them.
 *
 * The same shape as the change request port next door and deliberately smaller: an issue is a
 * conversation with a state, so there is no diff, no review and no merge to describe. Anything a
 * host cannot do is declared in `capabilities` rather than failing when the panel asks.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  IssueActor,
  IssueCapabilities,
  IssueComment,
  IssueInvolvement,
  IssueLabel,
  IssueListState,
  IssueState,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { SourceControlProviderKind as SourceControlProviderKindSchema } from "@t3tools/contracts";

/**
 * The one failure shape every provider reports. `reason` is what the service acts on: a missing
 * or unauthenticated tool takes the host out of the panel with a sentence saying how to fix it,
 * and anything else belongs to the one request that failed.
 */
export class IssueProviderError extends Schema.TaggedErrorClass<IssueProviderError>()(
  "IssueProviderError",
  {
    provider: SourceControlProviderKindSchema,
    operation: Schema.String,
    reason: Schema.Literals(["missing-tool", "unauthenticated", "rate-limited", "failed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

/** Where a repository lives, as the caller already knows it from the project. */
export interface ProviderIssueRef {
  readonly cwd: string;
  /** Provider-native repository identity, e.g. `owner/repo`. */
  readonly repository: string;
  /** The host it lives on, which `repository` leaves out. */
  readonly host: string;
}

export interface ProviderIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: IssueActor | null;
  readonly state: IssueState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly commentCount: number;
  readonly labels: ReadonlyArray<IssueLabel>;
  readonly assignees: ReadonlyArray<IssueActor>;
}

export interface ProviderIssuePage {
  readonly items: ReadonlyArray<ProviderIssue>;
  /** The host has more than the listing asked for. */
  readonly truncated: boolean;
}

export interface ProviderIssueDetail extends ProviderIssue {
  readonly body: string;
  readonly closedAt: string | null;
  readonly comments: ReadonlyArray<IssueComment>;
  readonly commentsTruncated: boolean;
  /** Whether this account may write here, which is what hides the composer from a reader. */
  readonly viewerCanWrite: boolean;
}

export interface IssueProviderApi {
  readonly kind: SourceControlProviderKind;
  readonly capabilities: IssueCapabilities;

  /** The signed-in account, which is what an involvement filter compares against. */
  readonly getViewer: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string, IssueProviderError>;

  readonly listIssues: (
    input: ProviderIssueRef & {
      readonly state: IssueListState;
      readonly involvement: IssueInvolvement;
      readonly viewer: string;
      readonly limit: number;
      /**
       * Free text as the host understands it. A host with no text filter of its own answers
       * unnarrowed, which is a wider answer rather than a wrong one, and says so through
       * `capabilities.search` so the panel can tell the reader.
       */
      readonly query?: string | undefined;
    },
  ) => Effect.Effect<ProviderIssuePage, IssueProviderError>;

  readonly getIssue: (
    input: ProviderIssueRef & { readonly number: number },
  ) => Effect.Effect<ProviderIssueDetail, IssueProviderError>;

  /** Only called when `capabilities.comment` is true. */
  readonly comment: (
    input: ProviderIssueRef & { readonly number: number; readonly body: string },
  ) => Effect.Effect<void, IssueProviderError>;

  /** Only called when `capabilities.create` is true. */
  readonly createIssue: (
    input: ProviderIssueRef & {
      readonly title: string;
      readonly body: string;
    },
  ) => Effect.Effect<{ readonly number: number; readonly url: string }, IssueProviderError>;

  /** Closes an issue, or opens it again. Only called when `capabilities.close` is true. */
  readonly setState: (
    input: ProviderIssueRef & { readonly number: number; readonly state: IssueState },
  ) => Effect.Effect<void, IssueProviderError>;
}
