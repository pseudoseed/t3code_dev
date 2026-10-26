import { SourceControlProviderKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { IssueActor, IssueComment } from "@t3tools/contracts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import { IssueProviderError, type IssueProviderApi, type ProviderIssue } from "./IssueProvider.ts";

const Actor = Schema.Struct({
  login: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.String),
});
const Issue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  html_url: Schema.String,
  state: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.NullOr(Actor),
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  comments: Schema.optional(Schema.Number),
  labels: Schema.Array(
    Schema.Union([
      Schema.String,
      Schema.Struct({ name: Schema.String, color: Schema.optional(Schema.NullOr(Schema.String)) }),
    ]),
  ),
  assignees: Schema.Array(Actor),
});
const Comment = Schema.Struct({
  id: Schema.Number,
  body: Schema.String,
  html_url: Schema.String,
  created_at: Schema.String,
  user: Schema.NullOr(Actor),
});
const Repository = Schema.Struct({
  has_issues: Schema.optional(Schema.Boolean),
  permissions: Schema.optional(
    Schema.Struct({
      push: Schema.optional(Schema.Boolean),
      admin: Schema.optional(Schema.Boolean),
      maintain: Schema.optional(Schema.Boolean),
    }),
  ),
});
const Search = Schema.Struct({
  items: Schema.Array(Issue),
  total_count: Schema.Number,
  incomplete_results: Schema.optional(Schema.Boolean),
});
const Created = Schema.Struct({ number: Schema.Number, html_url: Schema.String });
const actor = (raw: typeof Actor.Type | null): IssueActor | null =>
  raw === null
    ? null
    : { login: raw.login, name: raw.name ?? null, avatarUrl: raw.avatar_url ?? null };
const iso = (value: string) =>
  Option.match(DateTime.make(value), {
    onNone: () => "1970-01-01T00:00:00Z",
    onSome: DateTime.formatIso,
  });
