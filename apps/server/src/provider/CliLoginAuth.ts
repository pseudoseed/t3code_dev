/**
 * CliLoginAuth — a `ProviderAuthController` that drives a provider's own
 * sign-in command.
 *
 * T3 Code never implements a provider's OAuth. It runs the command the vendor
 * ships (`claude auth login`, `codex login --device-auth`), reads the
 * authorization URL out of that command's output, and relays the user's
 * response back to it. The vendor CLI performs the token exchange, writes the
 * credentials in its own format, and refreshes them on use — so there is no
 * T3-held access token to expire, and reauthentication is just this flow run
 * again against the same instance.
 *
 * Every instance points its CLI at its own credential directory, so signing a
 * second subscription in cannot disturb the first. The controller enforces the
 * same thing at runtime by refusing to start while another flow is in progress
 * on this instance.
 *
 * @module provider/CliLoginAuth
 */
import {
  ProviderSetupError,
  type ProviderAuthCompletion,
  type ProviderAuthState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  forwardLoopbackCallback,
  parsePendingLoopbackCallback,
  validateLoopbackCallbackUrl,
  type PendingLoopbackCallback,
} from "./cliLoginCallback.ts";
import { findAuthorizationUrl, findDeviceUserCode, summarizeCliFailure } from "./cliLoginOutput.ts";
import type { ProviderAuthController } from "./Services/ProviderAuthService.ts";

/**
 * Device codes expire in 15 minutes at both providers, and the browser leg can
 * legitimately take a while (password managers, SSO, MFA). The flow is bounded
 * so an abandoned sign-in releases the instance instead of pinning it.
 */
const FLOW_TIMEOUT = Duration.minutes(15);
const LOGOUT_TIMEOUT = Duration.seconds(60);
/** Enough to hold the sign-in banner for a failure summary, not a transcript. */
const OUTPUT_BUFFER_LIMIT = 8_000;

const isSetupError = Schema.is(ProviderSetupError);

export interface CliInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string | undefined;
}

export interface CliInvocationResult {
  /** `null` when the command could not be spawned at all. */
  readonly exitCode: number | null;
  /** Bounded tail of interleaved stdout and stderr. */
  readonly output: string;
}

/**
 * Run one CLI invocation to completion, collecting a bounded tail of its
 * output. `onLine` sees each line as it arrives, which is how the sign-in flow
 * publishes an authorization URL before the process exits.
 *
 * A spawn failure returns `exitCode: null` rather than failing the effect:
 * every caller here treats "could not run the binary" as one more unsuccessful
 * outcome to report, not as a defect.
 */
export const runCliInvocation = Effect.fn("runCliInvocation")(function* (
  invocation: CliInvocation,
  options: {
    readonly input?: Queue.Queue<string, Cause.Done> | undefined;
    readonly onLine?: ((line: string) => Effect.Effect<void>) | undefined;
  } = {},
): Effect.fn.Return<
  CliInvocationResult,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(invocation.command, [...invocation.args], {
    env: invocation.env,
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
    ...(options.input === undefined
      ? {}
      : { stdin: { stream: Stream.fromQueue(options.input).pipe(Stream.encodeText) } }),
  });
  const spawned = yield* spawner.spawn(command).pipe(Effect.option);
  if (Option.isNone(spawned)) {
    return { exitCode: null, output: "" };
  }
  const child = spawned.value;
  let tail = "";
  const collect = child.all.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.suspend(() => {
        tail = `${tail}${line}\n`.slice(-OUTPUT_BUFFER_LIMIT);
        return options.onLine?.(line) ?? Effect.void;
      }),
    ),
    // Output handling must never decide the outcome; the exit code does. A
    // stream fault here would otherwise mask a successful sign-in.
    Effect.ignore,
  );
  const [, exitCode] = yield* Effect.all(
    [collect, child.exitCode.pipe(Effect.orElseSucceed(() => null))],
    {
      concurrency: "unbounded",
    },
  );
  return { exitCode, output: tail };
});

