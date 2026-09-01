import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ForgejoPullRequestApi from "./ForgejoPullRequestApi.ts";
import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";

const layer = it.layer(
  Layer.mock(ForgejoPullRequestApi.ForgejoPullRequestApi)({
    getViewer: () => Effect.succeed("bilal"),
  }),
);

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
