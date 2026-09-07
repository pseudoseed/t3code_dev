import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { ProcessRunner, type ProcessRunOutput } from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { PtyAdapter } from "../terminal/PtyAdapter.ts";
import { make } from "./ProviderMcpServers.ts";

const decodeSettings = Schema.decodeEffect(ServerSettings);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const work = ProviderInstanceId.make("claude_work");
const personal = ProviderInstanceId.make("claude_personal");
const full = {
  accessToken: "access-fixture",
  refreshToken: "refresh-fixture",
  expiresAt: 1_800_000_000_000,
  scope: "read",
  serverUrl: "https://mcp.example.com",
  discoveryState: { retained: true },
};

const makeFixture = Effect.fn("McpServers.test.makeFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped();
  const sourceDir = `${dir}/source`;
  const targetDir = `${dir}/target`;
  for (const home of [sourceDir, targetDir]) {
    yield* fs.makeDirectory(home);
    yield* fs.writeFileString(
      `${home}/.claude.json`,
      encode({ mcpServers: { posthog: { type: "http", url: "https://mcp.example.com" } } }),
    );
  }
  yield* fs.writeFileString(
    `${sourceDir}/.credentials.json`,
    encode({
      claudeAiOauth: { accessToken: "source-account" },
      mcpOAuth: { "posthog|samehash": full, "plugin:stripe:stripe|hash": full },
    }),
  );
  yield* fs.writeFileString(
    `${targetDir}/.credentials.json`,
    encode({
      claudeAiOauth: { accessToken: "target-account" },
      mcpOAuth: {
        "posthog|samehash": { accessToken: "access-fixture" },
        "plugin:stripe:stripe|hash": full,
      },
    }),
  );
  yield* fs.writeFileString(
    `${targetDir}/mcp-needs-auth-cache.json`,
    encode({ posthog: { seen: 1 }, "plugin:figma:figma": { seen: 2 } }),
  );
  const settings = yield* decodeSettings({
    providerInstances: {
      [work]: {
        driver: "claudeAgent",
        enabled: true,
        config: { homePath: targetDir },
        displayName: "Work",
      },
      [personal]: {
        driver: "claudeAgent",
        enabled: true,
        config: { homePath: sourceDir },
        displayName: "Personal",
      },
    },
  });
  const service = yield* make().pipe(
    Effect.provide(ServerConfig.layerTest(dir, `${dir}/state`)),
    Effect.provideService(
      ServerSettingsService,
      ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.succeed(settings),
        updateSettings: () => Effect.succeed(settings),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      }),
    ),
    Effect.provideService(
      ProcessRunner,
      ProcessRunner.of({
        run: () =>
          Effect.succeed({
            stdout: "",
            stderr: "",
            code: 0 as ProcessRunOutput["code"],
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
      }),
    ),
    Effect.provideService(
      PtyAdapter,
      PtyAdapter.of({ spawn: () => Effect.die("This test must not launch a sign-in") }),
    ),
    Effect.provideService(HostProcessEnvironment, { CLAUDE_CONFIG_DIR: sourceDir }),
    Effect.provideService(HostProcessPlatform, "linux"),
  );
  return { service, fs, sourceDir, targetDir };
});

it.layer(NodeServices.layer)("MCP settings operations", (it) => {
  it.effect(
    "lists broken and plugin connections with actionable status without sending tokens",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeFixture();
        const inventory = yield* service.list();
        const servers = inventory.instances.find(
          (instance) => instance.instanceId === work,
        )!.servers;
        expect(servers.find((server) => server.name === "posthog")).toMatchObject({
          authStatus: "needsAuth",
          canManageDefinition: true,
        });
        expect(servers.find((server) => server.name === "plugin:stripe:stripe")).toMatchObject({
          authStatus: "stored",
          canManageDefinition: false,
        });
        expect(servers.find((server) => server.name === "plugin:figma:figma")).toMatchObject({
          authStatus: "needsAuth",
          canManageDefinition: false,
        });
        expect(encode(inventory)).not.toContain("access-fixture");
        expect(encode(inventory)).not.toContain("refresh-fixture");
        expect(encode(inventory)).not.toContain("target-account");
      }).pipe(Effect.scoped),
  );
  it.effect(
    "repairs the chosen account and refreshes its status while preserving the source and account session",
    () =>
      Effect.gen(function* () {
        const { service, fs, targetDir, sourceDir } = yield* makeFixture();
        const sourceBefore = yield* fs.readFileString(`${sourceDir}/.credentials.json`);
        expect(
          (yield* service.repair({ instanceIds: [work], name: "posthog" })).outcomes[0]?.ok,
        ).toBe(true);
        expect(decode(yield* fs.readFileString(`${targetDir}/.credentials.json`))).toMatchObject({
          claudeAiOauth: { accessToken: "target-account" },
          mcpOAuth: { "posthog|samehash": full },
        });
        expect(yield* fs.readFileString(`${sourceDir}/.credentials.json`)).toBe(sourceBefore);
        expect(decode(yield* fs.readFileString(`${targetDir}/mcp-needs-auth-cache.json`))).toEqual({
          "plugin:figma:figma": { seen: 2 },
        });
        const inventory = yield* service.list();
        expect(
          inventory.instances
            .find((instance) => instance.instanceId === work)
            ?.servers.find((server) => server.name === "posthog")?.authStatus,
        ).toBe("stored");
      }).pipe(Effect.scoped),
  );
  it.effect("reports each account even when one target no longer exists", () =>
    Effect.gen(function* () {
      const { service } = yield* makeFixture();
      const missing = ProviderInstanceId.make("claude_removed");
      const result = yield* service.add({
        instanceIds: [work, missing, personal],
        name: "new-server",
        json: '{"type":"http","url":"https://example.com"}',
      });
      expect(result.outcomes.map((outcome) => [outcome.instanceId, outcome.ok])).toEqual([
        [work, true],
        [missing, false],
        [personal, true],
      ]);
      expect(result.outcomes[1]?.message).toContain("claude_removed");
    }).pipe(Effect.scoped),
  );
  it.effect(
    "copies the full OAuth record with the definition, keeping the target account's sign-in",
    () =>
      Effect.gen(function* () {
        const { service, fs, targetDir } = yield* makeFixture();
        const result = yield* service.copy({
          fromInstanceId: personal,
          toInstanceIds: [work],
          name: "posthog",
        });
        expect(result.outcomes[0]?.ok).toBe(true);
        expect(decode(yield* fs.readFileString(`${targetDir}/.credentials.json`))).toMatchObject({
          claudeAiOauth: { accessToken: "target-account" },
          mcpOAuth: { "posthog|samehash": full },
        });
      }).pipe(Effect.scoped),
  );
});
