import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ForgejoApi from "../sourceControl/ForgejoApi.ts";
import * as ForgejoPullRequestApi from "./ForgejoPullRequestApi.ts";

const mockedRequest = vi.fn<ForgejoApi.ForgejoApi["Service"]["request"]>();
const mockedResolveLocator = vi.fn<ForgejoApi.ForgejoApi["Service"]["resolveLocator"]>(() =>
  Effect.succeed({ host: "git.example.org", owner: "acme", repo: "web", scheme: "https" as const }),
);

const layer = it.layer(
  ForgejoPullRequestApi.layer.pipe(
    Layer.provide(
      Layer.mock(ForgejoApi.ForgejoApi)({
        request: mockedRequest,
        resolveLocator: mockedResolveLocator,
      }),
    ),
  ),
);

const target = { cwd: "/repo", host: "git.example.org", repository: "acme/web" };

function ok(body: unknown) {
  return Effect.succeed({ status: 200, body: JSON.stringify(body), truncated: false });
}

/** The JSON body the last request carried, for asserting what was sent. */
function sentBody(): Record<string, unknown> {
  const raw = mockedRequest.mock.calls.at(-1)?.[0].body ?? "{}";
  return JSON.parse(raw) as Record<string, unknown>;
}

/** One pull request as Forgejo's `/pulls` answers with it. */
function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: "Add the thing",
    state: "open",
    created_at: "2026-06-16T05:04:32Z",
    updated_at: "2026-06-16T05:04:33Z",
    user: { login: "bilal", full_name: "Bilal", avatar_url: "https://git.example.org/a.png" },
    head: { ref: "feat/thing", sha: "headsha", repo: { full_name: "acme/web" } },
    base: { ref: "main", sha: "basesha", repo: { full_name: "acme/web" } },
    html_url: "https://git.example.org/acme/web/pulls/7",
    ...overrides,
  };
}

