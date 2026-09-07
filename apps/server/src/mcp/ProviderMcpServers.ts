/**
 * MCP server management, per Claude provider instance.
 *
 * Every instance keeps its own `CLAUDE_CONFIG_DIR`, so a server added from a
 * plain shell only ever reaches whichever account owns `~/.claude`. This
 * module resolves each instance's directory and runs `claude mcp` against it,
 * which is why a user with five signed-in accounts can configure all five from
 * one screen.
 *
 * Definition reads lift the
 * `mcpServers` object off `<home>/.claude.json` and stop there; writes shell
 * out to `claude mcp add-json` and `claude mcp remove`, so the CLI keeps
 * deciding what a valid entry is. Native OAuth repair lives at the credential
 * adapter boundary and never transfers a Claude account session.
 *
 * @module mcp/ProviderMcpServers
 */
import {
  ProviderSetupError,
  type McpAuthInput,
  type ProviderAuthState,
  ClaudeSettings,
  CodexSettings,
  McpCliUnavailableError,
  McpInstanceNotFoundError,
  McpServerNotFoundError,
  type McpInstanceInventory,
  type McpInventory,
  type McpMutationResult,
  type McpMutationOutcome,
  type McpServerEntry,
  type ProviderInstanceId,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as NodeOS from "node:os";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { PtyAdapter } from "../terminal/PtyAdapter.ts";
import { runMcpPtyLogin } from "./McpPtyLogin.ts";
import { makeCliLoginAuth } from "../provider/CliLoginAuth.ts";
import { findMcpAuthorizationUrl } from "../provider/cliLoginOutput.ts";
import type { ProviderAuthController } from "../provider/Services/ProviderAuthService.ts";
import {
  clearClaudeMcpAuthCache,
  copyMcpRecords,
  hasRefreshMaterial,
  mcpRecordName,
  mcpRecords,
  readClaudeCredentials,
  repairMcpRecords,
  writeClaudeCredentials,
} from "./ClaudeMcpCredentials.ts";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { resolveProviderCredentialHome } from "../provider/providerCredentialHome.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import {
  resolveCodexHomeLayout,
  resolveCodexInstanceHomeLayout,
} from "../provider/Drivers/CodexHomeLayout.ts";
import { ServerSettingsService } from "../serverSettings.ts";

