/**
 * Claude sign-in, driven through `claude auth login`.
 *
 * The Claude CLI's own flow is a copy-code flow: it prints an authorization
 * URL, Anthropic's page shows the user a code after they approve, and the CLI
 * reads that code from stdin. Run with stdout piped it behaves the same way it
 * does in a terminal, so T3 Code relays the URL out and the code in, and the
 * CLI performs the exchange and stores the credentials itself.
 *
 * Credentials land in this instance's `CLAUDE_CONFIG_DIR`. On macOS the CLI
 * derives its keychain item name from that directory, so instances pointed at
 * different directories hold independent sign-ins and one subscription's login
 * cannot overwrite another's.
 *
 * @module provider/Drivers/ClaudeLogin
 */
import type { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeCliLoginAuth, runCliInvocation, type CliInvocation } from "../CliLoginAuth.ts";
import { stripAnsi } from "../cliLoginOutput.ts";
import type { ProviderAuthController } from "../Services/ProviderAuthService.ts";
import { makeClaudeEnvironment } from "./ClaudeHome.ts";

/** Hosts Anthropic serves the Claude Code sign-in page from. */
const AUTHORIZATION_URL_HOSTS = ["claude.com", "claude.ai", "anthropic.com"] as const;

/** `claude auth status --json`, narrowed to the field that decides the flow. */
const ClaudeAuthStatus = Schema.Struct({
  loggedIn: Schema.Boolean,
});
const decodeAuthStatus = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeAuthStatus));

/**
 * Whether this instance's config directory currently holds a Claude sign-in.
 *
 * Reads the CLI's own status rather than inspecting credential files, because
 * the credentials live in the macOS keychain on that platform and in a file on
 * the others.
 */
export const probeClaudeSignedIn = Effect.fn("probeClaudeSignedIn")(function* (
  invocation: CliInvocation,
): Effect.fn.Return<boolean, never, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> {
  const result = yield* runCliInvocation({
    ...invocation,
    args: ["auth", "status", "--json"],
  });
  if (result.exitCode !== 0) return false;
  // The status object is the last JSON value on stdout; earlier lines can be
  // update notices or warnings.
  const output = stripAnsi(result.output);
  const start = output.lastIndexOf("{");
  if (start < 0) return false;
  const status = decodeAuthStatus(output.slice(start));
  return Option.isSome(status) && status.value.loggedIn;
});

export interface ClaudeAuthControllerInput {
  readonly instanceId: ProviderInstanceId;
  readonly config: Pick<ClaudeSettings, "binaryPath" | "homePath">;
  readonly environment: NodeJS.ProcessEnv;
  /** Re-probe the instance so the snapshot shows the newly signed-in account. */
  readonly onAuthenticated: Effect.Effect<void>;
  readonly onSignedOut: Effect.Effect<void>;
}

export const makeClaudeAuthController = Effect.fn("makeClaudeAuthController")(function* (
  input: ClaudeAuthControllerInput,
): Effect.fn.Return<
  ProviderAuthController,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Path.Path | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const env = yield* makeClaudeEnvironment(input.config, input.environment);
  const base = {
    command: input.config.binaryPath || "claude",
    env,
  } satisfies Omit<CliInvocation, "args">;

  return yield* makeCliLoginAuth({
    instanceId: input.instanceId,
    providerLabel: "Claude",
    accountLabel: "your Anthropic account",
    completion: "code",
    authorizationUrlHosts: AUTHORIZATION_URL_HOSTS,
    login: { ...base, args: ["auth", "login"] },
    logout: { ...base, args: ["auth", "logout"] },
    verifySignedIn: probeClaudeSignedIn({ ...base, args: [] }).pipe(
      Effect.scoped,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ),
    onAuthenticated: input.onAuthenticated,
    onSignedOut: input.onSignedOut,
  });
});