/** Answers each path with the body a test set for it, and fails anything unasked for. */
function routes(table: Record<string, unknown>) {
  mockedRequest.mockImplementation((input) => {
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

layer("lists open change requests and reports whether more remain", (it) => {
  it.effect("keeps the page and says it is not full", () =>
    Effect.gen(function* () {
      routes({ "/repos/acme/web/pulls": [pullRequest(), pullRequest({ number: 8 })] });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      const page = yield* api.listChangeRequests({
        ...target,
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 25,
      });
      assert.deepStrictEqual(
        page.items.map((item) => item.number),
        [7, 8],
      );
      assert.strictEqual(page.truncated, false);
      assert.strictEqual(page.continues, true);
      assert.strictEqual(page.items[0]?.author?.login, "bilal");
    }),
  );

  it.effect("asks Forgejo for closed rows and keeps only the merged half", () =>
    Effect.gen(function* () {
      routes({
        "/repos/acme/web/pulls": [
          pullRequest({ number: 1, state: "closed", merged: true }),
          pullRequest({ number: 2, state: "closed", merged: false }),
        ],
      });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      const page = yield* api.listChangeRequests({
        ...target,
        state: "merged",
        involvement: "all",
        viewer: "bilal",
        limit: 25,
      });
      assert.deepStrictEqual(
        page.items.map((item) => item.number),
        [1],
      );
      assert.strictEqual(page.items[0]?.state, "merged");
      // The row that was dropped still came out of the host's page, so the cursor counts it.
      assert.strictEqual(page.cursorAdvance, 2);
      const asked = mockedRequest.mock.calls.at(-1)?.[0].path ?? "";
      assert.ok(asked.includes("state=closed"), asked);
    }),
  );

  it.effect("narrows an authored listing with Forgejo's own poster filter", () =>
    Effect.gen(function* () {
      routes({ "/repos/acme/web/pulls": [] });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      yield* api.listChangeRequests({
        ...target,
        state: "open",
        involvement: "authored",
        viewer: "bilal",
        limit: 25,
      });
      const asked = mockedRequest.mock.calls.at(-1)?.[0].path ?? "";
      assert.ok(asked.includes("poster=bilal"), asked);
    }),
  );

  it.effect("narrows a page by description as well as title", () =>
    Effect.gen(function* () {
      routes({
        "/repos/acme/web/pulls": [
          pullRequest({ number: 5, title: "Tidy up", body: "fixes the cache invalidation" }),
          pullRequest({ number: 6, title: "Tidy up more", body: "unrelated" }),
        ],
      });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      const page = yield* api.listChangeRequests({
        ...target,
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 25,
        query: "cache",
      });
      assert.deepStrictEqual(
        page.items.map((item) => item.number),
        [5],
      );
    }),
  );

  it.effect("keeps only rows the viewer was asked to review", () =>
    Effect.gen(function* () {
      routes({
        "/repos/acme/web/pulls": [
          pullRequest({ number: 3, requested_reviewers: [{ login: "octocat" }] }),
          pullRequest({ number: 4, requested_reviewers: [{ login: "hubot" }] }),
        ],
      });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      const page = yield* api.listChangeRequests({
        ...target,
        state: "open",
        involvement: "reviewing",
        viewer: "octocat",
        limit: 25,
      });
      assert.deepStrictEqual(
        page.items.map((item) => item.number),
        [3],
      );
    }),
  );
});

layer("reads one change request", (it) => {
  it.effect("carries the repository's merge strategies and the account's permission", () =>
    Effect.gen(function* () {
      routes({
        "/repos/acme/web/pulls/7": pullRequest({
          mergeable: true,
          changed_files: 3,
          additions: 12,
          deletions: 4,
        }),
        "/repos/acme/web": {
          allow_merge_commits: true,
          allow_squash_merge: false,
          allow_rebase: true,
          permissions: { push: true },
        },
        "/repos/acme/web/commits/headsha/statuses": [
          { context: "build", status: "success", updated_at: "2026-06-16T05:05:00Z" },
        ],
      });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      const detail = yield* api.getChangeRequest({ ...target, number: 7 });
      assert.strictEqual(detail.mergeability, "mergeable");
      assert.strictEqual(detail.changedFiles, 3);
      assert.deepStrictEqual(detail.mergeCapabilities, {
        merge: true,
        squash: false,
        rebase: true,
      });
      assert.deepStrictEqual(
        detail.checks.map((check) => [check.name, check.status]),
        [["build", "success"]],
      );
      assert.strictEqual(detail.checksState, "passing");
      assert.ok(detail.viewerPermissions.actions.includes("merge"));
    }),
  );

  it.effect("offers no action to an account that cannot write", () =>
    Effect.gen(function* () {
      routes({
        "/repos/acme/web/pulls/7": pullRequest(),
        "/repos/acme/web": { permissions: { push: false, admin: false, pull: true } },
        "/repos/acme/web/commits/headsha/statuses": [],
      });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      const detail = yield* api.getChangeRequest({ ...target, number: 7 });
      assert.deepStrictEqual(detail.viewerPermissions.actions, []);
      // Reading the repository is enough to say something about it.
      assert.strictEqual(detail.viewerPermissions.comment, true);
      assert.strictEqual(detail.viewerPermissions.resolve, false);
    }),
  );
});

layer("reads the conversation", (it) => {
  it.effect("groups line notes on the same line into one conversation", () =>
    Effect.gen(function* () {
      routes({
        "/repos/acme/web/issues/7/comments": [
          {
            id: 11,
            body: "looks good",
            created_at: "2026-06-16T06:00:00Z",
            user: { login: "octocat" },
          },
        ],
        "/repos/acme/web/pulls/7/reviews": [
          {
            id: 21,
            state: "APPROVED",
            body: "ship it",
            submitted_at: "2026-06-16T07:00:00Z",
            user: { login: "hubot" },
          },
        ],
        "/repos/acme/web/pulls/7/reviews/21/comments": [
          {
            id: 31,
            body: "rename this",
            path: "src/app.ts",
            position: 12,
            created_at: "2026-06-16T07:00:01Z",
            user: { login: "hubot" },
          },
          {
            id: 32,
            body: "agreed",
            path: "src/app.ts",
            position: 12,
            created_at: "2026-06-16T07:05:00Z",
            user: { login: "octocat" },
          },
          {
            id: 33,
            body: "and this",
            path: "src/app.ts",
            position: 40,
            created_at: "2026-06-16T07:06:00Z",
            user: { login: "hubot" },
          },
        ],
        "/repos/acme/web/pulls/7/commits": [
          {
            sha: "abc123",
            commit: {
              message: "Add the thing\n\nbody",
              committer: { date: "2026-06-16T05:00:00Z" },
            },
          },
        ],
        "/repos/acme/web/issues/7/reactions": [{ content: "+1", user: { login: "octocat" } }],
        "/repos/acme/web/issues/comments/11/reactions": [],
      });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      const activity = yield* api.getChangeRequestActivity({
        ...target,
        number: 7,
        viewer: "octocat",
      });

      assert.deepStrictEqual(
        activity.comments.map((comment) => comment.kind),
        ["issue-comment", "review"],
      );
      assert.strictEqual(activity.reviewThreads.length, 2);
      assert.deepStrictEqual(
        activity.reviewThreads.map((thread) => thread.comments.length),
        [2, 1],
      );
      // The id addresses a line, which is what a reply is placed back on.
      assert.strictEqual(activity.reviewThreads[0]?.id, "12:src/app.ts");
      assert.deepStrictEqual(
        activity.commits.map((commit) => commit.messageHeadline),
        ["Add the thing"],
      );
      assert.deepStrictEqual(activity.reactions, [
        { content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true },
      ]);
    }),
  );

  it.effect("leaves out the empty review Forgejo writes to carry line notes", () =>
    Effect.gen(function* () {
      routes({
        "/repos/acme/web/issues/7/comments": [],
        "/repos/acme/web/pulls/7/reviews": [
          { id: 21, state: "COMMENT", body: "", submitted_at: "2026-06-16T07:00:00Z" },
        ],
        "/repos/acme/web/pulls/7/reviews/21/comments": [],
        "/repos/acme/web/pulls/7/commits": [],
        "/repos/acme/web/issues/7/reactions": [],
      });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      const activity = yield* api.getChangeRequestActivity({
        ...target,
        number: 7,
        viewer: null,
      });
      assert.deepStrictEqual(activity.comments, []);
    }),
  );
});

layer("acts on a change request", (it) => {
  it.effect("merges with the strategy that was asked for", () =>
    Effect.gen(function* () {
      routes({ "/repos/acme/web/pulls/7/merge": {} });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      yield* api.runAction({ ...target, number: 7, action: "merge", mergeMethod: "squash" });
      const call = mockedRequest.mock.calls.at(-1)?.[0];
      assert.strictEqual(call?.method, "POST");
      assert.deepStrictEqual(sentBody(), { Do: "squash" });
    }),
  );

  it.effect("hands the merge to Forgejo when auto-merge is armed", () =>
    Effect.gen(function* () {
      routes({ "/repos/acme/web/pulls/7/merge": {} });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      yield* api.runAction({ ...target, number: 7, action: "enable-auto-merge" });
      const body = sentBody();
      assert.strictEqual(body.merge_when_checks_succeed, true);
    }),
  );

  it.effect("takes a standing merge instruction back", () =>
    Effect.gen(function* () {
      routes({ "/repos/acme/web/pulls/7/merge": {} });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      yield* api.runAction({ ...target, number: 7, action: "disable-auto-merge" });
      assert.strictEqual(mockedRequest.mock.calls.at(-1)?.[0].method, "DELETE");
    }),
  );

  it.effect("moves a change request in and out of draft through its title", () =>
    Effect.gen(function* () {
      routes({ "/repos/acme/web/pulls/7": pullRequest({ title: "WIP: Add the thing" }) });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      yield* api.runAction({ ...target, number: 7, action: "ready" });
      assert.deepStrictEqual(sentBody(), {
        title: "Add the thing",
      });

      yield* api.runAction({ ...target, number: 7, action: "draft" });
      assert.deepStrictEqual(sentBody(), {
        title: "WIP: Add the thing",
      });
    }),
  );

  it.effect("replies on the line the conversation belongs to", () =>
    Effect.gen(function* () {
      routes({ "/repos/acme/web/pulls/7/reviews": {} });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      yield* api.replyToThread({
        ...target,
        number: 7,
        threadId: "12:src/app.ts",
        body: "done",
      });
      const body = sentBody();
      assert.deepStrictEqual(body.comments, [
        { path: "src/app.ts", body: "done", new_position: 12 },
      ]);
    }),
  );

  it.effect("refuses a reply to a conversation it cannot place", () =>
    Effect.gen(function* () {
      routes({});
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      const exit = yield* Effect.exit(
        api.replyToThread({ ...target, number: 7, threadId: "nonsense", body: "x" }),
      );
      assert.strictEqual(exit._tag, "Failure");
    }),
  );

  it.effect("sends a review verdict with its line notes", () =>
    Effect.gen(function* () {
      routes({ "/repos/acme/web/pulls/7/reviews": {} });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      yield* api.submitReview({
        ...target,
        number: 7,
        verdict: "request-changes",
        body: "not yet",
        comments: [
          { path: "src/app.ts", position: { kind: "added", newLine: 4 }, body: "here" },
          { path: "src/old.ts", position: { kind: "deleted", oldLine: 9 }, body: "and here" },
        ],
      });
      const body = sentBody();
      assert.strictEqual(body.event, "REQUEST_CHANGES");
      assert.deepStrictEqual(body.comments, [
        { path: "src/app.ts", body: "here", new_position: 4 },
        { path: "src/old.ts", body: "and here", old_position: 9 },
      ]);
    }),
  );

  it.effect("leaves the author out of the reviewers it offers", () =>
    Effect.gen(function* () {
      routes({
        "/repos/acme/web/reviewers": [{ login: "bilal" }, { login: "octocat" }, { login: "hubot" }],
        "/repos/acme/web/pulls/7": pullRequest({
          requested_reviewers: [{ login: "hubot" }],
        }),
      });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      const list = yield* api.listReviewerCandidates({ ...target, number: 7 });
      assert.deepStrictEqual(
        list.candidates.map((candidate) => [candidate.login, candidate.isRequested]),
        [
          ["octocat", false],
          ["hubot", true],
        ],
      );
    }),
  );

  it.effect("takes a reaction back with a delete", () =>
    Effect.gen(function* () {
      routes({ "/repos/acme/web/issues/comments/11/reactions": {} });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      yield* api.setReaction({
        ...target,
        number: 7,
        subjectId: "issue-comment:11",
        content: "thumbs-up",
        reacted: false,
      });
      const call = mockedRequest.mock.calls.at(-1)?.[0];
      assert.strictEqual(call?.method, "DELETE");
      assert.deepStrictEqual(sentBody(), { content: "+1" });
    }),
  );
});

layer("does not use Forgejo's cross-repository search", (it) => {
  it.effect("reads each repository instead, because the search omits the branches", () =>
    Effect.gen(function* () {
      // `/repos/issues/search` answers with issues: no head, no base. A change request without
      // its branches fails the contract, so the per-repository read is the only one used.
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      assert.strictEqual(
        "listChangeRequestsAcross" in api,
        false,
        "a host-wide listing would be answered with rows that cannot be shown",
      );
    }),
  );
});

layer("reads a patch", (it) => {
  it.effect("asks for the diff as text and reports it whole", () =>
    Effect.gen(function* () {
      mockedRequest.mockImplementation(() =>
        Effect.succeed({ status: 200, body: "diff --git a b", truncated: false }),
      );
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
      const slice = yield* api.getDiff({ ...target, number: 7 });
      assert.strictEqual(slice.patch, "diff --git a b");
      assert.strictEqual(slice.nextCursor, null);
      const call = mockedRequest.mock.calls.at(-1)?.[0];
      assert.strictEqual(call?.path, "/repos/acme/web/pulls/7.diff");
      assert.strictEqual(call?.accept, "text/plain");
    }),
  );
});

it.effect("refuses a repository that is not owner/repository", () =>
  Effect.gen(function* () {
    const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;
    const exit = yield* Effect.exit(
      api.getChangeRequest({ ...target, repository: "web", number: 7 }),
    );
    assert.strictEqual(exit._tag, "Failure");
  }).pipe(
    Effect.provide(
      ForgejoPullRequestApi.layer.pipe(
        Layer.provide(
          Layer.mock(ForgejoApi.ForgejoApi)({
            request: mockedRequest,
            resolveLocator: mockedResolveLocator,
          }),
        ),
      ),
    ),
  ),
);

it("round-trips a conversation id", () => {
  const encoded = ForgejoPullRequestApi.encodeThreadId({ path: "src/a:b.ts", position: 12 });
  assert.deepStrictEqual(ForgejoPullRequestApi.decodeThreadId(encoded), {
    path: "src/a:b.ts",
    position: 12,
  });
  // A note that has drifted off the diff carries no line to reply against.
  const fileLevel = ForgejoPullRequestApi.encodeThreadId({ path: "src/a.ts", position: null });
  assert.deepStrictEqual(ForgejoPullRequestApi.decodeThreadId(fileLevel), {
    path: "src/a.ts",
    position: null,
  });
  assert.strictEqual(ForgejoPullRequestApi.decodeThreadId("nope"), null);
});
