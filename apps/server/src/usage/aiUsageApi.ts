/**
 * aiUsageApi — the `aiusage` source kind: a local AI usage dashboard that
 * polls each vendor's own limits endpoint. It exposes the same
 * `readAccounts` / `consume` pair as {@link ./cliproxyApi.ts}, so
 * UsageLimitSources only has to pick an adapter by `config.kind`.
 *
 * A dashboard runs on this machine and authenticates nothing, so there is no
 * management key and no per-account credential handling here.
 *
 * @module usage/aiUsageApi
 */
import {
  UsageLimitSourceError,
  type ProviderConsumeResetCreditResult,
  type UsageLimitSourceAccount,
  type UsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  aiUsageStatusToAccounts,
  decodeAiUsageDashboardStatus,
  decodeAiUsageResetResult,
} from "./aiUsageDashboard.ts";

const STATUS_PATH = "/api/usage";
const RESET_PATH = "/api/codex/reset";
const FETCH_TIMEOUT = "10 seconds";
/** Redeeming spends something real; give the dashboard room to reach the vendor. */
const RESET_TIMEOUT = "30 seconds";

const isUsageLimitSourceError = Schema.is(UsageLimitSourceError);

const dashboardUrl = (config: UsageLimitSourceConfig, path: string) =>
  Effect.try({
    try: () => new URL(path, config.url).toString(),
    catch: () => new UsageLimitSourceError({ detail: "The dashboard URL is not valid." }),
  });

const failureDetail = (error: { readonly _tag: string }): string => {
  switch (error._tag) {
    case "SchemaError":
      return "The dashboard answered with an unexpected shape.";
    case "TimeoutError":
      return "The dashboard did not answer in time.";
    default:
      return "The dashboard could not be reached.";
  }
};

/** @public Service construction is part of the canonical Effect module API. */
export const makeAiUsageApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const readAccounts = Effect.fn("AiUsageApi.readAccounts")(function* (
    config: UsageLimitSourceConfig,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const url = yield* dashboardUrl(config, STATUS_PATH);
    return yield* client.get(url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeAiUsageDashboardStatus),
      Effect.map((status) => aiUsageStatusToAccounts(status, checkedAt)),
      Effect.timeout(FETCH_TIMEOUT),
      Effect.mapError((error) => new UsageLimitSourceError({ detail: failureDetail(error) })),
    );
  });

  const consume = Effect.fn("AiUsageApi.consume")(function* (
    config: UsageLimitSourceConfig,
    accountId: string,
    /** The dashboard banks no per-credit ids; it resets the account's window. */
    _creditId: string,
  ): Effect.fn.Return<ProviderConsumeResetCreditResult, UsageLimitSourceError> {
    const url = yield* dashboardUrl(config, RESET_PATH);
    return yield* client
      .post(url, { body: HttpBody.jsonUnsafe({ account_id: accountId }) })
      .pipe(
        // The dashboard answers 4xx with a reason written for the user (its
        // own cooldown, no credits left), so read the body before failing.
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.flatMap(decodeAiUsageResetResult),
            Effect.flatMap((result) =>
              response.status >= 200 && response.status < 300
                ? Effect.succeed({ outcome: result.outcome } as ProviderConsumeResetCreditResult)
                : Effect.fail(
                    new UsageLimitSourceError({
                      detail:
                        result.error ??
                        `The dashboard refused the request (HTTP ${response.status}).`,
                    }),
                  ),
            ),
          ),
        ),
        Effect.timeout(RESET_TIMEOUT),
        Effect.mapError((error) =>
          isUsageLimitSourceError(error)
            ? error
            : new UsageLimitSourceError({ detail: failureDetail(error) }),
        ),
      );
  });

  return { readAccounts, consume };
});
