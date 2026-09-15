import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ForgejoApiInput } from "../sourceControl/ForgejoCli.ts";

import { ForgejoCli } from "../sourceControl/ForgejoCli.ts";
import * as ForgejoPullRequestApi from "./ForgejoPullRequestApi.ts";
import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";

const layer = it.layer(Layer.mock(ForgejoCli)({}));

function apiError(status?: number) {
  return new ForgejoPullRequestApi.ForgejoPullRequestApiError({
    operation: "listChangeRequests",
    detail: "Forgejo said no.",
    ...(status === undefined ? {} : { status }),
  });
}

it("treats a refused token as the instance not being set up", () => {
  // A token with too few scopes is refused with 403, and the fix is the same as for 401: sign
  // in again with the access this needs. Both therefore report as unauthenticated rather than
  // as one request having gone wrong.
  assert.deepStrictEqual(ForgejoPullRequestProvider.forgejoProviderFailure(apiError(401)), {
    reason: "unauthenticated",
  });
  assert.deepStrictEqual(ForgejoPullRequestProvider.forgejoProviderFailure(apiError(403)), {
    reason: "unauthenticated",
  });
  assert.deepStrictEqual(ForgejoPullRequestProvider.forgejoProviderFailure(apiError(429)), {
    reason: "rate-limited",
  });
  assert.deepStrictEqual(ForgejoPullRequestProvider.forgejoProviderFailure(apiError(404)), {
    reason: "failed",
  });
  assert.deepStrictEqual(ForgejoPullRequestProvider.forgejoProviderFailure(apiError()), {
    reason: "failed",
  });
});

it.effect(
  "keeps draft conversion, automatic merge and line replies on the shared fj/tea transport",
  () => {
    const requests: ForgejoApiInput[] = [];
    return Effect.gen(function* () {
      const provider = yield* ForgejoPullRequestProvider.make;
      const target = { cwd: "/repo", host: "forgejo.test", repository: "acme/web", number: 7 };
      yield* provider.runAction({ ...target, action: "ready" });
      yield* provider.runAction({ ...target, action: "enable-auto-merge", mergeMethod: "squash" });
      yield* provider.runAction({ ...target, action: "disable-auto-merge" });
      yield* provider.replyToThread({ ...target, threadId: "12:src/app.ts", body: "Follow-up" });
      const writes = requests.filter((request) => request.method !== "GET");
      assert.deepStrictEqual(
        writes.map(({ method, path, body }) => ({ method, path, body })),
        [
          {
            method: "PATCH",
            path: "repos/acme/web/pulls/7",
            body: { title: "Keep review features" },
          },
          {
            method: "POST",
            path: "repos/acme/web/pulls/7/merge",
            body: { Do: "squash", merge_when_checks_succeed: true },
          },
          { method: "DELETE", path: "repos/acme/web/pulls/7/merge", body: undefined },
          {
            method: "POST",
            path: "repos/acme/web/pulls/7/reviews",
            body: {
              event: "COMMENT",
              body: "",
              comments: [{ path: "src/app.ts", body: "Follow-up", new_position: 12 }],
            },
          },
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mock(ForgejoCli)({
          api: (input) => {
            requests.push(input);
            return Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: JSON.stringify({ number: 7, title: "WIP: Keep review features" }),
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          },
        }),
      ),
    );
  },
);

it.effect(
  "searches pull request descriptions without repeating filtered rows on the next page",
  () => {
    const rows = [1, 2, 3].map((number) => ({
      number,
      title: "Change",
      body: number === 2 ? "Repair reconnect" : "Unrelated",
      state: "open",
      merged: false,
      html_url: `https://forgejo.test/acme/web/pulls/${number}`,
      user: { login: "chris" },
      head: { ref: "feature", sha: "head", repo: null },
      base: { ref: "main", sha: "base", repo: null },
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
      closed_at: null,
      merged_at: null,
      labels: [],
    }));
    return Effect.gen(function* () {
      const provider = yield* ForgejoPullRequestProvider.make;
      const target = {
        cwd: "/repo",
        host: "forgejo.test",
        repository: "acme/web",
        state: "open" as const,
        involvement: "all" as const,
        viewer: "chris",
        query: "reconnect",
        limit: 2,
      };
      const first = yield* provider.listChangeRequests(target);
      assert.deepStrictEqual(
        first.items.map((row) => row.number),
        [2],
      );
      assert.strictEqual(first.cursorAdvance, 2);
      const second = yield* provider.listChangeRequests({
        ...target,
        cursor: { delivered: 2, updatedBefore: "2026-09-01T00:00:00Z" },
      });
      assert.deepStrictEqual(second.items, []);
      assert.strictEqual(second.cursorAdvance, 1);
      assert.strictEqual(second.truncated, false);
    }).pipe(
      Effect.provide(
        Layer.mock(ForgejoCli)({
          api: () =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: JSON.stringify(rows),
              stderr: 'link: <https://forgejo.test/>; rel="last"',
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
    );
  },
);

layer("declares what Forgejo can do", (it) => {
  it.effect("offers no conversation resolution, because Forgejo exposes no route for it", () =>
    Effect.gen(function* () {
      const provider = yield* ForgejoPullRequestProvider.make;
      assert.strictEqual(provider.kind, "forgejo");
      assert.strictEqual(provider.capabilities.review.resolve, false);
      // Everything else on a review is there.
      assert.strictEqual(provider.capabilities.review.inlineComment, true);
      assert.strictEqual(provider.capabilities.review.reply, true);
      assert.deepStrictEqual(provider.capabilities.review.verdicts, [
        "comment",
        "approve",
        "request-changes",
      ]);
    }),
  );

  it.effect("offers both ways of bringing a stale branch up to date", () =>
    Effect.gen(function* () {
      const provider = yield* ForgejoPullRequestProvider.make;
      assert.deepStrictEqual(provider.capabilities.updateMethods, ["merge", "rebase"]);
      assert.deepStrictEqual(provider.capabilities.mergeMethods, ["merge", "squash", "rebase"]);
      assert.ok(provider.capabilities.actions.includes("enable-auto-merge"));
      assert.strictEqual(provider.capabilities.reactions, true);
    }),
  );

  it.effect("refuses to resolve a conversation if it is ever asked to", () =>
    Effect.gen(function* () {
      const provider = yield* ForgejoPullRequestProvider.make;
      const exit = yield* Effect.exit(
        provider.setThreadResolution({
          cwd: "/repo",
          host: "git.example.org",
          repository: "acme/web",
          number: 7,
          threadId: "12:src/app.ts",
          resolved: true,
        }),
      );
      assert.strictEqual(exit._tag, "Failure");
    }),
  );
});
