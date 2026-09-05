import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * MCP server management, scoped to one provider instance's credential home.
 *
 * T3 Code never parses or writes Claude Code's precedence rules. Reads take
 * the `mcpServers` object straight off `<home>/.claude.json` (user scope), and
 * every write shells out to `claude mcp` so the CLI stays the only thing that
 * decides what a valid entry is.
 */

const McpServerNameSchema = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/**
 * One configured server. Secret-bearing values (env values, header values,
 * OAuth tokens) are deliberately absent; only their key names travel, so the
 * UI can show that a server carries credentials without leaking them to every
 * paired browser and phone.
 */
export const McpServerEntry = Schema.Struct({
  name: Schema.String,
  /** `stdio`, `http`, `sse`, or `ws` as declared, or `unknown` when absent. */
  transport: Schema.String,
  /** Command line for stdio servers, URL for remote ones. */
  target: Schema.String,
  /** Env var names handed to a stdio server. Values are never sent. */
  envKeys: Schema.Array(Schema.String),
  /** Header names sent to a remote server. Values are never sent. */
  headerKeys: Schema.Array(Schema.String),
});
export type McpServerEntry = typeof McpServerEntry.Type;

export const McpInstanceInventory = Schema.Struct({
  instanceId: ProviderInstanceId,
  displayName: Schema.String,
  /** Resolved `CLAUDE_CONFIG_DIR`, or the user's default home when unset. */
  configDir: Schema.String,
  /** Ready-to-paste shell prefix that reproduces this instance's context. */
  cliPrefix: Schema.String,
  /**
   * Names of the environment variables this account's sign-in depends on. An
   * account authorized through `CLAUDE_CODE_OAUTH_TOKEN` keeps its credential
   * in T3 Code's settings rather than on disk, so a bare shell running the
   * same `CLAUDE_CONFIG_DIR` is a signed-out account. Names only; the values
   * stay on the machine.
   */
  requiredEnvNames: Schema.Array(Schema.String),
  servers: Schema.Array(McpServerEntry),
  /** Present when this instance's config could not be read. */
  readError: Schema.optional(Schema.String),
});
export type McpInstanceInventory = typeof McpInstanceInventory.Type;

export const McpInventory = Schema.Struct({
  instances: Schema.Array(McpInstanceInventory),
});
export type McpInventory = typeof McpInventory.Type;

/** Applying to several instances at once is the point: one server, every account. */
const McpTargetInstances = Schema.Array(ProviderInstanceId).check(Schema.isMinLength(1));

export const McpAddInput = Schema.Struct({
  instanceIds: McpTargetInstances,
  name: McpServerNameSchema,
  /** Server definition handed to `claude mcp add-json` verbatim. */
  json: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
});
export type McpAddInput = Schema.Codec.Encoded<typeof McpAddInput>;

/**
 * Copy one server definition from an instance that already has it onto
 * others. The definition never leaves the server, which is what makes this
 * safe for entries that carry bearer tokens in `env` or `headers`.
 */
export const McpCopyInput = Schema.Struct({
  fromInstanceId: ProviderInstanceId,
  toInstanceIds: McpTargetInstances,
  name: McpServerNameSchema,
});
export type McpCopyInput = Schema.Codec.Encoded<typeof McpCopyInput>;

export const McpRemoveInput = Schema.Struct({
  instanceIds: McpTargetInstances,
  name: McpServerNameSchema,
});
export type McpRemoveInput = Schema.Codec.Encoded<typeof McpRemoveInput>;

/**
 * Per-instance outcome. A write that fails on one account must not hide the
 * ones that succeeded, so this reports every instance rather than failing the
 * whole call.
 */
export const McpMutationOutcome = Schema.Struct({
  instanceId: ProviderInstanceId,
  ok: Schema.Boolean,
  /** CLI stderr on failure, empty on success. */
  message: Schema.String,
});
export type McpMutationOutcome = typeof McpMutationOutcome.Type;

export const McpMutationResult = Schema.Struct({
  outcomes: Schema.Array(McpMutationOutcome),
});
export type McpMutationResult = typeof McpMutationResult.Type;

export class McpInstanceNotFoundError extends Schema.TaggedErrorClass<McpInstanceNotFoundError>()(
  "McpInstanceNotFoundError",
  {
    instanceId: Schema.String,
  },
) {
  override get message() {
    return `No Claude provider instance with id: ${this.instanceId}`;
  }
}

export class McpCliUnavailableError extends Schema.TaggedErrorClass<McpCliUnavailableError>()(
  "McpCliUnavailableError",
  {
    instanceId: Schema.String,
    binaryPath: Schema.String,
  },
) {
  override get message() {
    return `Could not run the Claude CLI at ${this.binaryPath} for instance: ${this.instanceId}`;
  }
}

export class McpServerNotFoundError extends Schema.TaggedErrorClass<McpServerNotFoundError>()(
  "McpServerNotFoundError",
  {
    instanceId: Schema.String,
    name: Schema.String,
  },
) {
  override get message() {
    return `Instance ${this.instanceId} has no MCP server named: ${this.name}`;
  }
}

export const McpError = Schema.Union([
  McpInstanceNotFoundError,
  McpCliUnavailableError,
  McpServerNotFoundError,
]);
export type McpError = typeof McpError.Type;
