/**
 * MCP server management, per Claude provider instance.
 *
 * Every instance keeps its own `CLAUDE_CONFIG_DIR`, so a server added from a
 * plain shell only ever reaches whichever account owns `~/.claude`. This
 * module resolves each instance's directory and runs `claude mcp` against it,
 * which is why a user with five signed-in accounts can configure all five from
 * one screen.
 *
 * T3 Code owns none of Claude Code's configuration semantics. Reads lift the
 * `mcpServers` object off `<home>/.claude.json` and stop there; writes shell
 * out to `claude mcp add-json` and `claude mcp remove`, so the CLI keeps
 * deciding what a valid entry is and nothing here has to track its rules.
 *
 * @module mcp/ProviderMcpServers
 */
import {
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
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { ServerSettingsService } from "../serverSettings.ts";

// The Claude driver registers itself as `claudeAgent`; `claude` is the CLI
// name, not the driver kind. See Drivers/ClaudeDriver.ts.
export class ProviderMcpServers extends Context.Service<
  ProviderMcpServers,
  {
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
 * `claude mcp` writes and reads a small JSON file. Two seconds is generous for
 * that and short enough that one wedged instance cannot stall the whole page.
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
}

/**
 * Shell prefix a user can paste to reach this instance from their own
 * terminal. Shown in the UI so the OAuth flows that only the interactive CLI
 * can run stay reachable without guessing at paths.
 */
function cliPrefixFor(instance: ResolvedInstance): string {
  const isClaude = instance.driver === CLAUDE_DRIVER_KIND;
  const binary = instance.binaryPath.trim() || (isClaude ? "claude" : "codex");
  if (instance.configDir.length === 0) return binary;
  const variable = isClaude ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  return `${variable}=${instance.configDir} ${binary}`;
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
    const resolvedHome = yield* resolveClaudeHomePath({ homePath: configDir });
    resolved.push({
      instanceId,
      driver: CLAUDE_DRIVER_KIND,
      displayName: entry.displayName?.trim() || rawInstanceId,
      binaryPath: config.binaryPath,
      configDir,
      resolvedHome,
      environment: mergeProviderInstanceEnvironment(entry.environment),
      requiredEnvNames: (entry.environment ?? []).map((variable) => variable.name),
    });
  }

  return resolved;
});

const resolveCodexInstances = Effect.fn("ProviderMcpServers.resolveCodexInstances")(function* () {
  const settings = yield* ServerSettingsService;
  const current = yield* settings.getSettings;

  const resolved: Array<ResolvedInstance> = [];
  for (const [rawInstanceId, entry] of Object.entries(current.providerInstances)) {
    if (entry.driver !== CODEX_DRIVER_KIND) continue;
    const config = decodeCodexSettings(entry.config ?? {});
    const layout = yield* resolveCodexHomeLayout(config);
    // Codex keeps auth.json private to a shadow home but symlinks config.toml
    // back to the shared one, so a write through the shadow lands in the
    // shared server list. That is the intent: sign-ins are per account,
    // servers are not.
    resolved.push({
      instanceId: rawInstanceId as ProviderInstanceId,
      driver: CODEX_DRIVER_KIND,
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

  const contents = yield* fileSystem.readFileString(configPath).pipe(Effect.option);
  // A missing file is the normal state for a freshly provisioned instance, not
  // an error worth surfacing: it simply has no servers yet.
  if (contents._tag === "None") return { ...base, servers: [] };

  const parsed = yield* decodeJson(contents.value).pipe(Effect.option);
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
        return canonicalToEntry(name, codexEntryToCanonical(record));
      })
      .filter((entry) => entry.name.length > 0)
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
});

const listMcpServers = Effect.fn("ProviderMcpServers.list")(function* () {
  const instances = yield* resolveInstances();
  const inventories: Array<McpInstanceInventory> = [];
  for (const instance of instances) {
    inventories.push(
      yield* instance.driver === CLAUDE_DRIVER_KIND
        ? readClaudeInventory(instance)
        : readCodexInventory(instance),
    );
  }
  return { instances: inventories };
});

const runProviderMcp = Effect.fn("ProviderMcpServers.runProviderMcp")(function* (input: {
  readonly instance: ResolvedInstance;
  readonly args: ReadonlyArray<string>;
}) {
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
    for (const instanceId of input.instanceIds) {
      const instance = yield* findInstance(instanceId);
      const plan = addArgsFor(instance, input.name, server, input.json);
      if ("reason" in plan) {
        outcomes.push({ instanceId, ok: false, message: plan.reason });
        continue;
      }
      outcomes.push((yield* runProviderMcp({ instance, args: plan.args })).outcome);
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
  return yield* applyServerToInstances({
    instanceIds: input.toInstanceIds.filter((id) => id !== input.fromInstanceId),
    name: input.name,
    json,
  });
});

const removeMcpServer = Effect.fn("ProviderMcpServers.remove")(function* (input: {
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly name: string;
}) {
  const outcomes: Array<McpMutationOutcome> = [];
  for (const instanceId of input.instanceIds) {
    const instance = yield* findInstance(instanceId);
    outcomes.push(
      (yield* runProviderMcp({ instance, args: removeArgsFor(instance, input.name) })).outcome,
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

  // Every operation re-reads settings. Accounts are added and signed out while
  // the app runs, and this backs a settings page, not a hot path.
  return ProviderMcpServers.of({
    list: () => listMcpServers().pipe(Effect.provide(context)),
    add: (input) => addMcpServer(input).pipe(Effect.provide(context)),
    remove: (input) => removeMcpServer(input).pipe(Effect.provide(context)),
    copy: (input) => copyMcpServer(input).pipe(Effect.provide(context)),
  });
});

export const layer = Layer.effect(ProviderMcpServers, make());
