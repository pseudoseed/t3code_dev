// @effect-diagnostics nodeBuiltinImport:off - Claude's keychain service uses Node's SHA-256 path hash.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ProcessRunner } from "../processRunner.ts";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeObject = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject));
const encodeObject = Schema.encodeEffect(Schema.fromJsonString(JsonObject));
const readObject = Schema.decodeUnknownOption(JsonObject);

export class ClaudeMcpCredentialError extends Schema.TaggedError<ClaudeMcpCredentialError>()(
  "ClaudeMcpCredentialError",
  { message: Schema.String },
) {}

/** Config dirs are normalized before hashing, exactly as they are passed to Claude. */
export function claudeCredentialService(configDir: string): string {
  return `Claude Code-credentials${configDir ? `-${NodeCrypto.createHash("sha256").update(configDir).digest("hex").slice(0, 8)}` : ""}`;
}

export function mcpRecords(
  credentials: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const records = readObject(credentials.mcpOAuth);
  if (records._tag === "None") return {};
  return Object.fromEntries(
    Object.entries(records.value).flatMap(([key, raw]) => {
      const record = readObject(raw);
      return record._tag === "Some" ? [[key, record.value]] : [];
    }),
  );
}

export function mcpRecordName(key: string): string {
  const separator = key.lastIndexOf("|");
  return separator > 0 ? key.slice(0, separator) : "";
}

export function hasRefreshMaterial(record: Record<string, unknown>): boolean {
  return (
    typeof record.accessToken === "string" &&
    record.accessToken.length > 0 &&
    typeof record.refreshToken === "string" &&
    record.refreshToken.length > 0 &&
    typeof record.expiresAt === "number"
  );
}

/** Repair only existing, identically keyed records. Never transfer the Claude account session. */
export function repairMcpRecords(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  name: string,
) {
  const sourceRecords = mcpRecords(source);
  const targetRecords = mcpRecords(target);
  const replacements = Object.entries(targetRecords).filter(
    ([key, record]) =>
      mcpRecordName(key) === name &&
      !hasRefreshMaterial(record) &&
      sourceRecords[key] !== undefined &&
      hasRefreshMaterial(sourceRecords[key]),
  );
  if (replacements.length === 0) return { credentials: target, repaired: 0 };
  const rawTarget = readObject(target.mcpOAuth);
  return {
    credentials: {
      ...target,
      mcpOAuth: {
        ...(rawTarget._tag === "Some" ? rawTarget.value : {}),
        ...Object.fromEntries(replacements.map(([key]) => [key, sourceRecords[key]])),
      },
    },
    repaired: replacements.length,
  };
}

/** Called only after the same complete server definition has been copied by Claude's CLI. */
export function copyMcpRecords(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  name: string,
) {
  const sourceRecords = mcpRecords(source);
  const targetRecords = mcpRecords(target);
  const matching = Object.entries(sourceRecords).filter(([key]) => mcpRecordName(key) === name);
  const copied = matching.filter(
    ([key]) => !targetRecords[key] || !hasRefreshMaterial(targetRecords[key]),
  );
  const rawTarget = readObject(target.mcpOAuth);
  return {
    credentials: {
      ...target,
      mcpOAuth: {
        ...(rawTarget._tag === "Some" ? rawTarget.value : {}),
        ...Object.fromEntries(copied),
      },
    },
    copied: copied.length,
  };
}

/** Read the native store; an unreadable store must never be mistaken for an empty one. */
export const readClaudeCredentials = Effect.fn("readClaudeCredentials")(
  function* (configDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    if (platform === "darwin") {
      const runner = yield* ProcessRunner;
      const result = yield* runner.run({
        command: "/usr/bin/security",
        args: ["find-generic-password", "-s", claudeCredentialService(configDir), "-w"],
        outputMode: "error",
      });
      if (result.code === 0)
        return { kind: "keychain" as const, credentials: yield* decodeObject(result.stdout) };
      // errSecItemNotFound is the only keychain failure eligible for file fallback.
      if (result.code !== 44)
        return yield* new ClaudeMcpCredentialError({
          message:
            "Could not read the Claude credential keychain item. Unlock the login keychain and retry.",
        });
    }
    const file = path.join(
      configDir || path.join(NodeOS.homedir(), ".claude"),
      ".credentials.json",
    );
    const contents = yield* fs
      .readFileString(file)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
        ),
      );
    return { kind: "file" as const, credentials: yield* decodeObject(contents) };
  },
  Effect.mapError(
    () =>
      new ClaudeMcpCredentialError({
        message:
          "Could not read Claude credentials. Check file permissions or unlock the login keychain.",
      }),
  ),
);

/** Replace only the selected store, preserving all unknown fields and account credentials. */
export const writeClaudeCredentials = Effect.fn("writeClaudeCredentials")(
  function* (
    configDir: string,
    store: { kind: "keychain" | "file"; credentials: Record<string, unknown> },
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const json = yield* encodeObject(store.credentials);
    if (store.kind === "keychain") {
      const runner = yield* ProcessRunner;
      // Interactive `security -i` truncates lines at 4096 bytes. Use direct argv
      // so a home with many connectors is written in full; ProcessRunner never logs argv.
      const result = yield* runner.run({
        command: "/usr/bin/security",
        args: [
          "add-generic-password",
          "-U",
          "-s",
          claudeCredentialService(configDir),
          "-a",
          NodeOS.userInfo().username,
          "-w",
          json,
        ],
        outputMode: "error",
      });
      if (result.code !== 0)
        return yield* new ClaudeMcpCredentialError({
          message: "Could not update the Claude credential keychain item.",
        });
      const saved = yield* readClaudeCredentials(configDir);
      if ((yield* encodeObject(saved.credentials)) !== json)
        return yield* new ClaudeMcpCredentialError({
          message: "The Claude credential repair was not saved.",
        });
      return;
    }
    const dir = configDir || path.join(NodeOS.homedir(), ".claude");
    const temporary = yield* fs.makeTempFile({ directory: dir, prefix: ".credentials-" });
    yield* Effect.gen(function* () {
      yield* fs.chmod(temporary, 0o600);
      yield* fs.writeFileString(temporary, json);
      yield* fs.rename(temporary, path.join(dir, ".credentials.json"));
    }).pipe(Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)));
  },
  Effect.mapError(
    () =>
      new ClaudeMcpCredentialError({
        message:
          "Could not save Claude credentials. Check file permissions or unlock the login keychain.",
      }),
  ),
);

export const clearClaudeMcpAuthCache = Effect.fn("clearClaudeMcpAuthCache")(
  function* (configDir: string, name: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(
      configDir || path.join(NodeOS.homedir(), ".claude"),
      "mcp-needs-auth-cache.json",
    );
    const contents = yield* fs
      .readFileString(file)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
        ),
      );
    const cache = { ...(yield* decodeObject(contents)) };
    if (!(name in cache)) return;
    delete cache[name];
    yield* writeFileStringAtomically({ filePath: file, contents: yield* encodeObject(cache) });
  },
  Effect.mapError(
    () =>
      new ClaudeMcpCredentialError({
        message:
          "Credentials were saved, but Claude's authorization cache could not be cleared. Check file permissions.",
      }),
  ),
);