export interface CliLoginAuthOptions {
  readonly instanceId: ProviderInstanceId;
  /** Provider name as it appears in user-facing copy, e.g. "Claude". */
  readonly providerLabel: string;
  /** What the user signs in to, e.g. "your Anthropic account". */
  readonly accountLabel: string;
  /**
   * How the client finishes the flow once the authorization page is open.
   *
   * `redirectUrl` flows read the loopback target out of the authorization URL,
   * so the CLI decides at runtime; the value here is only the default the flow
   * starts with.
   */
  readonly completion: ProviderAuthCompletion;
  /** Hosts whose URLs may be presented to the user as the sign-in page. */
  readonly authorizationUrlHosts: ReadonlyArray<string>;
  readonly login: CliInvocation;
  readonly logout: CliInvocation;
  /**
   * Whether this instance's credential directory holds a usable sign-in right
   * now. Read from the CLI rather than inferred from its exit code, so a
   * command that exits 0 without storing credentials is still treated as a
   * failed sign-in.
   */
  readonly verifySignedIn: Effect.Effect<boolean>;
  /** Re-probe the instance so the snapshot reflects the new account. */
  readonly onAuthenticated: Effect.Effect<void>;
  readonly onSignedOut: Effect.Effect<void>;
}

interface AuthSnapshot {
  readonly ownerSessionId: string | null;
  readonly state: ProviderAuthState;
}

interface AuthFlow {
  readonly id: string;
  readonly ownerSessionId: string;
  readonly expiresAtMillis: number;
  state: ProviderAuthState;
  /** Written to the CLI's stdin when the user supplies a code. */
  readonly input: Queue.Queue<string, Cause.Done>;
  /** Set once a loopback authorization URL is seen, for `redirectUrl` flows. */
  pendingCallback: PendingLoopbackCallback | undefined;
  responseSent: boolean;
  fiber: Fiber.Fiber<void> | undefined;
}

/**
 * Hide an in-flight sign-in's URL and code from clients that did not start it.
 * They still see that the instance is busy, which is what stops a second
 * client from starting a competing flow.
 */
function visibleSnapshot(snapshot: AuthSnapshot, ownerSessionId: string): ProviderAuthState {
  if (snapshot.ownerSessionId === null || snapshot.ownerSessionId === ownerSessionId) {
    return snapshot.state;
  }
  const busy = ["starting", "waiting", "verifying"].includes(snapshot.state.phase);
  return {
    ...snapshot.state,
    flowId: null,
    authorizationUrl: null,
    userCode: null,
    expiresAt: null,
    ...(busy ? { message: "Sign-in is in progress in another client." } : {}),
  };
}

