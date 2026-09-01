/**
 * GitHub's issues, through the `gh` CLI.
 *
 * The CLI is what already carries GitHub credentials here, so issues are read the same way
 * change requests are rather than by holding a second set of tokens. Repositories are addressed
 * as `host/owner/repo`, which is what lets an Enterprise install work beside github.com.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import type {
  IssueActor,
  IssueCapabilities,
  IssueComment,
  IssueLabel,
  IssueListState,
} from "@t3tools/contracts";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import {
  IssueProviderError,
  type IssueProviderApi,
  type ProviderIssue,
  type ProviderIssueDetail,
} from "./IssueProvider.ts";

const CAPABILITIES: IssueCapabilities = {
  comment: true,
  create: true,
  close: true,
  // `gh issue list --search` hands the term to GitHub's own issue search.
  search: true,
};

const GitHubActorSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubLabelSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubIssueSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(GitHubActorSchema)),
  labels: Schema.optional(Schema.NullOr(Schema.Array(GitHubLabelSchema))),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(GitHubActorSchema))),
});

const GitHubIssueCommentSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(GitHubActorSchema)),
});

const GitHubIssueDetailSchema = Schema.Struct({
  ...GitHubIssueSchema.fields,
  comments: Schema.optional(Schema.NullOr(Schema.Array(GitHubIssueCommentSchema))),
});

const GitHubRepositoryPermissionSchema = Schema.Struct({
  viewerPermission: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeIssueList = decodeJsonResult(Schema.Array(GitHubIssueSchema));
const decodeIssueDetail = decodeJsonResult(GitHubIssueDetailSchema);
const decodeRepositoryPermission = decodeJsonResult(GitHubRepositoryPermissionSchema);

const LIST_FIELDS = "number,title,url,author,state,createdAt,updatedAt,labels,assignees";
const DETAIL_FIELDS = `${LIST_FIELDS},body,closedAt,comments`;

const ISO_FALLBACK = "1970-01-01T00:00:00Z";

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value : "";
}

function iso(value: string | null | undefined): string {
  const trimmed = text(value).trim();
  if (trimmed.length === 0) return ISO_FALLBACK;
  return Option.match(DateTime.make(trimmed), {
    onNone: () => ISO_FALLBACK,
    onSome: DateTime.formatIso,
  });
}

function actor(raw: typeof GitHubActorSchema.Type | null | undefined): IssueActor | null {
  const login = text(raw?.login).trim();
  if (login.length === 0) return null;
  const name = text(raw?.name).trim();
  return { login, name: name.length > 0 ? name : null, avatarUrl: null };
}

function labels(
  rows: ReadonlyArray<typeof GitHubLabelSchema.Type> | null | undefined,
): ReadonlyArray<IssueLabel> {
  const result: Array<IssueLabel> = [];
  for (const row of rows ?? []) {
    const name = text(row.name).trim();
    if (name.length === 0) continue;
    const color = text(row.color).trim();
    result.push({ name, color: color.length > 0 ? color.replace(/^#/u, "") : null });
  }
  return result;
}

function toIssue(raw: typeof GitHubIssueSchema.Type): ProviderIssue {
  const title = text(raw.title).trim();
  return {
    number: raw.number,
    title: title.length > 0 ? title : `#${raw.number}`,
    url: text(raw.url).trim(),
    author: actor(raw.author),
    state: text(raw.state).trim().toUpperCase() === "CLOSED" ? "closed" : "open",
    createdAt: iso(raw.createdAt),
    updatedAt: iso(raw.updatedAt),
    // `gh issue list` reports no count, and asking for one costs the whole conversation per row.
    // Zero is what a host that was not asked has always sent, and the panel shows no count for it.
    commentCount: 0,
    labels: labels(raw.labels),
    assignees: (raw.assignees ?? []).flatMap((entry) => actor(entry) ?? []),
  };
}

function toComment(raw: typeof GitHubIssueCommentSchema.Type, index: number): IssueComment {
  const id = text(raw.id).trim();
  return {
    id: id.length > 0 ? `issue-comment:${id}` : `issue-comment:index-${index}`,
    author: actor(raw.author),
    body: text(raw.body),
    createdAt: iso(raw.createdAt),
    url: text(raw.url).trim() || null,
  };
}

/** `gh` takes `[HOST/]OWNER/REPO`, which is what keeps an Enterprise install apart. */
function repoArgument(host: string, repository: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.length === 0 ? repository : `${trimmed}/${repository}`;
}

const LIST_STATE: Record<IssueListState, string> = {
  all: "all",
  open: "open",
  closed: "closed",
};

export class GitHubIssueProvider extends Context.Service<GitHubIssueProvider, IssueProviderApi>()(
  "t3/issue/GitHubIssueProvider",
) {}

