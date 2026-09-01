/**
 * Forgejo as the pull request service sees it: a capability declaration, and errors classified
 * so an instance that is not set up is reported as such rather than as a broken request.
 *
 * Gitea is served by the same provider; its API is the one this reads.
 */
import * as Effect from "effect/Effect";
import type { PullRequestCapabilities } from "@t3tools/contracts";

import * as ForgejoPullRequestApi from "./ForgejoPullRequestApi.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderApi,
  type PullRequestProviderFailure,
} from "./PullRequestProvider.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
  ],
  mergeMethods: ["merge", "squash", "rebase"],
  // Forgejo brings a stale branch up to date either way, as `style` on its update route.
  updateMethods: ["merge", "rebase"],
  search: true,
  reactions: true,
  review: {
    inlineComment: true,
    reply: true,
    // Forgejo records who resolved a line note but exposes no route that marks one resolved, so
    // the control is not offered rather than failing when pressed.
    resolve: false,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
};

/**
 * The failures that mean the instance is not usable, rather than one request having gone wrong.
 *
 * Forgejo is read over HTTP with a token from `fj`'s login store, so nothing here is a missing
 * tool at request time: unusable means the token is absent, refused, or has been rate limited.
 * A 403 counts as unauthenticated too, since a token with too few scopes is refused that way and
 * the fix is the same one — log in again with the access it needs.
 */
export function forgejoProviderFailure(
  error: ForgejoPullRequestApi.ForgejoPullRequestApiError,
): PullRequestProviderFailure {
  if (error.status === 401 || error.status === 403) return { reason: "unauthenticated" };
  if (error.status === 429) return { reason: "rate-limited" };
  return { reason: "failed" };
}

export const make = Effect.gen(function* () {
  const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

  const fail = (operation: string) => (error: ForgejoPullRequestApi.ForgejoPullRequestApiError) =>
    new PullRequestProviderError({
      provider: "forgejo",
      operation,
      ...forgejoProviderFailure(error),
      detail: error.detail,
      cause: error,
    });

  const provider: PullRequestProviderApi = {
    kind: "forgejo",
    capabilities: CAPABILITIES,

    // Every instance signs in its own account, so the viewer is asked of the host this checkout
    // belongs to rather than of the machine.
    getViewer: (input) =>
      api.getViewer({ cwd: input.cwd }).pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      api.listChangeRequests(input).pipe(Effect.mapError(fail("listChangeRequests"))),

    getChangeRequest: (input) =>
      api.getChangeRequest(input).pipe(Effect.mapError(fail("getChangeRequest"))),

    getChangeRequestActivity: (input) =>
      api.getViewer({ cwd: input.cwd, host: input.host }).pipe(
        Effect.orElseSucceed(() => null),
        Effect.flatMap((viewer) => api.getChangeRequestActivity({ ...input, viewer })),
        Effect.mapError(fail("getChangeRequestActivity")),
      ),

    getViewerPermissions: (input) =>
      api.getViewerPermissions(input).pipe(Effect.mapError(fail("getViewerPermissions"))),

    getDiff: (input) => api.getDiff(input).pipe(Effect.mapError(fail("getDiff"))),

    getDiffFileContents: (input) =>
      api.getDiffFileContents(input).pipe(Effect.mapError(fail("getDiffFileContents"))),

    runAction: (input) => api.runAction(input).pipe(Effect.mapError(fail("runAction"))),

    updateChangeRequest: (input) =>
      api.updateChangeRequest(input).pipe(Effect.mapError(fail("updateChangeRequest"))),

    comment: (input) => api.comment(input).pipe(Effect.mapError(fail("comment"))),

    updateComment: (input) => api.updateComment(input).pipe(Effect.mapError(fail("updateComment"))),

    submitReview: (input) => api.submitReview(input).pipe(Effect.mapError(fail("submitReview"))),

    replyToThread: (input) => api.replyToThread(input).pipe(Effect.mapError(fail("replyToThread"))),

    listReviewerCandidates: (input) =>
      api.listReviewerCandidates(input).pipe(Effect.mapError(fail("listReviewerCandidates"))),

    setReviewerRequest: (input) =>
      api.setReviewerRequest(input).pipe(Effect.mapError(fail("setReviewerRequest"))),

    setReaction: (input) => api.setReaction(input).pipe(Effect.mapError(fail("setReaction"))),

    // Never called: `capabilities.review.resolve` is false, and the service refuses without it.
    setThreadResolution: () =>
      Effect.fail(
        new PullRequestProviderError({
          provider: "forgejo",
          operation: "setThreadResolution",
          reason: "failed",
          detail: "Forgejo has no API that marks a review conversation resolved.",
        }),
      ),
  };

  return provider;
});
