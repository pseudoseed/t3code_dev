import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ForgejoApi from "../sourceControl/ForgejoApi.ts";
import * as ForgejoIssueProvider from "./ForgejoIssueProvider.ts";

const request = vi.fn<ForgejoApi.ForgejoApi["Service"]["request"]>();
const resolveLocator = vi.fn<ForgejoApi.ForgejoApi["Service"]["resolveLocator"]>(() =>
  Effect.succeed({ host: "git.example.org", owner: "acme", repo: "web", scheme: "https" as const }),
);

const layer = it.layer(Layer.mock(ForgejoApi.ForgejoApi)({ request, resolveLocator }));

const target = { cwd: "/repo", host: "git.example.org", repository: "acme/web" };

function ok(body: unknown) {
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  return Effect.succeed({ status: 200, body: JSON.stringify(body), truncated: false });
}

function routes(table: Record<string, unknown>) {
  request.mockImplementation((input) => {
    for (const [path, body] of Object.entries(table)) {
      if (input.path === path || input.path.startsWith(`${path}?`)) return ok(body);
    }
    return Effect.fail(
      new ForgejoApi.ForgejoApiError({
        operation: input.operation,
        detail: `unexpected ${input.method} ${input.path}`,
        status: 404,
      }),
    );
  });
}

const issue = (overrides: Record<string, unknown> = {}) => ({
  number: 12,
  title: "Cache is never invalidated",
  state: "open",
  comments: 3,
  created_at: "2026-06-16T05:04:32Z",
  updated_at: "2026-06-16T05:04:33Z",
  html_url: "https://git.example.org/acme/web/issues/12",
  user: { login: "bilal", full_name: "Bilal" },
  labels: [{ name: "bug", color: "#d73a4a" }],
  assignees: [{ login: "octocat" }],
  ...overrides,
});

layer("lists issues", (it) => {
  it.effect("asks only for issues, and keeps the host's own counts", () =>
    Effect.gen(function* () {
      routes({ "/repos/acme/web/issues": [issue()] });
      const provider = yield* ForgejoIssueProvider.make;
      const page = yield* provider.listIssues({
        ...target,
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 20,
      });
      assert.deepStrictEqual(
        page.items.map((item) => [item.number, item.state, item.commentCount]),
        [[12, "open", 3]],
      );
      // Forgejo writes a bare hex triplet, and the page puts its own `#` in front.
      assert.deepStrictEqual(page.items[0]?.labels, [{ name: "bug", color: "d73a4a" }]);
      const asked = request.mock.calls.at(-1)?.[0].path ?? "";
      assert.ok(asked.includes("type=issues"), asked);
    }),
  );

  it.effect("drops a change request a host hands back despite the type filter", () =>
    Effect.gen(function* () {
      // Forgejo lists issues and pull requests together on the same route; a row carrying
      // `pull_request` is a change request, and the panel is not a change request list.
      routes({
        "/repos/acme/web/issues": [issue(), issue({ number: 13, pull_request: { merged: false } })],
      });
      const provider = yield* ForgejoIssueProvider.make;
      const page = yield* provider.listIssues({
        ...target,
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 20,
      });
      assert.deepStrictEqual(
        page.items.map((item) => item.number),
        [12],
      );
    }),
  );

  it.effect("hands a search term and an involvement filter to Forgejo", () =>
    Effect.gen(function* () {
      routes({ "/repos/acme/web/issues": [] });
      const provider = yield* ForgejoIssueProvider.make;
      yield* provider.listIssues({
        ...target,
        state: "all",
        involvement: "assigned",
        viewer: "octocat",
        limit: 20,
        query: "cache",
      });
      const asked = request.mock.calls.at(-1)?.[0].path ?? "";
      assert.ok(asked.includes("q=cache"), asked);
      assert.ok(asked.includes("assigned_by=octocat"), asked);
    }),
  );
});

