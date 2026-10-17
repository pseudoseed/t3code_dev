import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as GitHubIssueProvider from "./GitHubIssueProvider.ts";
const rest = vi.fn<GitHubRest.GitHubRest["Service"]["rest"]>();
const layer = Layer.mock(GitHubRest.GitHubRest)({ rest });
const target = { cwd: "/repo", host: "github.enterprise.example", repository: "acme/repo" };
const output = (body: unknown) =>
  Effect.succeed({
    body: JSON.stringify(body),
    status: 200,
    headers: {},
    truncated: false,
    invalidUtf8: false,
  });
const raw = (number = 12) => ({
  number,
  title: "Fix connection",
  html_url: `https://${target.host}/acme/repo/issues/${number}`,
  state: "open",
  user: { login: "sam" },
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
  comments: 2,
  labels: [{ name: "bug", color: "#abc123" }],
  assignees: [{ login: "pat" }],
});
it.layer(layer)("GitHub issues through upstream API", (it) => {
  it.effect("routes Enterprise searches with state, involvement and search text", () =>
    Effect.gen(function* () {
      rest.mockImplementation(() => output({ items: [raw()], total_count: 1 }));
      const provider = yield* GitHubIssueProvider.make;
      const result = yield* provider.listIssues({
        ...target,
        state: "open",
        involvement: "assigned",
        viewer: "pat",
        limit: 20,
        query: "connection",
      });
      assert.equal(result.items[0]?.commentCount, 2);
      assert.deepEqual(result.items[0]?.labels, [{ name: "bug", color: "abc123" }]);
      const call = rest.mock.lastCall![0];
      assert.equal(call.host, target.host);
      assert.include(
        decodeURIComponent(call.path),
        "repo:acme/repo is:issue is:open assignee:pat connection",
      );
      assert.equal(call.allowReserve, true);
    }),
  );
  it.effect("lists issues without involvement narrowing when account lookup is unavailable", () =>
    Effect.gen(function* () {
      rest.mockImplementation((input) =>
        input.path === "user"
          ? Effect.fail(
              new GitHubRequestPolicy.GitHubApiRequestError({
                host: target.host,
                operation: "getViewer",
                cause: "Account lookup unavailable",
              }),
            )
          : output({ items: [raw()], total_count: 1 }),
      );
      const provider = yield* GitHubIssueProvider.make;
      const viewer = yield* provider.getViewer(target).pipe(Effect.orElseSucceed(() => ""));
      for (const involvement of ["authored", "assigned"] as const) {
        const result = yield* provider.listIssues({
          ...target,
          state: "open",
          involvement,
          viewer,
          limit: 20,
          query: "connection",
        });
        assert.equal(result.items[0]?.number, 12);
        const query = new URL(
          `https://api.example/${rest.mock.lastCall![0].path}`,
        ).searchParams.get("q");
        assert.equal(query, "repo:acme/repo is:issue is:open connection");
      }
    }),
  );
  it.effect("keeps pagination stable when the requested limit is not a full API page", () =>
    Effect.gen(function* () {
      rest.mockImplementation((input) =>
        output({
          items: Array.from({ length: 100 }, (_, index) =>
            raw(index + (input.path.endsWith("page=2") ? 101 : 1)),
          ),
          total_count: 200,
        }),
      );
      const provider = yield* GitHubIssueProvider.make;
      const result = yield* provider.listIssues({
        ...target,
        state: "all",
        involvement: "all",
        viewer: "pat",
        limit: 150,
      });
      assert.lengthOf(result.items, 150);
      assert.equal(result.items[149]?.number, 150);
      assert.isTrue(result.truncated);
    }),
  );
  it.effect("reports disabled trackers separately from a transport failure", () =>
    Effect.gen(function* () {
      rest.mockImplementation((input) =>
        input.path.startsWith("search/")
          ? output({ items: [], total_count: 0 })
          : output({ has_issues: false }),
      );
      const provider = yield* GitHubIssueProvider.make;
      const result = yield* provider.listIssues({
        ...target,
        state: "open",
        involvement: "all",
        viewer: "pat",
        limit: 20,
      });
      assert.include(result.disabledReason ?? "", "turned off");
      rest.mockImplementation(() =>
        Effect.fail(
          new GitHubRequestPolicy.GitHubApiRequestError({
            host: target.host,
            operation: "listIssues",
            cause: "offline",
          }),
        ),
      );
      assert.equal(
        (yield* Effect.result(
          provider.listIssues({
            ...target,
            state: "open",
            involvement: "all",
            viewer: "pat",
            limit: 20,
          }),
        ))._tag,
        "Failure",
      );
    }),
  );
  it.effect("loads issue details, comments, and repository write permission", () =>
    Effect.gen(function* () {
      rest.mockImplementation((input) =>
        input.path.includes("/comments?")
          ? output([
              {
                id: 3,
                body: "Investigating",
                html_url: "https://example/comment",
                created_at: "2026-09-02T00:00:00Z",
                user: { login: "pat" },
              },
            ])
          : input.path.endsWith("/issues/12")
            ? output({ ...raw(), body: "Details" })
            : output({ permissions: { push: false } }),
      );
      const provider = yield* GitHubIssueProvider.make;
      const result = yield* provider.getIssue({ ...target, number: 12 });
      assert.equal(result.body, "Details");
      assert.equal(result.comments[0]?.body, "Investigating");
      assert.isFalse(result.viewerCanWrite);
    }),
  );
  it.effect("writes bodies through structured API requests and can close/reopen", () =>
    Effect.gen(function* () {
      rest.mockClear();
      rest.mockImplementation(() => output({ number: 42, html_url: "https://example/issues/42" }));
      const provider = yield* GitHubIssueProvider.make;
      yield* provider.comment({ ...target, number: 12, body: "Literal `code` and $HOME" });
      assert.deepEqual(rest.mock.lastCall![0].body, { body: "Literal `code` and $HOME" });
      const created = yield* provider.createIssue({
        ...target,
        title: "New issue",
        body: "Description",
      });
      assert.equal(created.number, 42);
      yield* provider.setState({ ...target, number: 12, state: "closed" });
      assert.deepEqual(rest.mock.lastCall![0].body, { state: "closed" });
      yield* provider.setState({ ...target, number: 12, state: "open" });
      assert.deepEqual(rest.mock.lastCall![0].body, { state: "open" });
    }),
  );
});