const issue = (raw: typeof Issue.Type): ProviderIssue => ({
  number: raw.number,
  title: raw.title.trim() || `#${raw.number}`,
  url: raw.html_url,
  author: actor(raw.user),
  state: raw.state === "closed" ? "closed" : "open",
  createdAt: iso(raw.created_at),
  updatedAt: iso(raw.updated_at),
  commentCount: raw.comments ?? 0,
  labels: raw.labels.map((label) =>
    typeof label === "string"
      ? { name: label, color: null }
      : { name: label.name, color: label.color?.replace(/^#/, "") ?? null },
  ),
  assignees: raw.assignees.flatMap((row) => actor(row) ?? []),
});
const repositoryPath = (repository: string) =>
  `repos/${repository.split("/").map(encodeURIComponent).join("/")}`;

/** Uses the upstream credential selection, Enterprise routing and rate-limit budget. */
export const make = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const fail = (operation: string) => (cause: GitHubRequestPolicy.GitHubApiError) =>
    new IssueProviderError({
      provider: SourceControlProviderKind.make("github"),
      operation,
      reason:
        cause._tag === "GitHubCliMissingError"
          ? "missing-tool"
          : cause._tag === "GitHubApiAuthenticationError" ||
              cause._tag === "GitHubNotSignedInError" ||
              cause._tag === "GitHubHostDisabledError"
            ? "unauthenticated"
            : cause._tag === "GitHubApiRateLimitError" ||
                cause._tag === "SourceControlRateLimitPausedError"
              ? "rate-limited"
              : "failed",
      detail: cause.message,
      cause,
    });
  const request = (input: GitHubRest.GitHubRestInput) =>
    api.rest({ ...input, allowReserve: true }).pipe(Effect.mapError(fail(input.operation)));
  const read = <A, I>(input: GitHubRest.GitHubRestInput, schema: Schema.Codec<A, I>) =>
    request(input).pipe(
      Effect.flatMap((response) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(response.body).pipe(
          Effect.mapError(
            (cause) =>
              new IssueProviderError({
                provider: SourceControlProviderKind.make("github"),
                operation: input.operation,
                reason: "failed",
                detail: "GitHub returned an invalid issue response.",
                cause,
              }),
          ),
        ),
      ),
    );
  const readRepository = (input: { host: string; repository: string }) =>
    read(
      {
        host: input.host,
        operation: "readIssueRepository",
        path: repositoryPath(input.repository),
      },
      Repository,
    );
  return {
    kind: SourceControlProviderKind.make("github"),
    capabilities: { comment: true, create: true, close: true, search: true },
    getViewer: (input) =>
      read({ host: input.host ?? "github.com", operation: "getViewer", path: "user" }, Actor).pipe(
        Effect.map((viewer) => viewer.login),
      ),
    listIssues: Effect.fn("GitHubIssueProvider.listIssues")(
      function* (input: Parameters<IssueProviderApi["listIssues"]>[0]) {
        const limit = Math.min(Math.max(input.limit, 1), 200);
        const query = [
          `repo:${input.repository}`,
          "is:issue",
          ...(input.state === "all" ? [] : [`is:${input.state}`]),
          ...(input.viewer.trim() === ""
            ? []
            : input.involvement === "authored"
              ? [`author:${input.viewer}`]
              : input.involvement === "assigned"
                ? [`assignee:${input.viewer}`]
                : []),
          input.query?.trim() ?? "",
        ].join(" ");
        const items: ProviderIssue[] = [];
        let total = 0;
        let incomplete = false;
        for (let page = 1; items.length < limit; page++) {
          const size = Math.min(100, limit);
          const response = yield* read(
            {
              host: input.host,
              operation: "listIssues",
              path: `search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${size}&page=${page}`,
            },
            Search,
          );
          items.push(...response.items.map(issue));
          total = response.total_count;
          incomplete ||= response.incomplete_results === true;
          if (response.items.length < size || items.length >= total) break;
        }
        if (items.length === 0) {
          const repository = yield* readRepository(input).pipe(
            Effect.orElseSucceed(() => ({ has_issues: true })),
          );
          if (repository.has_issues === false)
            return {
              items,
              truncated: false,
              disabledReason: "Issues are turned off for this repository on GitHub.",
            };
        }
        return {
          items: items.slice(0, limit),
          truncated: incomplete || Math.min(items.length, limit) < total,
        };
      },
      (effect, input) =>
        effect.pipe(
          Effect.catchIf(
            (error) => error.reason === "failed",
            (error) =>
              readRepository(input).pipe(
                Effect.orElseSucceed(() => ({ has_issues: true })),
                Effect.flatMap((repository) =>
                  repository.has_issues === false
                    ? Effect.succeed({
                        items: [],
                        truncated: false,
                        disabledReason: "Issues are turned off for this repository on GitHub.",
                      })
                    : Effect.fail(error),
                ),
              ),
          ),
        ),
    ),
    getIssue: Effect.fn("GitHubIssueProvider.getIssue")(function* (
      input: Parameters<IssueProviderApi["getIssue"]>[0],
    ) {
      const path = `${repositoryPath(input.repository)}/issues/${input.number}`;
      const [raw, repository] = yield* Effect.all(
        [
          read({ host: input.host, operation: "getIssue", path }, Issue),
          readRepository(input).pipe(Effect.orElseSucceed(() => ({}))),
        ],
        { concurrency: 2 },
      );
      const comments: IssueComment[] = [];
      for (let page = 1; ; page++) {
        const rows = yield* read(
          {
            host: input.host,
            operation: "getIssueComments",
            path: `${path}/comments?per_page=100&page=${page}`,
          },
          Schema.Array(Comment),
        );
        comments.push(
          ...rows.map((row) => ({
            id: `issue-comment:${row.id}`,
            author: actor(row.user),
            body: row.body,
            createdAt: iso(row.created_at),
            url: row.html_url,
          })),
        );
        if (rows.length < 100) break;
      }
      const permissions = "permissions" in repository ? repository.permissions : undefined;
      return {
        ...issue(raw),
        body: raw.body ?? "",
        closedAt: raw.closed_at ? iso(raw.closed_at) : null,
        comments,
        commentsTruncated: false,
        viewerCanWrite:
          permissions === undefined ||
          permissions.push === true ||
          permissions.admin === true ||
          permissions.maintain === true,
      };
    }),
    comment: (input) =>
      request({
        host: input.host,
        operation: "comment",
        method: "POST",
        path: `${repositoryPath(input.repository)}/issues/${input.number}/comments`,
        body: { body: input.body },
      }).pipe(Effect.asVoid),
    createIssue: (input) =>
      read(
        {
          host: input.host,
          operation: "createIssue",
          method: "POST",
          path: `${repositoryPath(input.repository)}/issues`,
          body: { title: input.title, body: input.body },
        },
        Created,
      ).pipe(Effect.map((created) => ({ number: created.number, url: created.html_url }))),
    setState: (input) =>
      request({
        host: input.host,
        operation: "setState",
        method: "PATCH",
        path: `${repositoryPath(input.repository)}/issues/${input.number}`,
        body: { state: input.state },
      }).pipe(Effect.asVoid),
  } satisfies IssueProviderApi;
});