export const make = Effect.gen(function* () {
  const cli = yield* GitHubCli.GitHubCli;

  const fail =
    (operation: string) =>
    (error: GitHubCli.GitHubCliError): IssueProviderError =>
      new IssueProviderError({
        provider: "github",
        operation,
        reason:
          error._tag === "GitHubCliUnavailableError"
            ? "missing-tool"
            : error._tag === "GitHubCliAuthenticationError"
              ? "unauthenticated"
              : error._tag === "GitHubCliRateLimitError"
                ? "rate-limited"
                : "failed",
        detail: error.detail,
        cause: error,
      });

  const run = (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
  }) =>
    cli
      .execute({
        cwd: input.cwd,
        args: input.args,
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      })
      .pipe(
        Effect.mapError(fail(input.operation)),
        Effect.withSpan(`GitHubIssueProvider.${input.operation}`),
      );

  const read = <A>(
    input: Parameters<typeof run>[0] & {
      readonly decode: (body: string) => Result.Result<A, unknown>;
    },
  ): Effect.Effect<A, IssueProviderError> =>
    run(input).pipe(
      Effect.flatMap((output) => {
        const decoded = input.decode(output.stdout);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new IssueProviderError({
                provider: "github",
                operation: input.operation,
                reason: "failed",
                detail: "GitHub CLI returned a payload this could not read.",
                cause: decoded.failure,
              }),
            );
      }),
    );

  const listIssues: IssueProviderApi["listIssues"] = (input) =>
    Effect.gen(function* () {
      const args = [
        "issue",
        "list",
        "--repo",
        repoArgument(input.host, input.repository),
        "--state",
        LIST_STATE[input.state],
        "--limit",
        String(Math.min(Math.max(input.limit, 1), 200)),
        "--json",
        LIST_FIELDS,
      ];
      const search = input.query?.trim() ?? "";
      if (search.length > 0) args.push("--search", search);
      if (input.involvement === "authored") args.push("--author", "@me");
      if (input.involvement === "assigned") args.push("--assignee", "@me");

      const rows = yield* read({
        operation: "listIssues",
        cwd: input.cwd,
        args,
        decode: decodeIssueList,
      });
      return { items: rows.map(toIssue), truncated: rows.length >= input.limit };
    });

  const getIssue: IssueProviderApi["getIssue"] = (input) =>
    Effect.gen(function* () {
      const repo = repoArgument(input.host, input.repository);
      const [raw, permission] = yield* Effect.all(
        [
          read({
            operation: "getIssue",
            cwd: input.cwd,
            args: ["issue", "view", String(input.number), "--repo", repo, "--json", DETAIL_FIELDS],
            decode: decodeIssueDetail,
          }),
          read({
            operation: "getIssue",
            cwd: input.cwd,
            args: ["repo", "view", repo, "--json", "viewerPermission"],
            decode: decodeRepositoryPermission,
          }).pipe(
            // A permission that could not be read is granted, so a reader entitled to write is
            // not left without a composer; GitHub refuses the write with its own sentence.
            Effect.orElseSucceed(() => ({ viewerPermission: null })),
          ),
        ],
        { concurrency: 2 },
      );

      const level = text(permission.viewerPermission).trim().toUpperCase();
      return {
        ...toIssue(raw),
        body: text(raw.body),
        closedAt: text(raw.closedAt).trim().length > 0 ? iso(raw.closedAt) : null,
        comments: (raw.comments ?? []).map(toComment),
        // `gh issue view` returns the whole conversation, so there is never a remainder.
        commentsTruncated: false,
        viewerCanWrite:
          level.length === 0 || level === "WRITE" || level === "ADMIN" || level === "MAINTAIN",
      } satisfies ProviderIssueDetail;
    });

  return {
    kind: "github",
    capabilities: CAPABILITIES,

    getViewer: (input) =>
      run({
        operation: "getViewer",
        cwd: input.cwd,
        args: ["api", "user", "--jq", ".login"],
      }).pipe(
        Effect.flatMap((output) => {
          const login = output.stdout.trim();
          return login.length === 0
            ? Effect.fail(
                new IssueProviderError({
                  provider: "github",
                  operation: "getViewer",
                  reason: "unauthenticated",
                  detail: "GitHub CLI did not name the signed-in account.",
                }),
              )
            : Effect.succeed(login);
        }),
      ),

    listIssues,
    getIssue,

    // The body travels on stdin rather than in argv, so a comment cannot land in a process list.
    comment: (input) =>
      run({
        operation: "comment",
        cwd: input.cwd,
        args: [
          "issue",
          "comment",
          String(input.number),
          "--repo",
          repoArgument(input.host, input.repository),
          "--body-file",
          "-",
        ],
        stdin: input.body,
      }).pipe(Effect.asVoid),

    createIssue: (input) =>
      run({
        operation: "createIssue",
        cwd: input.cwd,
        args: [
          "issue",
          "create",
          "--repo",
          repoArgument(input.host, input.repository),
          "--title",
          input.title,
          "--body-file",
          "-",
        ],
        stdin: input.body,
      }).pipe(
        Effect.flatMap((output) => {
          // `gh issue create` answers with the new issue's URL and nothing else.
          const url = output.stdout.trim().split(/\s+/u).at(-1) ?? "";
          const number = Number(/\/issues\/(\d+)\s*$/u.exec(url)?.[1]);
          return Number.isSafeInteger(number) && number > 0
            ? Effect.succeed({ number, url })
            : Effect.fail(
                new IssueProviderError({
                  provider: "github",
                  operation: "createIssue",
                  reason: "failed",
                  detail: "GitHub CLI did not report where the new issue was created.",
                }),
              );
        }),
      ),

    setState: (input) =>
      run({
        operation: "setState",
        cwd: input.cwd,
        args: [
          "issue",
          input.state === "closed" ? "close" : "reopen",
          String(input.number),
          "--repo",
          repoArgument(input.host, input.repository),
        ],
      }).pipe(Effect.asVoid),
  } satisfies IssueProviderApi;
});

export const layer = Layer.effect(GitHubIssueProvider, make);
