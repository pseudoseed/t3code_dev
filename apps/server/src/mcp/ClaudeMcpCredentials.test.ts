import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

import { ProcessRunner, type ProcessRunOutput } from "../processRunner.ts";
import {
  claudeCredentialService,
  copyMcpRecords,
  clearClaudeMcpAuthCache,
  readClaudeCredentials,
  repairMcpRecords,
  writeClaudeCredentials,
} from "./ClaudeMcpCredentials.ts";

const fullRecord = {
  accessToken: "access-fixture",
  clientId: "client-fixture",
  discoveryState: { authorizationServerUrl: "https://auth.example.com" },
  expiresAt: 1_800_000_000_000,
  issuer: "https://auth.example.com",
  redirectUri: "http://localhost:1234/callback",
  refreshToken: "refresh-fixture",
  scope: "read write",
  serverName: "posthog",
  serverUrl: "https://mcp.example.com",
  futureField: { retained: true },
};
const { expiresAt: _expiry, refreshToken: _refresh, scope: _scope, ...truncated } = fullRecord;
const source = {
  claudeAiOauth: { accessToken: "source-account" },
  mcpOAuth: { "posthog|samehash": fullRecord },
};
const destination = {
  claudeAiOauth: { accessToken: "destination-account" },
  otherData: { keep: true },
  mcpOAuth: {
    "posthog|samehash": truncated,
    "stripe|stripehash": { ...fullRecord, refreshToken: "destination-stripe" },
    futureEntry: null,
  },
};

describe("MCP credential repair", () => {
  it("restores complete records without stripping current or future fields or replacing the account", () => {
    const result = repairMcpRecords(source, destination, "posthog");
    expect(result.repaired).toBe(1);
    expect(result.credentials).toEqual({
      ...destination,
      mcpOAuth: { ...destination.mcpOAuth, "posthog|samehash": fullRecord },
    });
    expect(source.mcpOAuth["posthog|samehash"]).toEqual(fullRecord);
    expect(destination.mcpOAuth["posthog|samehash"]).toEqual(truncated);
  });
  it("copies all OAuth fields into a new home while preserving unrelated credentials", () => {
    const target = { claudeAiOauth: destination.claudeAiOauth, mcpOAuth: { futureEntry: null } };
    const result = copyMcpRecords(source, target, "posthog");
    expect(result.copied).toBe(1);
    expect(result.credentials).toEqual({
      ...target,
      mcpOAuth: { ...target.mcpOAuth, "posthog|samehash": fullRecord },
    });
  });
  it("keeps a destination's independently refreshed authorization", () => {
    const target = {
      mcpOAuth: { "posthog|samehash": { ...fullRecord, refreshToken: "newer-destination-token" } },
    };
    expect(repairMcpRecords(source, target, "posthog")).toEqual({
      credentials: target,
      repaired: 0,
    });
  });
  it("does not borrow refresh tokens from a different configuration or an incomplete source", () => {
    expect(
      repairMcpRecords(
        { mcpOAuth: { "posthog|differenthash": fullRecord } },
        destination,
        "posthog",
      ).repaired,
    ).toBe(0);
    expect(
      repairMcpRecords({ mcpOAuth: { "posthog|samehash": truncated } }, destination, "posthog")
        .repaired,
    ).toBe(0);
    expect(repairMcpRecords(source, destination, "stripe").repaired).toBe(0);
  });
  it("matches Claude's default and isolated keychain service names", () => {
    expect(claudeCredentialService("")).toBe("Claude Code-credentials");
    expect(claudeCredentialService("/Users/chris/.t3/userdata/provider-homes/claude_aws")).toBe(
      "Claude Code-credentials-d5ef59da",
    );
    expect(
      claudeCredentialService("/Users/chris/.t3/userdata/provider-homes/claudeAgent_placrd"),
    ).toBe("Claude Code-credentials-7c41cce6");
  });
});

function output(stdout: string, code = 0): ProcessRunOutput {
  return {
    stdout,
    stderr: "",
    code: code as ProcessRunOutput["code"],
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  };
}
const noKeychain = ProcessRunner.of({
  run: () => Effect.die("The file store must not invoke security"),
});

it.layer(NodeServices.layer)("native credential stores", (it) => {
  it.effect(
    "persists Linux credentials privately, retaining refresh fields, and clears only the repaired cache entry",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(`${home}/.credentials.json`, encodeJson(destination));
        yield* fs.writeFileString(
          `${home}/mcp-needs-auth-cache.json`,
          '{"posthog":{"seen":1},"stripe":{"seen":2}}',
        );
        const store = yield* readClaudeCredentials(home);
        const repaired = repairMcpRecords(source, store.credentials, "posthog");
        yield* writeClaudeCredentials(home, { ...store, credentials: repaired.credentials });
        yield* clearClaudeMcpAuthCache(home, "posthog");
        expect((yield* readClaudeCredentials(home)).credentials).toEqual(repaired.credentials);
        expect((yield* fs.stat(`${home}/.credentials.json`)).mode & 0o777).toBe(0o600);
        expect(decodeJson(yield* fs.readFileString(`${home}/mcp-needs-auth-cache.json`))).toEqual({
          stripe: { seen: 2 },
        });
        expect(yield* fs.readDirectory(home)).toEqual(
          expect.arrayContaining([".credentials.json", "mcp-needs-auth-cache.json"]),
        );
      }).pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(ProcessRunner, noKeychain),
        Effect.scoped,
      ),
  );
  it.effect("reports malformed credentials instead of treating them as an empty store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${home}/.credentials.json`, "{broken");
      expect((yield* readClaudeCredentials(home).pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* fs.readFileString(`${home}/.credentials.json`)).toBe("{broken");
    }).pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(ProcessRunner, noKeychain),
      Effect.scoped,
    ),
  );
  it.effect(
    "uses the macOS keychain and verifies a complete write beyond the interactive command length limit",
    () =>
      Effect.gen(function* () {
        let stored = encodeJson(destination);
        const repaired = {
          ...repairMcpRecords(source, destination, "posthog").credentials,
          largeFutureField: "x".repeat(5000),
        };
        const runner = ProcessRunner.of({
          run: (input) =>
            Effect.sync(() => {
              if (input.args[0] === "add-generic-password") {
                stored = input.args.at(-1)!;
                expect(stored).toContain("refresh-fixture");
                expect(stored).toContain("destination-account");
                expect(stored).not.toContain("source-account");
                expect(stored.length).toBeGreaterThan(4096);
                return output("");
              }
              expect(input.args).toEqual([
                "find-generic-password",
                "-s",
                claudeCredentialService("/fixture/home"),
                "-w",
              ]);
              return output(stored);
            }),
        });
        yield* Effect.gen(function* () {
          const store = yield* readClaudeCredentials("/fixture/home");
          expect(store.kind).toBe("keychain");
          yield* writeClaudeCredentials("/fixture/home", { ...store, credentials: repaired });
          expect((yield* readClaudeCredentials("/fixture/home")).credentials).toEqual(repaired);
        }).pipe(Effect.provideService(ProcessRunner, runner));
      }).pipe(Effect.provideService(HostProcessPlatform, "darwin")),
  );
  it.effect("does not fall back to files when the macOS keychain is locked", () =>
    readClaudeCredentials("/fixture/home").pipe(
      Effect.result,
      Effect.tap((result) => Effect.sync(() => expect(result._tag).toBe("Failure"))),
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provideService(
        ProcessRunner,
        ProcessRunner.of({ run: () => Effect.succeed(output("", 36)) }),
      ),
    ),
  );
});
