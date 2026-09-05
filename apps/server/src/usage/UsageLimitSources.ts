/**
 * UsageLimitSources — quota from places this environment cannot run turns
 * on, today a CLIProxyAPI hub pooling several subscription accounts.
 *
 * Each configured `settings.usageLimitSources` entry is polled on the
 * provider health-check interval and on every settings change, then
 * published as one snapshot per source over `subscribeServerConfig`. A source
 * that fails keeps its row with `error` set so the user can see it is
 * configured but unreachable. Nothing is persisted: like provider status,
 * this is live state that re-derives on boot.
 *
 * @module usage/UsageLimitSources
 */
import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ProviderConsumeResetCreditOutcome,
  type ServerSettings,
  type UsageLimitSourceConfig,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceError,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpBody,
  HttpClient,
  type HttpClientError,
  HttpClientResponse,
} from "effect/unstable/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  aiUsageStatusToAccounts,
  decodeAiUsageDashboardStatus,
  decodeAiUsageResetResult,
} from "./aiUsageDashboard.ts";
import { cliproxyStatusToAccounts, decodeCliproxyQuotaStatus } from "./cliproxyUsageLimits.ts";

const FETCH_TIMEOUT = "10 seconds";
const QUOTA_STATUS_PATH = "/v0/management/quota-scheduler/status";
const AI_USAGE_STATUS_PATH = "/api/usage";
const AI_USAGE_RESET_PATH = "/api/codex/reset";
/** Redeeming spends something real; give the dashboard room to reach the vendor. */
const RESET_TIMEOUT = "30 seconds";

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    /** The current set followed by every change, with repeats dropped. */
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    /** Re-read every source now. Never fails; failures land on the snapshot. */
    readonly refresh: Effect.Effect<void>;
    /**
     * Spend one of a source account's banked reset credits. The source owns
     * the credential and its own double-spend guards, so this only forwards
     * the request and re-reads the source once it answers.
     */
    readonly consumeResetCredit: (input: {
      readonly sourceId: UsageLimitSourceId;
      readonly accountId: string;
    }) => Effect.Effect<ProviderConsumeResetCreditOutcome, UsageLimitSourceError>;
  }
>()("t3/usage/UsageLimitSources") {}

/**
 * A bounded, client-safe reason for a failed hub read. The exact failure
 * (which can carry the request URL and response body) goes to the log.
 */
function readFailureMessage(
  error: HttpClientError.HttpClientError | Schema.SchemaError | Cause.TimeoutError | InvalidUrl,
  noun: string,
): string {
  switch (error._tag) {
    case "InvalidUrl":
      return `The ${noun} URL is not valid.`;
    case "TimeoutError":
      return `The ${noun} did not answer in time.`;
    case "SchemaError":
      return `The ${noun} answered with an unexpected shape.`;
    case "HttpClientError":
      return error.reason._tag === "StatusCodeError"
        ? `The ${noun} refused the request (HTTP ${error.reason.response.status}).`
        : `The ${noun} could not be reached.`;
  }
}

/** What a source calls itself in a message the user reads. */
const SOURCE_NOUN: Record<UsageLimitSourceConfig["kind"], string> = {
  cliproxy: "hub",
  aiusage: "dashboard",
};

class InvalidUrl extends Data.TaggedError("InvalidUrl")<{
  readonly url: string;
  readonly cause: unknown;
}> {}

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  try {
    return new URL(config.url).host;
  } catch {
    return id;
  }
}

function sourceUrl(config: UsageLimitSourceConfig, path: string) {
  return Effect.try({
    try: () => new URL(path, config.url).toString(),
    catch: (cause) => new InvalidUrl({ url: config.url, cause }),
  });
}

const RESET_OUTCOMES: ReadonlyArray<ProviderConsumeResetCreditOutcome> = [
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
];

/**
 * The dashboard passes the vendor's own reply through, which is a bare
 * outcome string on Codex today but has been an object before. Anything we
 * cannot name reads as `reset`: the dashboard checked the balance, the vendor
 * answered 200, and the credit is gone either way.
 */