export const makeCliLoginAuth = Effect.fn("makeCliLoginAuth")(function* (
  options: CliLoginAuthOptions,
): Effect.fn.Return<
  ProviderAuthController,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> {
  // `ProviderAuthController` pins `R = never`, so the spawner is captured here
  // and provided to every effect that shells out below.
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const instanceScope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const closed = yield* Deferred.make<void>();

  const emptyState: ProviderAuthState = {
    instanceId: options.instanceId,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
    completion: options.completion,
    userCode: null,
  };
  const snapshot = yield* SubscriptionRef.make<AuthSnapshot>({
    ownerSessionId: null,
    state: emptyState,
  });

  let activeFlow: AuthFlow | undefined;
  let operation: "idle" | "auth" | "logout" | "closed" = "idle";

  const setupError = (name: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation: name, detail });

  const failureDetail = (cause: Cause.Cause<unknown>, fallback: string): string => {
    const error = Cause.findErrorOption(cause);
    return Option.isSome(error) && isSetupError(error.value) ? error.value.detail : fallback;
  };

  const publishFlow = (flow: AuthFlow, state: ProviderAuthState) => {
    flow.state = state;
    return SubscriptionRef.set(snapshot, { ownerSessionId: flow.ownerSessionId, state });
  };

  const spawnFailureDetail = (invocation: CliInvocation) =>
    `Could not run ${invocation.command}. Check this provider's binary path.`;

  const settle = (flow: AuthFlow, phase: "succeeded" | "failed", message: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (activeFlow !== flow) return;
        activeFlow = undefined;
        operation = "idle";
        yield* publishFlow(flow, {
          ...flow.state,
          phase,
          authorizationUrl: null,
          userCode: null,
          expiresAt: null,
          message,
        });
      }),
    );

  const receiveLine = (flow: AuthFlow, line: string) =>
    Effect.gen(function* () {
      const url = findAuthorizationUrl(line, options.authorizationUrlHosts);
      const code = options.completion !== "code" ? findDeviceUserCode(line) : undefined;
      if (url === undefined && code === undefined) return;
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (activeFlow !== flow || operation !== "auth") return;
          // Providers print the link once. Keeping the first of each field
          // stops a redrawn banner from swapping the URL out mid-sign-in.
          const authorizationUrl = flow.state.authorizationUrl ?? url ?? null;
          const userCode = flow.state.userCode ?? code ?? null;
          if (
            authorizationUrl === flow.state.authorizationUrl &&
            userCode === flow.state.userCode
          ) {
            return;
          }
          // A loopback redirect in the authorization URL is what makes this a
          // paste-the-redirect flow. Reading it from the URL rather than from
          // configuration means a CLI that changes modes cannot desync the UI.
          if (flow.pendingCallback === undefined && url !== undefined) {
            flow.pendingCallback = parsePendingLoopbackCallback(url);
          }
          const completion: ProviderAuthCompletion =
            options.completion === "code"
              ? "code"
              : flow.pendingCallback !== undefined
                ? "redirectUrl"
                : "none";
          yield* publishFlow(flow, {
            ...flow.state,
            phase: "waiting",
            authorizationUrl,
            userCode,
            completion,
            message:
              completion === "code"
                ? `Open the sign-in page, then paste the code ${options.providerLabel} shows you.`
                : completion === "redirectUrl"
                  ? "Open the sign-in page. If the final page does not load, paste its URL here."
                  : "Open the sign-in page and enter the code to finish signing in.",
          });
        }),
      );
    });

  const runSignIn = (flow: AuthFlow, stopSessions: Effect.Effect<void, ProviderSetupError>) =>
    Effect.gen(function* () {
      // Stop this instance's running sessions first: an agent mid-turn holds
      // the same credential file the CLI is about to rewrite.
      yield* stopSessions;
      const result = yield* runCliInvocation(options.login, {
        input: flow.input,
        onLine: (line) => receiveLine(flow, line),
      });
      if (result.exitCode === null) {
        return yield* setupError("start", spawnFailureDetail(options.login));
      }
      if (result.exitCode !== 0) {
        return yield* setupError(
          "start",
          summarizeCliFailure(result.output) ??
            `${options.providerLabel} sign-in failed. Start sign-in again.`,
        );
      }
      // Exit code 0 only says the command ran. Ask the CLI whether this
      // instance's directory actually holds credentials now.
      if (!(yield* options.verifySignedIn)) {
        return yield* setupError(
          "start",
          `${options.providerLabel} did not store a sign-in for this provider. Start sign-in again.`,
        );
      }
      yield* options.onAuthenticated;
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: FLOW_TIMEOUT,
        orElse: () => Effect.fail(setupError("start", "Sign-in expired. Start sign-in again.")),
      }),
      Effect.exit,
      Effect.flatMap((result) =>
        Exit.isSuccess(result)
          ? settle(flow, "succeeded", `Signed in to ${options.accountLabel}.`)
          : settle(
              flow,
              "failed",
              failureDetail(
                result.cause,
                `${options.providerLabel} sign-in failed. Start sign-in again.`,
              ),
            ),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  const detachFlow = (flow: AuthFlow, phase: "cancelled" | "failed", message: string) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const detached = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (activeFlow !== flow) return false;
            activeFlow = undefined;
            operation = "idle";
            yield* publishFlow(flow, {
              ...flow.state,
              phase,
              authorizationUrl: null,
              userCode: null,
              expiresAt: null,
              message,
            });
            return true;
          }),
        );
        if (!detached) return;
        // Interrupting the fiber closes the process scope, which kills the CLI
        // before it can finish an exchange the user just abandoned.
        if (flow.fiber) yield* Fiber.interrupt(flow.fiber);
        yield* Queue.shutdown(flow.input);
      }),
    );

  const requireFlow = (ownerSessionId: string, flowId: string, name: string) =>
    Effect.gen(function* () {
      const flow = activeFlow;
      if (!flow || flow.id !== flowId || flow.ownerSessionId !== ownerSessionId) {
        return yield* setupError(name, "This sign-in is no longer active in this client.");
      }
      if ((yield* Clock.currentTimeMillis) >= flow.expiresAtMillis) {
        return yield* setupError(name, "Sign-in expired. Start sign-in again.");
      }
      return flow;
    });

  const controller: ProviderAuthController = {
    start: (ownerSessionId, stopSessions = Effect.void) =>
      lock.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (activeFlow?.ownerSessionId === ownerSessionId && operation === "auth") {
              return activeFlow.state;
            }
            if (operation !== "idle") {
              return yield* setupError(
                "start",
                `${options.providerLabel} sign-in or sign-out is already in progress.`,
              );
            }
            const flowId = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(() => setupError("start", "Could not start sign-in. Try again.")),
            );
            const expiresAtMillis =
              (yield* Clock.currentTimeMillis) + Duration.toMillis(FLOW_TIMEOUT);
            const state: ProviderAuthState = {
              ...emptyState,
              phase: "starting",
              flowId,
              expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAtMillis)),
              message: `Starting ${options.providerLabel} sign-in.`,
            };
            const flow: AuthFlow = {
              id: flowId,
              ownerSessionId,
              expiresAtMillis,
              state,
              input: yield* Queue.unbounded<string, Cause.Done>(),
              pendingCallback: undefined,
              responseSent: false,
              fiber: undefined,
            };
            activeFlow = flow;
            operation = "auth";
            yield* publishFlow(flow, state);
            flow.fiber = yield* runSignIn(flow, stopSessions).pipe(
              Effect.interruptible,
              Effect.forkIn(instanceScope),
            );
            return state;
          }),
        ),
      ),

    complete: Effect.fn("CliLoginAuth.complete")(function* (ownerSessionId, input) {
      // Claim the flow and record the response under the lock, then do the
      // delivery outside it: forwarding a redirect waits on the network, and
      // holding the lock there would block cancel and sign-out.
      const claimed = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const flow = yield* requireFlow(ownerSessionId, input.flowId, "complete");
          if (flow.responseSent) {
            return yield* setupError(
              "complete",
              `The response was already sent. Wait for ${options.providerLabel} to finish.`,
            );
          }
          if (flow.state.phase !== "waiting") {
            return yield* setupError("complete", "Wait for the sign-in link before you respond.");
          }
          if (flow.state.completion === "none") {
            return yield* setupError(
              "complete",
              `${options.providerLabel} finishes this sign-in in the browser. There is nothing to paste here.`,
            );
          }
          const callback =
            flow.pendingCallback === undefined
              ? undefined
              : yield* validateLoopbackCallbackUrl(
                  options.instanceId,
                  flow.pendingCallback,
                  input.callbackUrl,
                );
          flow.responseSent = true;
          if (callback === undefined) {
            // `Queue.end` drains what is buffered and then closes stdin, so the
            // CLI reads the code and sees EOF. `Queue.shutdown` would discard
            // the code, which is why it only ever abandons a flow.
            yield* Queue.offer(flow.input, `${input.callbackUrl}\n`);
            yield* Queue.end(flow.input);
          }
          yield* publishFlow(flow, {
            ...flow.state,
            phase: "verifying",
            authorizationUrl: null,
            userCode: null,
            message: `Checking the sign-in with ${options.providerLabel}.`,
          });
          return { flow, callback };
        }),
      );

      if (claimed.callback !== undefined) {
        // The CLI's listener owns the exchange from here. A delivery failure
        // settles the flow rather than leaving it at "verifying" until the
        // deadline, even if the RPC caller has already disconnected.
        yield* forwardLoopbackCallback(options.instanceId, claimed.callback).pipe(
          Effect.tapError((failure) =>
            detachFlow(claimed.flow, "failed", failure.detail).pipe(Effect.forkIn(instanceScope)),
          ),
        );
      }
      return claimed.flow.state;
    }),

    cancel: Effect.fn("CliLoginAuth.cancel")(function* (ownerSessionId, flowId) {
      const flow = yield* lock.withPermits(1)(requireFlow(ownerSessionId, flowId, "cancel"));
      yield* detachFlow(flow, "cancelled", "Sign-in was cancelled.");
      return flow.state;
    }),

    logout: Effect.fn("CliLoginAuth.logout")(function* (stopSessions) {
      const task = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const flow = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (operation === "logout" || operation === "closed") {
                return yield* setupError("logout", "Sign-out is already in progress.");
              }
              const current = activeFlow;
              activeFlow = undefined;
              operation = "logout";
              if (current) {
                yield* publishFlow(current, {
                  ...current.state,
                  phase: "cancelled",
                  authorizationUrl: null,
                  userCode: null,
                  expiresAt: null,
                  message: "Sign-in was cancelled by sign-out.",
                });
              }
              return current;
            }),
          );
          const result = yield* restore(
            Effect.gen(function* () {
              if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
              if (flow) yield* Queue.shutdown(flow.input);
              yield* stopSessions;
              const outcome = yield* runCliInvocation(options.logout);
              if (outcome.exitCode === null) {
                return yield* setupError("logout", spawnFailureDetail(options.logout));
              }
              if (outcome.exitCode !== 0) {
                return yield* setupError(
                  "logout",
                  summarizeCliFailure(outcome.output) ??
                    `${options.providerLabel} sign-out failed. Try again.`,
                );
              }
              yield* options.onSignedOut;
            }).pipe(
              Effect.scoped,
              Effect.timeoutOrElse({
                duration: LOGOUT_TIMEOUT,
                orElse: () =>
                  Effect.fail(setupError("logout", `${options.providerLabel} sign-out timed out.`)),
              }),
            ),
          ).pipe(Effect.exit);

          const detail = Exit.isFailure(result)
            ? failureDetail(result.cause, `${options.providerLabel} sign-out failed. Try again.`)
            : null;
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              operation = "idle";
              yield* SubscriptionRef.set(snapshot, {
                ownerSessionId: null,
                state: {
                  ...emptyState,
                  phase: detail === null ? "idle" : "failed",
                  message: detail ?? `Signed out of ${options.accountLabel}.`,
                },
              });
            }),
          );
          if (detail !== null) return yield* setupError("logout", detail);
          return yield* SubscriptionRef.get(snapshot).pipe(Effect.map((value) => value.state));
        }),
      );
      const worker = yield* task.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.forkIn(instanceScope),
      );
      return yield* Fiber.await(worker).pipe(Effect.flatMap((result) => result));
    }),

    subscribe: (ownerSessionId) =>
      SubscriptionRef.changes(snapshot).pipe(
        Stream.map((value) => visibleSnapshot(value, ownerSessionId)),
        Stream.interruptWhen(Deferred.await(closed)),
      ),
  };

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      operation = "closed";
      const flow = activeFlow;
      activeFlow = undefined;
      if (flow) {
        if (flow.fiber) yield* Fiber.interrupt(flow.fiber);
        yield* Queue.shutdown(flow.input);
      }
      yield* Deferred.succeed(closed, undefined);
    }),
  );

  return controller;
});