// The Claude driver registers itself as `claudeAgent`; `claude` is the CLI
// name, not the driver kind. See Drivers/ClaudeDriver.ts.
export class ProviderMcpServers extends Context.Service<
  ProviderMcpServers,
  {
    readonly repair: (input: {
      readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
      readonly name: string;
    }) => Effect.Effect<McpMutationResult, McpInstanceNotFoundError | ServerSettingsError>;
    readonly authStart: (
      input: McpAuthInput,
      owner: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly authComplete: (
      input: McpAuthInput & { readonly flowId: string; readonly callbackUrl: string },
      owner: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly authCancel: (
      input: McpAuthInput & { readonly flowId: string },
      owner: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly authLogout: (
      input: McpAuthInput,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly authSubscribe: (
      input: McpAuthInput,
      owner: string,
    ) => Stream.Stream<ProviderAuthState, ProviderSetupError>;
    readonly list: () => Effect.Effect<McpInventory, ServerSettingsError>;
    readonly add: (input: {
      readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
      readonly name: string;
      readonly json: string;
    }) => Effect.Effect<
      McpMutationResult,
      McpCliUnavailableError | McpInstanceNotFoundError | ServerSettingsError
    >;
    readonly remove: (input: {
      readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
      readonly name: string;
    }) => Effect.Effect<
      McpMutationResult,
      McpCliUnavailableError | McpInstanceNotFoundError | ServerSettingsError
    >;
    readonly copy: (input: {
      readonly fromInstanceId: ProviderInstanceId;
      readonly toInstanceIds: ReadonlyArray<ProviderInstanceId>;
      readonly name: string;
    }) => Effect.Effect<
      McpMutationResult,
      | McpCliUnavailableError
      | McpInstanceNotFoundError
      | McpServerNotFoundError
      | ServerSettingsError
    >;
  }
>()("t3/mcp/ProviderMcpServers") {}

const CLAUDE_DRIVER_KIND = "claudeAgent";
const CODEX_DRIVER_KIND = "codex";
/** Decoder for the JSON blobs this module reads out of `.claude.json`. */
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(UnknownFromJsonString);
const encodeJson = Schema.encodeUnknownEffect(UnknownFromJsonString);
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

/**
 * `claude mcp` writes and reads a small JSON file. Twenty seconds allows for
 * CLI startup while bounding how long a wedged instance can stall the page.
 */
const CLI_TIMEOUT_MS = 20_000;

interface ResolvedInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driver: typeof CLAUDE_DRIVER_KIND | typeof CODEX_DRIVER_KIND;
  readonly displayName: string;
  readonly binaryPath: string;
  /** Empty when the instance uses the CLI's own default home. */
  readonly configDir: string;
  /** Absolute config directory, the CLI's default home included. */
  readonly resolvedHome: string;
  /**
   * The instance's own environment merged over the server's. Accounts signed
   * in through `CLAUDE_CODE_OAUTH_TOKEN` keep their credential here rather
   * than on disk, so a CLI run without it is a different, signed-out account.
   */
  readonly environment: NodeJS.ProcessEnv;
  /** Names of the variables this instance adds, for the UI to explain. */
  readonly requiredEnvNames: ReadonlyArray<string>;
  readonly readError?: string;
}

/**
 * Shell prefix a user can paste to reach this instance from their own
 * terminal. Shown in the UI so the OAuth flows that only the interactive CLI
 * can run stay reachable without guessing at paths.
 */
function cliPrefixFor(instance: ResolvedInstance): string {
  const isClaude = instance.driver === CLAUDE_DRIVER_KIND;
  const binary = instance.binaryPath.trim() || (isClaude ? "claude" : "codex");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  if (instance.configDir.length === 0) return quote(binary);
  const variable = isClaude ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  return `${variable}=${quote(instance.configDir)} ${quote(binary)}`;
}

const resolveClaudeInstances = Effect.fn("ProviderMcpServers.resolveClaudeInstances")(function* () {
  const settings = yield* ServerSettingsService;
  const { providerHomesDir } = yield* ServerConfig;
  const current = yield* settings.getSettings;

  const resolved: Array<ResolvedInstance> = [];
  for (const [rawInstanceId, entry] of Object.entries(current.providerInstances)) {
    if (entry.driver !== CLAUDE_DRIVER_KIND) continue;
    const instanceId = rawInstanceId as ProviderInstanceId;
    const config = decodeClaudeSettings(entry.config ?? {});
    const configDir = yield* resolveProviderCredentialHome({
      driverKind: entry.driver,
      instanceId,
      configuredPath: config.homePath,
      providerHomesDir,
    });
    const environment = mergeProviderInstanceEnvironment(entry.environment);
    const effectiveDir = configDir || environment.CLAUDE_CONFIG_DIR || "";
    const resolvedHome = yield* resolveClaudeHomePath({ homePath: effectiveDir });
    resolved.push({
      instanceId,
      driver: CLAUDE_DRIVER_KIND,
      displayName: entry.displayName?.trim() || rawInstanceId,
      binaryPath: config.binaryPath,
      configDir: effectiveDir ? resolvedHome : "",
      resolvedHome,
      environment,
      requiredEnvNames: (entry.environment ?? []).map((variable) => variable.name),
    });
  }

  return resolved;
});

const resolveCodexInstances = Effect.fn("ProviderMcpServers.resolveCodexInstances")(function* () {
  const settings = yield* ServerSettingsService;
  const current = yield* settings.getSettings;
  const { providerHomesDir } = yield* ServerConfig;

  const resolved: Array<ResolvedInstance> = [];
  for (const [rawInstanceId, entry] of Object.entries(current.providerInstances)) {
    if (entry.driver !== CODEX_DRIVER_KIND) continue;
    const config = decodeCodexSettings(entry.config ?? {});
    const resolvedLayout = yield* resolveCodexInstanceHomeLayout(
      config,
      rawInstanceId as ProviderInstanceId,
      providerHomesDir,
    ).pipe(Effect.result);
    const layout =
      resolvedLayout._tag === "Success"
        ? resolvedLayout.success
        : yield* resolveCodexHomeLayout(config);
    // Codex keeps auth.json private to a shadow home but symlinks config.toml
    // back to the shared one, so a write through the shadow lands in the
    // shared server list. That is the intent: sign-ins are per account,
    // servers are not.
    resolved.push({
      instanceId: rawInstanceId as ProviderInstanceId,
      driver: CODEX_DRIVER_KIND,
      ...(resolvedLayout._tag === "Failure" ? { readError: resolvedLayout.failure.message } : {}),
      displayName: entry.displayName?.trim() || rawInstanceId,
      binaryPath: config.binaryPath,
      configDir: layout.effectiveHomePath ?? "",
      resolvedHome: layout.sharedHomePath,
      environment: mergeProviderInstanceEnvironment(entry.environment),
      requiredEnvNames: (entry.environment ?? []).map((variable) => variable.name),
    });
  }

  return resolved;
});

const resolveInstances = Effect.fn("ProviderMcpServers.resolveInstances")(function* () {
  const claude = yield* resolveClaudeInstances();
  const codex = yield* resolveCodexInstances();
  return [...claude, ...codex].sort(
    (left, right) =>
      left.driver.localeCompare(right.driver) || left.displayName.localeCompare(right.displayName),
  );
});

const findInstance = Effect.fn("ProviderMcpServers.findInstance")(function* (
  instanceId: ProviderInstanceId,
) {
  const instances = yield* resolveInstances();
  const match = instances.find((instance) => instance.instanceId === instanceId);
  if (!match) return yield* new McpInstanceNotFoundError({ instanceId });
  return match;
});

/**
 * The shape both CLIs are translated through. It is Claude Code's `.claude.json`
 * entry, because that is the richest of the two and the form the add box takes,
 * so a definition never has to be typed twice.
 */
interface CanonicalServer {
  readonly type: string | undefined;
  readonly url: string | undefined;
  readonly command: string | undefined;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
}

function readStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

export function toCanonicalServer(raw: unknown): CanonicalServer {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    type: typeof record.type === "string" ? record.type : undefined,
    url: typeof record.url === "string" ? record.url : undefined,
    command: typeof record.command === "string" ? record.command : undefined,
    args: Array.isArray(record.args)
      ? record.args.filter((entry): entry is string => typeof entry === "string")
      : [],
    env: readStringRecord(record.env),
    headers: readStringRecord(record.headers),
  };
}

/** One entry of `codex mcp list --json`, rewritten into the canonical shape. */
export function codexEntryToCanonical(raw: unknown): CanonicalServer {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const transport =
    typeof record.transport === "object" && record.transport !== null
      ? (record.transport as Record<string, unknown>)
      : {};
  const isStdio = transport.type === "stdio";
  return {
    type: isStdio ? "stdio" : "http",
    url: typeof transport.url === "string" ? transport.url : undefined,
    command: typeof transport.command === "string" ? transport.command : undefined,
    args: Array.isArray(transport.args)
      ? transport.args.filter((entry): entry is string => typeof entry === "string")
      : [],
    env: readStringRecord(transport.env),
    headers: readStringRecord(transport.http_headers),
  };
}

export function canonicalToEntry(name: string, server: CanonicalServer): McpServerEntry {
  return {
    name,
    transport: server.type ?? (server.url ? "http" : server.command ? "stdio" : "unknown"),
    target: server.url ?? [server.command ?? "", ...server.args].join(" ").trim(),
    envKeys: Object.keys(server.env),
    headerKeys: Object.keys(server.headers),
  };
}

/**
 * Build the CLI arguments that install `server` under `name` on one account.
 * Returns a reason string when the provider cannot express the definition,
 * which is reported per account rather than silently dropping the part that
 * does not fit.
 */
export function addArgsFor(
  instance: ResolvedInstance,
  name: string,
  server: CanonicalServer,
  rawJson: string,
): { readonly args: ReadonlyArray<string> } | { readonly reason: string } {
  if (instance.driver === CLAUDE_DRIVER_KIND) {
    return { args: ["add-json", "--scope", "user", name, rawJson] };
  }

  if (server.command) {
    const env = Object.entries(server.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    return { args: ["add", name, ...env, "--", server.command, ...server.args] };
  }

  if (!server.url) {
    return { reason: "Needs a url or a command." };
  }

  // `codex mcp add` exposes only --bearer-token-env-var for remote auth, so a
  // definition carrying literal headers would install without its credentials.
  // Refusing is better than a server that silently fails to authenticate.
  if (Object.keys(server.headers).length > 0) {
    return { reason: "Codex cannot store request headers; add it with a bearer token env var." };
  }

  return { args: ["add", name, "--url", server.url] };
}

function removeArgsFor(instance: ResolvedInstance, name: string): ReadonlyArray<string> {
  return instance.driver === CLAUDE_DRIVER_KIND
    ? ["remove", "--scope", "user", name]
    : ["remove", name];
}

const readClaudeInventory = Effect.fn("ProviderMcpServers.readClaudeInventory")(function* (
  instance: ResolvedInstance,
): Effect.fn.Return<McpInstanceInventory, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(instance.resolvedHome, ".claude.json");

  const base = {
    instanceId: instance.instanceId,
    driver: instance.driver,
    displayName: instance.displayName,
    configDir: instance.configDir,
    cliPrefix: cliPrefixFor(instance),
    requiredEnvNames: instance.requiredEnvNames,
  } as const;

  const contents = yield* fileSystem.readFileString(configPath).pipe(Effect.result);
  // A missing file is the normal state for a freshly provisioned instance, not
  // an error worth surfacing: it simply has no servers yet.
  if (contents._tag === "Failure")
    return {
      ...base,
      servers: [],
      ...(contents.failure.reason._tag === "NotFound"
        ? {}
        : { readError: `Could not read ${configPath}` }),
    };

  const parsed = yield* decodeJson(contents.success).pipe(Effect.option);
  if (parsed._tag === "None") {
    return { ...base, servers: [], readError: `Could not parse ${configPath}` };
  }

  const root =
    typeof parsed.value === "object" && parsed.value !== null
      ? (parsed.value as Record<string, unknown>)
      : {};
  const servers =
    typeof root.mcpServers === "object" && root.mcpServers !== null
      ? (root.mcpServers as Record<string, unknown>)
      : {};

  return {
    ...base,
    servers: Object.entries(servers)
      .map(([name, raw]) => canonicalToEntry(name, toCanonicalServer(raw)))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
});

/**
 * Codex ships `mcp list --json`, so its inventory comes from the CLI rather
 * than from parsing `config.toml`. That keeps TOML out of this module and
 * means Codex decides what its own config means.
 */
const readCodexInventory = Effect.fn("ProviderMcpServers.readCodexInventory")(function* (
  instance: ResolvedInstance,
): Effect.fn.Return<McpInstanceInventory, never, ProcessRunner.ProcessRunner> {
  const base = {
    instanceId: instance.instanceId,
    driver: instance.driver,
    displayName: instance.displayName,
    configDir: instance.configDir,
    cliPrefix: cliPrefixFor(instance),
    requiredEnvNames: instance.requiredEnvNames,
  } as const;

  if (instance.readError) return { ...base, servers: [], readError: instance.readError };
  const result = yield* runProviderMcp({ instance, args: ["list", "--json"] }).pipe(Effect.option);
  if (result._tag === "None" || !result.value.outcome.ok) {
    return {
      ...base,
      servers: [],
      readError:
        result._tag === "None" ? "Could not run the Codex CLI." : result.value.outcome.message,
    };
  }

  const parsed = yield* decodeJson(result.value.stdout).pipe(Effect.option);
  if (parsed._tag === "None" || !Array.isArray(parsed.value)) {
    return { ...base, servers: [], readError: "Could not read the Codex server list." };
  }

  return {
    ...base,
    servers: parsed.value
      .map((raw) => {
        const record =
          typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
        const name = typeof record.name === "string" ? record.name : "";
        return {
          ...canonicalToEntry(name, codexEntryToCanonical(record)),
          authStatus:
            record.auth_status === "oauth"
              ? ("stored" as const)
              : record.auth_status === "not_logged_in"
                ? ("needsAuth" as const)
                : ("unknown" as const),
        };
      })
      .filter((entry) => entry.name.length > 0)
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
});

const withClaudeAuthInventory = Effect.fn("ProviderMcpServers.withClaudeAuthInventory")(function* (
  instance: ResolvedInstance,
  inventory: McpInstanceInventory,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* readClaudeCredentials(instance.configDir).pipe(Effect.result);
  if (store._tag === "Failure") return { ...inventory, readError: store.failure.message };
  const records = mcpRecords(store.success.credentials);
  const cachePath = path.join(
    instance.configDir || path.join(NodeOS.homedir(), ".claude"),
    "mcp-needs-auth-cache.json",
  );
  const cache = yield* fs.readFileString(cachePath).pipe(
    Effect.flatMap(decodeJson),
    Effect.orElseSucceed(() => ({})),
  );
  const needsAuth = typeof cache === "object" && cache !== null ? cache : {};
  const servers = new Map(
    inventory.servers.map((entry) => [entry.name, { ...entry, canManageDefinition: true }]),
  );
  for (const [key, record] of Object.entries(records)) {
    const name = mcpRecordName(key);
    if (!name || servers.has(name)) continue;
    servers.set(name, {
      name,
      transport: "http",
      target: typeof record.serverUrl === "string" ? record.serverUrl : "",
      envKeys: [],
      headerKeys: [],
      canManageDefinition: false,
    });
  }
  for (const name of Object.keys(needsAuth)) {
    if (!servers.has(name))
      servers.set(name, {
        name,
        transport: "unknown",
        target: "",
        envKeys: [],
        headerKeys: [],
        canManageDefinition: false,
      });
  }
  return {
    ...inventory,
    servers: [...servers.values()]
      .map((server): McpServerEntry => {
        const matching = Object.entries(records)
          .filter(([key]) => mcpRecordName(key) === server.name)
          .map(([, record]) => record);
        const authStatus =
          server.name in needsAuth
            ? "needsAuth"
            : matching.some(hasRefreshMaterial)
              ? "stored"
              : matching.length > 0
                ? "incomplete"
                : "unknown";
        return { ...server, authStatus };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
});

const listMcpServers = Effect.fn("ProviderMcpServers.list")(function* () {
  const instances = yield* resolveInstances();
  const inventories: Array<McpInstanceInventory> = [];
  for (const instance of instances) {
    const inventory = yield* instance.driver === CLAUDE_DRIVER_KIND
      ? readClaudeInventory(instance)
      : readCodexInventory(instance);
    inventories.push(
      instance.driver === CLAUDE_DRIVER_KIND
        ? yield* withClaudeAuthInventory(instance, inventory)
        : inventory,
    );
  }
  return { instances: inventories };
});

const runProviderMcp = Effect.fn("ProviderMcpServers.runProviderMcp")(function* (input: {
  readonly instance: ResolvedInstance;
  readonly args: ReadonlyArray<string>;
}) {
  if (input.instance.readError)
    return {
      outcome: {
        instanceId: input.instance.instanceId,
        ok: false,
        message: input.instance.readError,
      },
      stdout: "",
    };
  const runner = yield* ProcessRunner.ProcessRunner;
  const isClaude = input.instance.driver === CLAUDE_DRIVER_KIND;
  const binaryPath = input.instance.binaryPath.trim() || (isClaude ? "claude" : "codex");
  const homeVariable = isClaude ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const result = yield* runner
    .run({
      command: binaryPath,
      args: ["mcp", ...input.args],
      timeout: CLI_TIMEOUT_MS,
      env: {
        ...input.instance.environment,
        ...(input.instance.configDir.length > 0
          ? { [homeVariable]: input.instance.configDir }
          : {}),
      },
      outputMode: "truncate",
    })
    .pipe(
      Effect.mapError(
        () => new McpCliUnavailableError({ instanceId: input.instance.instanceId, binaryPath }),
      ),
    );

  return {
    outcome: {
      instanceId: input.instance.instanceId,
      ok: result.code === 0,
      // Both CLIs report "already exists" and validation failures on stderr;
      // the user needs the real text or the row just says "failed".
      message:
        result.code === 0 ? "" : (result.stderr.trim() || result.stdout.trim()).slice(0, 2_000),
    } satisfies McpMutationOutcome,
    /** Read commands (`mcp list --json`, `mcp get --json`) answer on stdout. */
    stdout: result.stdout,
  };
});

/**
 * Install one definition across several accounts, translating it per provider.
 * Accounts are applied in sequence rather than in parallel: each CLI rewrites
 * a whole config file, and two accounts that share a home would race.
 */
const applyServerToInstances = Effect.fn("ProviderMcpServers.applyServerToInstances")(
  function* (input: {
    readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
    readonly name: string;
    readonly json: string;
  }) {
    const server = toCanonicalServer(
      yield* decodeJson(input.json).pipe(Effect.orElseSucceed(() => ({}))),
    );

    const outcomes: Array<McpMutationOutcome> = [];
    for (const instanceId of new Set(input.instanceIds)) {
      outcomes.push(
        yield* Effect.gen(function* () {
          const instance = yield* findInstance(instanceId);
          const plan = addArgsFor(instance, input.name, server, input.json);
          if ("reason" in plan) return { instanceId, ok: false, message: plan.reason };
          return (yield* runProviderMcp({ instance, args: plan.args })).outcome;
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({ instanceId, ok: false, message: error.message }),
          ),
        ),
      );
    }
    return { outcomes };
  },
);

const addMcpServer = Effect.fn("ProviderMcpServers.add")(function* (input: {
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly name: string;
  readonly json: string;
}) {
  return yield* applyServerToInstances(input);
});

/**
 * Read one server's full definition, secrets included. Only ever consumed by
 * `copyMcpServer`, which hands it straight back to the CLI on another
 * instance, so the values never reach a client.
 */
const readRawServerDefinition = Effect.fn("ProviderMcpServers.readRawServerDefinition")(function* (
  instance: ResolvedInstance,
  name: string,
): Effect.fn.Return<
  string,
  McpServerNotFoundError | McpCliUnavailableError,
  FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
> {
  if (instance.driver === CODEX_DRIVER_KIND) {
    const result = yield* runProviderMcp({ instance, args: ["get", name, "--json"] }).pipe(
      Effect.option,
    );
    const parsed =
      result._tag === "Some" && result.value.outcome.ok
        ? yield* decodeJson(result.value.stdout).pipe(Effect.option)
        : { _tag: "None" as const };
    if (parsed._tag === "None") {
      return yield* new McpServerNotFoundError({ instanceId: instance.instanceId, name });
    }
    return yield* encodeJson(codexEntryToCanonical(parsed.value)).pipe(
      Effect.orElseSucceed(() => ""),
    );
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(instance.resolvedHome, ".claude.json");
  const contents = yield* fileSystem.readFileString(configPath).pipe(Effect.option);
  if (contents._tag === "None") {
    return yield* new McpServerNotFoundError({ instanceId: instance.instanceId, name });
  }
  const parsed = yield* decodeJson(contents.value).pipe(Effect.option);
  const root =
    parsed._tag === "Some" && typeof parsed.value === "object" && parsed.value !== null
      ? (parsed.value as Record<string, unknown>)
      : {};
  const servers =
    typeof root.mcpServers === "object" && root.mcpServers !== null
      ? (root.mcpServers as Record<string, unknown>)
      : {};
  const definition = servers[name];
  if (definition === undefined) {
    return yield* new McpServerNotFoundError({ instanceId: instance.instanceId, name });
  }
  return yield* encodeJson(definition).pipe(Effect.orElseSucceed(() => ""));
});

/**
 * Replicate a server that one instance already has onto others. This is the
 * path that actually matters for a user with several signed-in accounts: they
 * configured a server once, in a terminal or in Claude Desktop, and want the
 * other accounts to match without retyping credentials.
 */
const copyMcpServer = Effect.fn("ProviderMcpServers.copy")(function* (input: {
  readonly fromInstanceId: ProviderInstanceId;
  readonly toInstanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly name: string;
}) {
  const source = yield* findInstance(input.fromInstanceId);
  const json = yield* readRawServerDefinition(source, input.name);
  const result = yield* applyServerToInstances({
    instanceIds: input.toInstanceIds.filter((id) => id !== input.fromInstanceId),
    name: input.name,
    json,
  });
  if (source.driver !== CLAUDE_DRIVER_KIND) return result;
  const outcomes: McpMutationOutcome[] = [];
  for (const outcome of result.outcomes) {
    if (!outcome.ok) {
      outcomes.push(outcome);
      continue;
    }
    const target = yield* findInstance(outcome.instanceId);
    if (target.driver !== CLAUDE_DRIVER_KIND || source.configDir === target.configDir) {
      outcomes.push(outcome);
      continue;
    }
    outcomes.push(
      yield* Effect.gen(function* () {
        const sourceStore = yield* readClaudeCredentials(source.configDir);
        const targetStore = yield* readClaudeCredentials(target.configDir);
        const merged = copyMcpRecords(sourceStore.credentials, targetStore.credentials, input.name);
        if (merged.copied > 0) {
          yield* writeClaudeCredentials(target.configDir, {
            ...targetStore,
            credentials: merged.credentials,
          });
          yield* clearClaudeMcpAuthCache(target.configDir, input.name);
        }
        return outcome;
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            ...outcome,
            ok: false,
            message: `Definition copied, but authorization could not be copied: ${error.message} Use Sign in.`,
          }),
        ),
      ),
    );
  }
  return { outcomes };
});

const removeMcpServer = Effect.fn("ProviderMcpServers.remove")(function* (input: {
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly name: string;
}) {
  const outcomes: Array<McpMutationOutcome> = [];
  for (const instanceId of new Set(input.instanceIds)) {
    outcomes.push(
      yield* Effect.gen(function* () {
        const instance = yield* findInstance(instanceId);
        return (yield* runProviderMcp({ instance, args: removeArgsFor(instance, input.name) }))
          .outcome;
      }).pipe(
        Effect.catch((error) => Effect.succeed({ instanceId, ok: false, message: error.message })),
      ),
    );
  }
  return { outcomes };
});

export const make = Effect.fn("ProviderMcpServers.make")(function* () {
  // Captured once so the service's operations carry no requirements of their
  // own. `ProcessRunner` in particular must stop here: leaking it upward puts
  // it in the context of every RPC handler and, from there, the whole server.
  const context = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | ProcessRunner.ProcessRunner
    | ServerConfig
    | ServerSettingsService
  >();

  const pty = yield* PtyAdapter;
  const scope = yield* Scope.Scope;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const controllerLock = yield* Semaphore.make(1);
  const controllers = new Map<string, ProviderAuthController>();
  const authController = Effect.fn("ProviderMcpServers.authController")(function* (
    input: McpAuthInput,
  ) {
    const instance = yield* findInstance(input.instanceId).pipe(
      Effect.provide(context),
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId: input.instanceId,
            operation: "mcp",
            detail: "This provider account is unavailable.",
          }),
      ),
    );
    if (instance.readError)
      return yield* new ProviderSetupError({
        instanceId: input.instanceId,
        operation: "mcp",
        detail: instance.readError,
      });
    const key = yield* encodeJson([
      instance.instanceId,
      instance.configDir,
      instance.binaryPath,
      input.name,
    ]).pipe(Effect.orDie);
    const existing = controllers.get(key);
    if (existing) return existing;
    const isClaude = instance.driver === CLAUDE_DRIVER_KIND;
    const env = {
      ...instance.environment,
      ...(instance.configDir
        ? { [isClaude ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: instance.configDir }
        : {}),
    };
    const base = {
      command: instance.binaryPath || (isClaude ? "claude" : "codex"),
      env,
      cwd: instance.resolvedHome,
    };
    const verify = isClaude
      ? readClaudeCredentials(instance.configDir).pipe(
          Effect.map((store) =>
            Object.entries(mcpRecords(store.credentials)).some(
              ([key, record]) =>
                mcpRecordName(key) === input.name &&
                typeof record.accessToken === "string" &&
                record.accessToken.length > 0,
            ),
          ),
          Effect.orElseSucceed(() => false),
          Effect.provide(context),
        )
      : runProviderMcp({ instance, args: ["list", "--json"] }).pipe(
          Effect.flatMap((result) => decodeJson(result.stdout)),
          Effect.map(
            (raw) =>
              Array.isArray(raw) &&
              raw.some((entry) => entry?.name === input.name && entry?.auth_status === "oauth"),
          ),
          Effect.orElseSucceed(() => false),
          Effect.provide(context),
        );
    const login = {
      ...base,
      args: ["mcp", "login", input.name, ...(isClaude ? ["--no-browser"] : [])],
    };
    const controller = yield* makeCliLoginAuth({
      instanceId: input.instanceId,
      providerLabel: isClaude ? "Claude MCP" : "Codex MCP",
      accountLabel: input.name,
      completion: "redirectUrl",
      authorizationUrlHosts: [],
      findAuthorizationUrl: findMcpAuthorizationUrl,
      ...(isClaude ? { redirectDelivery: "stdin" as const } : {}),
      login,
      ...(isClaude
        ? {
            runLogin: (input, onLine) =>
              runMcpPtyLogin(login, input, onLine).pipe(Effect.provideService(PtyAdapter, pty)),
          }
        : {}),
      logout: { ...base, args: ["mcp", "logout", input.name] },
      verifySignedIn: verify,
      onAuthenticated: Effect.void,
      onSignedOut: Effect.void,
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Crypto.Crypto, crypto),
    );
    controllers.set(key, controller);
    return controller;
  }, controllerLock.withPermits(1));

  const hasActiveAuth = Effect.fn("ProviderMcpServers.hasActiveAuth")(function* (
    except?: ProviderAuthController,
  ) {
    for (const controller of controllers.values()) {
      if (controller === except) continue;
      const state = yield* controller.subscribe("mcp-mutation").pipe(Stream.runHead);
      if (state._tag === "Some" && ["starting", "waiting", "verifying"].includes(state.value.phase))
        return true;
    }
    return false;
  });

  const repair = Effect.fn("ProviderMcpServers.repair")(function* (input: {
    readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
    readonly name: string;
  }) {
    if (yield* hasActiveAuth())
      return {
        outcomes: input.instanceIds.map((instanceId) => ({
          instanceId,
          ok: false,
          message: "Finish or cancel connector sign-in before repairing credentials.",
        })),
      };
    const hostEnv = yield* HostProcessEnvironment;
    const sourceDir = hostEnv.CLAUDE_CONFIG_DIR?.trim()
      ? yield* resolveClaudeHomePath({ homePath: hostEnv.CLAUDE_CONFIG_DIR })
      : "";
    const outcomes: McpMutationOutcome[] = [];
    for (const instanceId of new Set(input.instanceIds)) {
      const instance = yield* findInstance(instanceId);
      if (instance.driver !== CLAUDE_DRIVER_KIND || instance.configDir === sourceDir) {
        outcomes.push({
          instanceId,
          ok: false,
          message: "Repair applies to a separate Claude account. Use Sign in for this account.",
        });
        continue;
      }
      const result = yield* Effect.gen(function* () {
        const source = yield* readClaudeCredentials(sourceDir);
        const target = yield* readClaudeCredentials(instance.configDir);
        const repaired = repairMcpRecords(source.credentials, target.credentials, input.name);
        if (repaired.repaired === 0)
          return {
            instanceId,
            ok: false,
            message:
              "No incomplete record with a matching configuration and refresh material in the default Claude home. Use Sign in.",
          };
        yield* writeClaudeCredentials(instance.configDir, {
          ...target,
          credentials: repaired.credentials,
        });
        yield* clearClaudeMcpAuthCache(instance.configDir, input.name);
        return {
          instanceId,
          ok: true,
          message: "Refresh credentials restored. Start a new conversation to reconnect.",
        };
      }).pipe(
        Effect.catch((error) => Effect.succeed({ instanceId, ok: false, message: error.message })),
      );
      outcomes.push(result);
    }
    return { outcomes };
  }, lock.withPermits(1));

  // Every operation re-reads settings. Accounts are added and signed out while
  // the app runs, and this backs a settings page, not a hot path.
  return ProviderMcpServers.of({
    repair: (input) => repair(input).pipe(Effect.provide(context)),
    authStart: (input, owner) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const controller = yield* authController(input);
          if (yield* hasActiveAuth(controller))
            return yield* new ProviderSetupError({
              instanceId: input.instanceId,
              operation: "mcp",
              detail: "Finish or cancel the other connector sign-in first.",
            });
          return yield* controller.start(owner);
        }),
      ),
    authComplete: (input, owner) =>
      authController(input).pipe(Effect.flatMap((controller) => controller.complete(owner, input))),
    authCancel: (input, owner) =>
      authController(input).pipe(
        Effect.flatMap((controller) => controller.cancel(owner, input.flowId)),
      ),
    authLogout: (input) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const controller = yield* authController(input);
          if (yield* hasActiveAuth(controller))
            return yield* new ProviderSetupError({
              instanceId: input.instanceId,
              operation: "mcp",
              detail: "Finish or cancel the other connector sign-in first.",
            });
          return yield* controller.logout(Effect.void);
        }),
      ),
    authSubscribe: (input, owner) =>
      Stream.unwrap(
        authController(input).pipe(Effect.map((controller) => controller.subscribe(owner))),
      ),
    list: () => listMcpServers().pipe(Effect.provide(context)),
    add: (input) => addMcpServer(input).pipe(Effect.provide(context)),
    remove: (input) => removeMcpServer(input).pipe(Effect.provide(context)),
    copy: (input) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            if (yield* hasActiveAuth())
              return {
                outcomes: input.toInstanceIds.map((instanceId) => ({
                  instanceId,
                  ok: false,
                  message: "Finish or cancel connector sign-in before copying credentials.",
                })),
              };
            return yield* copyMcpServer(input);
          }),
        )
        .pipe(Effect.provide(context)),
  });
});

export const layer = Layer.effect(ProviderMcpServers, make());
