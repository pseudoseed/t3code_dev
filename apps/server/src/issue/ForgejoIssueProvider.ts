/**
 * Forgejo's issues, over its v1 REST API.
 *
 * Sits on `ForgejoApi.request` for credentials and transport, the same way the change request
 * reader does. Gitea speaks the same API, so one provider serves both. Schemas and normalization
 * live here rather than in a file of their own: an issue is small enough that splitting it would
 * cost more to follow than it saves.
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

import * as ForgejoApi from "../sourceControl/ForgejoApi.ts";
import {
  IssueProviderError,
  type IssueProviderApi,
  type ProviderIssue,
  type ProviderIssueDetail,
  type ProviderIssueRef,
} from "./IssueProvider.ts";

/** Forgejo's own ceiling on a page. */
const MAX_PAGE_SIZE = 50;
/** How many conversation pages one read walks before reporting the rest as unread. */
const MAX_COMMENT_PAGES = 5;

const CAPABILITIES: IssueCapabilities = {
  comment: true,
  create: true,
  close: true,
  // `/repos/{owner}/{repo}/issues` takes a `q`, which searches titles and bodies.
  search: true,
};

const ForgejoUserSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
  full_name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});

const ForgejoLabelSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

const ForgejoIssueSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  comments: Schema.optional(Schema.NullOr(Schema.Number)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(ForgejoUserSchema)),
  labels: Schema.optional(Schema.NullOr(Schema.Array(ForgejoLabelSchema))),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(ForgejoUserSchema))),
  /** Present on a pull request and absent on an issue, which is how the two are told apart. */
  pull_request: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

const ForgejoCommentSchema = Schema.Struct({
  id: Schema.Number,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(ForgejoUserSchema)),
});

const ForgejoRepositorySchema = Schema.Struct({
  permissions: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        admin: Schema.optional(Schema.NullOr(Schema.Boolean)),
        push: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
});

const decodeIssueList = decodeJsonResult(Schema.Array(ForgejoIssueSchema));
const decodeIssue = decodeJsonResult(ForgejoIssueSchema);
const decodeCommentList = decodeJsonResult(Schema.Array(ForgejoCommentSchema));
const decodeUser = decodeJsonResult(ForgejoUserSchema);
const decodeRepository = decodeJsonResult(ForgejoRepositorySchema);

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

function actor(user: typeof ForgejoUserSchema.Type | null | undefined): IssueActor | null {
  const login = text(user?.login).trim();
  if (login.length === 0) return null;
  const name = text(user?.full_name).trim();
  const avatarUrl = text(user?.avatar_url).trim();
  return {
    login,
    name: name.length > 0 ? name : null,
    avatarUrl: avatarUrl.length > 0 ? avatarUrl : null,
  };
}