layer("reads one issue", (it) => {
  it.effect("carries the conversation and the write permission", () =>
    Effect.gen(function* () {
      routes({
        "/repos/acme/web/issues/12": issue({ body: "It never clears.", closed_at: null }),
        "/repos/acme/web/issues/12/comments": [
          {
            id: 51,
            body: "Confirmed",
            created_at: "2026-06-16T06:00:00Z",
            html_url: "https://git.example.org/acme/web/issues/12#issuecomment-51",
            user: { login: "octocat" },
          },
        ],
        "/repos/acme/web": { permissions: { push: true } },
      });
      const provider = yield* ForgejoIssueProvider.make;
      const detail = yield* provider.getIssue({ ...target, number: 12 });
      assert.strictEqual(detail.body, "It never clears.");
      assert.strictEqual(detail.comments.length, 1);
      assert.strictEqual(detail.comments[0]?.id, "issue-comment:51");
      assert.strictEqual(detail.viewerCanWrite, true);
      assert.strictEqual(detail.commentsTruncated, false);
    }),
  );

  it.effect("hides the composer from an account that cannot write", () =>
    Effect.gen(function* () {
      routes({
        "/repos/acme/web/issues/12": issue({ body: "" }),
        "/repos/acme/web/issues/12/comments": [],
        "/repos/acme/web": { permissions: { push: false, admin: false } },
      });
      const provider = yield* ForgejoIssueProvider.make;
      const detail = yield* provider.getIssue({ ...target, number: 12 });
      assert.strictEqual(detail.viewerCanWrite, false);
    }),
  );
});

layer("writes", (it) => {
  it.effect("posts a comment on the issue's own conversation", () =>
    Effect.gen(function* () {
      routes({ "/repos/acme/web/issues/12/comments": {} });
      const provider = yield* ForgejoIssueProvider.make;
      yield* provider.comment({ ...target, number: 12, body: "on it" });
      const call = request.mock.calls.at(-1)?.[0];
      assert.strictEqual(call?.method, "POST");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepStrictEqual(JSON.parse(call?.body ?? "{}"), { body: "on it" });
    }),
  );

  it.effect("opens an issue and reports where it landed", () =>
    Effect.gen(function* () {
      routes({
        "/repos/acme/web/issues": issue({
          number: 99,
          html_url: "https://git.example.org/acme/web/issues/99",
        }),
      });
      const provider = yield* ForgejoIssueProvider.make;
      const created = yield* provider.createIssue({
        ...target,
        title: "Something broke",
        body: "details",
      });
      assert.deepStrictEqual(created, {
        number: 99,
        url: "https://git.example.org/acme/web/issues/99",
      });
    }),
  );

  it.effect("closes and reopens through the issue's state", () =>
    Effect.gen(function* () {
      routes({ "/repos/acme/web/issues/12": {} });
      const provider = yield* ForgejoIssueProvider.make;
      yield* provider.setState({ ...target, number: 12, state: "closed" });
      const call = request.mock.calls.at(-1)?.[0];
      assert.strictEqual(call?.method, "PATCH");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepStrictEqual(JSON.parse(call?.body ?? "{}"), { state: "closed" });
    }),
  );

  it.effect("refuses a repository that is not owner/repository", () =>
    Effect.gen(function* () {
      routes({});
      const provider = yield* ForgejoIssueProvider.make;
      const error = yield* Effect.flip(
        provider.comment({ ...target, repository: "web", number: 1, body: "x" }),
      );
      assert.strictEqual(error.reason, "failed");
    }),
  );
});

layer("classifies failures", (it) => {
  it.effect("reads a refused token as the instance not being set up", () =>
    Effect.gen(function* () {
      request.mockImplementation((input) =>
        Effect.fail(
          new ForgejoApi.ForgejoApiError({
            operation: input.operation,
            detail: "Forgejo returned HTTP 403.",
            status: 403,
          }),
        ),
      );
      const provider = yield* ForgejoIssueProvider.make;
      const error = yield* Effect.flip(
        provider.listIssues({
          ...target,
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
        }),
      );
      // A token with too few scopes is refused this way, and the fix is the same as for a 401.
      assert.strictEqual(error.reason, "unauthenticated");
    }),
  );
});
