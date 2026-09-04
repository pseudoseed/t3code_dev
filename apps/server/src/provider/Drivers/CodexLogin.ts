/**
 * Codex sign-in, driven through the Codex CLI's own login command.
 *
 * Codex ships two sign-in modes and neither is unconditionally better.
 *
 * `codex login` redirects to a loopback listener on a hardcoded port. That is
 * the default here because it needs nothing enabled on the user's account. Its
 * cost is that only one Codex sign-in can run on a machine at a time, and that
 * a browser on another device lands on a `localhost` URL it cannot reach — so
 * the user pastes that URL back and the server delivers it to the listener.
 *
 * `codex login --device-auth` prints a URL and a one-time code and needs no
 * port or paste-back, but OpenAI ships device code authorization disabled, so
 * an account that has not enabled it in ChatGPT security settings is told to go
 * run a terminal command. That makes it the opt-in fallback rather than the
 * default.
 *
 * Credentials land in this instance's `CODEX_HOME/auth.json`, which is what the
 * shadow-home layout already keeps private per instance, so signing a second
 * account in leaves the first untouched.
 *
 * @module provider/Drivers/CodexLogin
 */
import type { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";

import { expandHomePath } from "../../pathExpansion.ts";
import { makeCliLoginAuth, runCliInvocation, type CliInvocation } from "../CliLoginAuth.ts";
import type { ProviderAuthController } from "../Services/ProviderAuthService.ts";

/** Hosts OpenAI serves the Codex device-authorization pages from. */
const AUTHORIZATION_URL_HOSTS = ["openai.com", "chatgpt.com"] as const;

/**
 * Whether this instance's Codex home currently holds a sign-in.
 *
 * `codex login status` exits 0 when signed in and 1 when not, so the exit code
 * carries the answer and no output parsing is needed.
 */
export const probeCodexSignedIn = Effect.fn("probeCodexSignedIn")(function* (
  invocation: CliInvocation,
): Effect.fn.Return<boolean, never, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> {
  const result = yield* runCliInvocation({ ...invocation, args: ["login", "status"] });
  return result.exitCode === 0;
});

export interface CodexAuthControllerInput {
  readonly instanceId: ProviderInstanceId;
  /** `homePath` is the instance's effective Codex home, already resolved. */
  readonly config: Pick<CodexSettings, "binaryPath" | "homePath" | "deviceCodeLogin">;
  readonly environment: NodeJS.ProcessEnv;
  /** Re-probe the instance so the snapshot shows the newly signed-in account. */
  readonly onAuthenticated: Effect.Effect<void>;
  readonly onSignedOut: Effect.Effect<void>;
}

export const makeCodexAuthController = Effect.fn("makeCodexAuthController")(function* (
  input: CodexAuthControllerInput,
): Effect.fn.Return<
  ProviderAuthController,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> {
  // `~` is not shell-expanded for env vars passed to spawn, so an unexpanded
  // CODEX_HOME would reach codex verbatim and fail as a missing path.
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolvedHomePath = input.config.homePath
    ? expandHomePath(input.config.homePath)
    : undefined;
  const base = {
    command: input.config.binaryPath || "codex",
    env: {
      ...input.environment,
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
    },
  } satisfies Omit<CliInvocation, "args">;

  return yield* makeCliLoginAuth({
    instanceId: input.instanceId,
    providerLabel: "Codex",
    accountLabel: "your ChatGPT account",
    // The loopback flow advertises its redirect in the authorization URL, and
    // the controller upgrades the flow to `redirectUrl` when it sees one.
    completion: input.config.deviceCodeLogin ? "none" : "redirectUrl",
    authorizationUrlHosts: AUTHORIZATION_URL_HOSTS,
    login: {
      ...base,
      args: input.config.deviceCodeLogin ? ["login", "--device-auth"] : ["login"],
    },
    logout: { ...base, args: ["logout"] },
    verifySignedIn: probeCodexSignedIn({ ...base, args: [] }).pipe(
      Effect.scoped,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ),
    onAuthenticated: input.onAuthenticated,
    onSignedOut: input.onSignedOut,
  });
});