export function resetOutcomeOf(value: unknown): ProviderConsumeResetCreditOutcome {
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null && "outcome" in value
        ? (value as { outcome: unknown }).outcome
        : undefined;
  if (typeof raw !== "string") return "reset";
  const normalized = raw.replaceAll(/[_-]/g, "").toLowerCase();
  return RESET_OUTCOMES.find((outcome) => outcome.toLowerCase() === normalized) ?? "reset";
}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const settingsService = yield* ServerSettingsService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = { id, kind: config.kind, label: sourceLabel(id, config), checkedAt } as const;
    // A hub authenticates every read; a dashboard on this machine has no key
    // at all, so only the hub can be short-circuited on a missing one.
    if (config.kind === "cliproxy" && config.managementKey.length === 0) {
      return { ...base, accounts: [], error: "No management key configured." };
    }
    const accounts = yield* sourceUrl(
      config,
      config.kind === "cliproxy" ? QUOTA_STATUS_PATH : AI_USAGE_STATUS_PATH,
    ).pipe(
      Effect.flatMap((url) =>
        httpClient.get(
          url,
          config.kind === "cliproxy"
            ? { headers: { Authorization: `Bearer ${config.managementKey}` } }
            : {},
        ),
      ),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap((body) =>
        config.kind === "cliproxy"
          ? decodeCliproxyQuotaStatus(body).pipe(
              Effect.map((status) => cliproxyStatusToAccounts(status, checkedAt)),
            )
          : decodeAiUsageDashboardStatus(body).pipe(
              Effect.map((status) => aiUsageStatusToAccounts(status, checkedAt)),
            ),
      ),
      Effect.timeout(FETCH_TIMEOUT),
      Effect.result,
    );
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return {
        ...base,
        accounts: [],
        error: readFailureMessage(accounts.failure, SOURCE_NOUN[config.kind]),
      };
    }
    return { ...base, accounts: accounts.success };
  });

  const publish = (next: ReadonlyArray<UsageLimitSourceSnapshot>) =>
    Effect.gen(function* () {
      const changed = yield* Ref.modify(stateRef, (previous) =>
        Equal.equals(previous, next) ? [false, previous] : [true, next],
      );
      if (changed) yield* PubSub.publish(changes, next);
    });

  // One refresh at a time: a slow hub read started before a settings change
  // must not publish after the change's own refresh and resurrect a removed
  // source. Callers queue behind the in-flight run and see current settings.
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
      ([, config]) => config.enabled,
    );
    const snapshots = yield* Effect.forEach(
      entries,
      ([id, config]) => readSource(id as UsageLimitSourceId, config),
      { concurrency: 4 },
    );
    yield* publish(snapshots);
  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));

  // Settings edits re-read straight away so a new hub shows up without
  // waiting for the interval, and a removed one leaves the list.
  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.usageLimitSources),
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) =>
        Effect.sleep(Duration.toMillis(Duration.fromInputUnsafe(wait)) <= 0 ? "60 seconds" : wait),
      ),
      Effect.andThen(backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })),
      Effect.flatMap((shouldRun) => (shouldRun ? refresh : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* refresh.pipe(Effect.forkScoped);

  const consumeResetCredit: UsageLimitSources["Service"]["consumeResetCredit"] = ({
    sourceId,
    accountId,
  }) =>
    Effect.gen(function* () {
      const fail = (reason: string) => new UsageLimitSourceError({ sourceId, reason });
      const settings = yield* settingsService.getSettings.pipe(
        Effect.orElseSucceed((): ServerSettings | null => null),
      );
      const config = settings?.usageLimitSources[sourceId];
      if (!config || !config.enabled) {
        return yield* fail("That usage source is not configured on this environment.");
      }
      if (config.kind !== "aiusage") {
        return yield* fail("This usage source cannot redeem reset credits.");
      }
      const outcome = yield* sourceUrl(config, AI_USAGE_RESET_PATH).pipe(
        Effect.flatMap((url) =>
          httpClient.post(url, { body: HttpBody.jsonUnsafe({ account_id: accountId }) }),
        ),
        // The dashboard answers 4xx with a reason written for the user (its
        // own cooldown, no credits left), so read the body before failing.
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.flatMap(decodeAiUsageResetResult),
            Effect.flatMap((result) =>
              response.status >= 200 && response.status < 300
                ? Effect.succeed(resetOutcomeOf(result.outcome))
                : Effect.fail(
                    fail(
                      result.error ??
                        `The dashboard refused the request (HTTP ${response.status}).`,
                    ),
                  ),
            ),
          ),
        ),
        Effect.timeout(RESET_TIMEOUT),
        Effect.catchTags({
          SchemaError: () => Effect.fail(fail("The dashboard answered with an unexpected shape.")),
          TimeoutError: () => Effect.fail(fail("The dashboard did not answer in time.")),
          HttpClientError: () => Effect.fail(fail("The dashboard could not be reached.")),
          InvalidUrl: () => Effect.fail(fail("The dashboard URL is not valid.")),
        }),
      );
      // The windows the dashboard reports are now stale by definition.
      yield* refresh;
      return outcome;
    });

  return {
    current: Ref.get(stateRef),
    refresh,
    consumeResetCredit,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies UsageLimitSources["Service"];
});

export const layer = Layer.effect(UsageLimitSources, make);
