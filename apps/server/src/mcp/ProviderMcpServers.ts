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
  McpCliUnavailableError,
  McpInstanceNotFoundError,
  McpServerNotFoundError,
  type McpInstanceInventory,
  type McpMutationOutcome,
  type McpServerEntry,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { resolveProviderCredentialHome } from "../provider/providerCredentialHome.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { ServerSettingsService } from "../serverSettings.ts";

// The Claude driver registers itself as `claudeAgent`; `claude` is the CLI
// name, not the driver kind. See Drivers/ClaudeDriver.ts.
const CLAUDE_DRIVER_KIND = "claudeAgent";
/** Decoder for the JSON blobs this module reads out of `.claude.json`. */
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(UnknownFromJsonString);
const encodeJson = Schema.encodeUnknownEffect(UnknownFromJsonString);
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

/**
 * `claude mcp` writes and reads a small JSON file. Two seconds is generous for
 * that and short enough that one wedged instance cannot stall the whole page.
 */
const CLI_TIMEOUT_MS = 20_000;

interface ResolvedInstance {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly binaryPath: string;
  /** Empty when the instance uses Claude's own default home. */
  readonly configDir: string;
  /** Absolute directory holding `.claude.json`, default home included. */
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
  const binary = instance.binaryPath.trim() || "claude";
  if (instance.configDir.length === 0) return binary;
  return `CLAUDE_CONFIG_DIR=${instance.configDir} ${binary}`;
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
      displayName: entry.displayName?.trim() || rawInstanceId,
      binaryPath: config.binaryPath,
      configDir,
      resolvedHome,
      environment: mergeProviderInstanceEnvironment(entry.environment),
      requiredEnvNames: (entry.environment ?? []).map((variable) => variable.name),
    });
  }

  return resolved.sort((left, right) => left.displayName.localeCompare(right.displayName));
});

const findInstance = Effect.fn("ProviderMcpServers.findInstance")(function* (
  instanceId: ProviderInstanceId,
) {
  const instances = yield* resolveClaudeInstances();
  const match = instances.find((instance) => instance.instanceId === instanceId);
  if (!match) return yield* new McpInstanceNotFoundError({ instanceId });
  return match;
});

/**
 * Reduce a raw config entry to what the UI needs. Env and header *values* are
 * dropped here rather than in the UI: `.claude.json` routinely holds bearer
 * tokens, and this payload crosses the websocket to every paired browser and
 * phone.
 */
export function toServerEntry(name: string, raw: unknown): McpServerEntry {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const declaredType = typeof record.type === "string" ? record.type : undefined;
  const url = typeof record.url === "string" ? record.url : undefined;
  const command = typeof record.command === "string" ? record.command : undefined;
  const args = Array.isArray(record.args) ? record.args.filter((a) => typeof a === "string") : [];
  const env =
    typeof record.env === "object" && record.env !== null ? (record.env as object) : undefined;
  const headers =
    typeof record.headers === "object" && record.headers !== null
      ? (record.headers as object)
      : undefined;

  return {
    name,
    transport: declaredType ?? (url ? "http" : command ? "stdio" : "unknown"),
    target: url ?? [command ?? "", ...args].join(" ").trim(),
    envKeys: env ? Object.keys(env) : [],
    headerKeys: headers ? Object.keys(headers) : [],
  };
}

const readInstanceInventory = Effect.fn("ProviderMcpServers.readInstanceInventory")(function* (
  instance: ResolvedInstance,
): Effect.fn.Return<McpInstanceInventory, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(instance.resolvedHome, ".claude.json");

  const base = {
    instanceId: instance.instanceId,
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
      .map(([name, raw]) => toServerEntry(name, raw))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
});

export const listMcpServers = Effect.fn("ProviderMcpServers.list")(function* () {
  const instances = yield* resolveClaudeInstances();
  const inventories: Array<McpInstanceInventory> = [];
  for (const instance of instances) {
    inventories.push(yield* readInstanceInventory(instance));
  }
  return { instances: inventories };
});

const runClaudeMcp = Effect.fn("ProviderMcpServers.runClaudeMcp")(function* (input: {
  readonly instance: ResolvedInstance;
  readonly args: ReadonlyArray<string>;
}) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const binaryPath = input.instance.binaryPath.trim() || "claude";
  const result = yield* runner
    .run({
      command: binaryPath,
      args: ["mcp", ...input.args],
      timeout: CLI_TIMEOUT_MS,
      env: {
        ...input.instance.environment,
        ...(input.instance.configDir.length > 0
          ? { CLAUDE_CONFIG_DIR: input.instance.configDir }
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
    instanceId: input.instance.instanceId,
    ok: result.code === 0,
    // Claude reports "already exists" and validation failures on stderr; the
    // user needs the real text or the row just says "failed".
    message:
      result.code === 0 ? "" : (result.stderr.trim() || result.stdout.trim()).slice(0, 2_000),
  } satisfies McpMutationOutcome;
});

/**
 * Add one server definition to several instances. Instances are applied in
 * sequence rather than in parallel: `claude mcp` rewrites a whole JSON file,
 * and two instances that share a home would race each other.
 */
export const addMcpServer = Effect.fn("ProviderMcpServers.add")(function* (input: {
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly name: string;
  readonly json: string;
}) {
  const outcomes: Array<McpMutationOutcome> = [];
  for (const instanceId of input.instanceIds) {
    const instance = yield* findInstance(instanceId);
    outcomes.push(
      yield* runClaudeMcp({
        instance,
        args: ["add-json", "--scope", "user", input.name, input.json],
      }),
    );
  }
  return { outcomes };
});

/**
 * Read one server's full definition, secrets included. Only ever consumed by
 * `copyMcpServer`, which hands it straight back to the CLI on another
 * instance, so the values never reach a client.
 */
const readRawServerDefinition = Effect.fn("ProviderMcpServers.readRawServerDefinition")(function* (
  instance: ResolvedInstance,
  name: string,
) {
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
export const copyMcpServer = Effect.fn("ProviderMcpServers.copy")(function* (input: {
  readonly fromInstanceId: ProviderInstanceId;
  readonly toInstanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly name: string;
}) {
  const source = yield* findInstance(input.fromInstanceId);
  const json = yield* readRawServerDefinition(source, input.name);

  const outcomes: Array<McpMutationOutcome> = [];
  for (const instanceId of input.toInstanceIds) {
    if (instanceId === input.fromInstanceId) continue;
    const instance = yield* findInstance(instanceId);
    outcomes.push(
      yield* runClaudeMcp({
        instance,
        args: ["add-json", "--scope", "user", input.name, json],
      }),
    );
  }
  return { outcomes };
});

export const removeMcpServer = Effect.fn("ProviderMcpServers.remove")(function* (input: {
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly name: string;
}) {
  const outcomes: Array<McpMutationOutcome> = [];
  for (const instanceId of input.instanceIds) {
    const instance = yield* findInstance(instanceId);
    outcomes.push(
      yield* runClaudeMcp({ instance, args: ["remove", "--scope", "user", input.name] }),
    );
  }
  return { outcomes };
});