function labels(
  rows: ReadonlyArray<typeof ForgejoLabelSchema.Type> | null | undefined,
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

function toIssue(raw: typeof ForgejoIssueSchema.Type): ProviderIssue {
  const title = text(raw.title).trim();
  return {
    number: raw.number,
    title: title.length > 0 ? title : `#${raw.number}`,
    url: text(raw.html_url).trim(),
    author: actor(raw.user),
    state: text(raw.state).trim().toLowerCase() === "closed" ? "closed" : "open",
    createdAt: iso(raw.created_at),
    updatedAt: iso(raw.updated_at),
    commentCount:
      typeof raw.comments === "number" && raw.comments > 0 ? Math.trunc(raw.comments) : 0,
    labels: labels(raw.labels),
    assignees: (raw.assignees ?? []).flatMap((entry) => actor(entry) ?? []),
  };
}

function toComment(raw: typeof ForgejoCommentSchema.Type): IssueComment {
  return {
    id: `issue-comment:${raw.id}`,
    author: actor(raw.user),
    body: text(raw.body),
    createdAt: iso(raw.created_at),
    url: text(raw.html_url).trim() || null,
  };
}

function repositoryPath(
  repository: string,
  operation: string,
): Effect.Effect<string, IssueProviderError> {
  const parts = repository.split("/").filter((part) => part.length > 0);
  const [owner, repo] = parts;
  return parts.length !== 2 || owner === undefined || repo === undefined
    ? Effect.fail(
        new IssueProviderError({
          provider: "forgejo",
          operation,
          reason: "failed",
          detail: `Forgejo repositories are addressed as owner/repository; got "${repository}".`,
        }),
      )
    : Effect.succeed(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
}

export class ForgejoIssueProvider extends Context.Service<ForgejoIssueProvider, IssueProviderApi>()(
  "t3/issue/ForgejoIssueProvider",
) {}

export const make = Effect.gen(function* () {
  const forgejo = yield* ForgejoApi.ForgejoApi;

  const fail =
    (operation: string) =>
    (error: ForgejoApi.ForgejoApiError): IssueProviderError =>
      new IssueProviderError({
        provider: "forgejo",
        operation,
        // A token with too few scopes is refused with 403, and the fix is the same as for 401.
        reason:
          error.status === 401 || error.status === 403
            ? "unauthenticated"
            : error.status === 429
              ? "rate-limited"
              : "failed",
        detail: error.detail,
        cause: error,
      });

  const send = (input: {
    readonly operation: string;
    readonly method: "GET" | "POST" | "PATCH" | "DELETE";
    readonly host: string;
    readonly cwd: string;
    readonly path: string;
    readonly body?: unknown;
  }) =>
    forgejo
      .request({
        operation: input.operation,
        method: input.method,
        host: input.host,
        cwd: input.cwd,
        path: input.path,
        ...(input.body === undefined ? {} : { body: stringifyBody(input.body) }),
      })
      .pipe(Effect.mapError(fail(input.operation)));

  const read = <A>(
    input: Parameters<typeof send>[0] & {
      readonly decode: (body: string) => Result.Result<A, unknown>;
    },
  ): Effect.Effect<A, IssueProviderError> =>
    send(input).pipe(
      Effect.flatMap((response) => {
        const decoded = input.decode(response.body);
        return Result.isSuccess(decoded)
          ? Effect.annotateCurrentSpan({
              "forgejo.rows": Array.isArray(decoded.success) ? decoded.success.length : -1,
            }).pipe(Effect.as(decoded.success))
          : Effect.fail(
              new IssueProviderError({
                provider: "forgejo",
                operation: input.operation,
                reason: "failed",
                detail: "Forgejo returned a payload this could not read.",
                cause: decoded.failure,
              }),
            );
      }),
      Effect.withSpan(`ForgejoIssueProvider.${input.operation}`, {
        attributes: { "forgejo.path": input.path },
      }),
    );

  const viewerByHost = new Map<string, string>();

  const getViewer: IssueProviderApi["getViewer"] = (input) =>
    Effect.gen(function* () {
      const locator = yield* forgejo
        .resolveLocator({ cwd: input.cwd })
        .pipe(Effect.mapError(fail("getViewer")));
      const cached = viewerByHost.get(locator.host);
      if (cached !== undefined) return cached;
      const user = yield* read({
        operation: "getViewer",
        method: "GET",
        host: locator.host,
        cwd: input.cwd,
        path: "/user",
        decode: decodeUser,
      });
      const login = text(user.login).trim();
      if (login.length === 0) {
        return yield* new IssueProviderError({
          provider: "forgejo",
          operation: "getViewer",
          reason: "unauthenticated",
          detail: "Forgejo did not name the signed-in account.",
        });
      }
      viewerByHost.set(locator.host, login);
      return login;
    });

  const hostState = (state: IssueListState): "open" | "closed" | "all" => state;

  const listIssues: IssueProviderApi["listIssues"] = (input) =>
    Effect.gen(function* () {
      const base = yield* repositoryPath(input.repository, "listIssues");
      const limit = Math.min(Math.max(input.limit, 1), MAX_PAGE_SIZE);
      const query = new URLSearchParams({
        // Forgejo lists issues and pull requests together unless it is told which.
        type: "issues",
        state: hostState(input.state),
        sort: "recentupdate",
        page: "1",
        limit: String(limit),
      });
      const search = input.query?.trim() ?? "";
      if (search.length > 0) query.set("q", search);
      if (input.involvement === "authored" && input.viewer.length > 0) {
        query.set("created_by", input.viewer);
      }
      if (input.involvement === "assigned" && input.viewer.length > 0) {
        query.set("assigned_by", input.viewer);
      }

      const rows = yield* read({
        operation: "listIssues",
        method: "GET",
        host: input.host,
        cwd: input.cwd,
        path: `${base}/issues?${query.toString()}`,
        decode: decodeIssueList,
      });

      // `type=issues` is honoured by current Forgejo, and the guard costs nothing on a host
      // that ignores it: a row carrying `pull_request` is a change request, not an issue.
      const items = rows.filter((row) => !row.pull_request).map(toIssue);
      return { items, truncated: rows.length >= limit };
    });

  const readComments = (input: ProviderIssueRef & { readonly number: number }) => {
    const step = (
      base: string,
      page: number,
      collected: ReadonlyArray<IssueComment>,
    ): Effect.Effect<
      { readonly comments: ReadonlyArray<IssueComment>; readonly truncated: boolean },
      IssueProviderError
    > =>
      read({
        operation: "getIssue",
        method: "GET",
        host: input.host,
        cwd: input.cwd,
        path: `${base}/issues/${input.number}/comments?page=${page}&limit=${MAX_PAGE_SIZE}`,
        decode: decodeCommentList,
      }).pipe(
        Effect.flatMap((rows) => {
          const comments = [...collected, ...rows.map(toComment)];
          if (rows.length < MAX_PAGE_SIZE) {
            return Effect.succeed({ comments, truncated: false });
          }
          if (page >= MAX_COMMENT_PAGES) return Effect.succeed({ comments, truncated: true });
          return step(base, page + 1, comments);
        }),
      );
    return repositoryPath(input.repository, "getIssue").pipe(
      Effect.flatMap((base) => step(base, 1, [])),
    );
  };

  const getIssue: IssueProviderApi["getIssue"] = (input) =>
    Effect.gen(function* () {
      const base = yield* repositoryPath(input.repository, "getIssue");
      const [raw, conversation, repository] = yield* Effect.all(
        [
          read({
            operation: "getIssue",
            method: "GET",
            host: input.host,
            cwd: input.cwd,
            path: `${base}/issues/${input.number}`,
            decode: decodeIssue,
          }),
          readComments(input),
          read({
            operation: "getIssue",
            method: "GET",
            host: input.host,
            cwd: input.cwd,
            path: base,
            decode: decodeRepository,
          }).pipe(
            // A permission that could not be read is granted: a hidden composer leaves someone
            // entitled to write with no way to, and a refusal at least says why.
            Effect.orElseSucceed(() => ({ permissions: null })),
          ),
        ],
        { concurrency: 3 },
      );

      const permissions = repository.permissions;
      return {
        ...toIssue(raw),
        body: text(raw.body),
        closedAt: text(raw.closed_at).trim().length > 0 ? iso(raw.closed_at) : null,
        comments: conversation.comments,
        commentsTruncated: conversation.truncated,
        viewerCanWrite:
          permissions === null || permissions === undefined
            ? true
            : permissions.push === true || permissions.admin === true,
      } satisfies ProviderIssueDetail;
    });

  return {
    kind: "forgejo",
    capabilities: CAPABILITIES,
    getViewer,
    listIssues,
    getIssue,
    comment: (input) =>
      repositoryPath(input.repository, "comment").pipe(
        Effect.flatMap((base) =>
          send({
            operation: "comment",
            method: "POST",
            host: input.host,
            cwd: input.cwd,
            path: `${base}/issues/${input.number}/comments`,
            body: { body: input.body },
          }),
        ),
        Effect.asVoid,
      ),
    createIssue: (input) =>
      repositoryPath(input.repository, "createIssue").pipe(
        Effect.flatMap((base) =>
          read({
            operation: "createIssue",
            method: "POST",
            host: input.host,
            cwd: input.cwd,
            path: `${base}/issues`,
            body: { title: input.title, body: input.body },
            decode: decodeIssue,
          }),
        ),
        Effect.map((raw) => ({ number: raw.number, url: text(raw.html_url).trim() })),
      ),
    setState: (input) =>
      repositoryPath(input.repository, "setState").pipe(
        Effect.flatMap((base) =>
          send({
            operation: "setState",
            method: "PATCH",
            host: input.host,
            cwd: input.cwd,
            path: `${base}/issues/${input.number}`,
            body: { state: input.state },
          }),
        ),
        Effect.asVoid,
      ),
  } satisfies IssueProviderApi;
});

/** One place for the encode, so the diagnostic suppression is not repeated at every call. */
function stringifyBody(body: unknown): string {
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  return JSON.stringify(body);
}

export const layer = Layer.effect(ForgejoIssueProvider, make);
