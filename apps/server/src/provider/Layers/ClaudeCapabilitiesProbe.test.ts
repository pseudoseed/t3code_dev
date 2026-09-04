import { ClaudeSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES,
  hasClaudeAccountEvidence,
  probeClaudeCapabilities,
} from "./ClaudeProvider.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it("isolates Claude capability probes without dropping workspace setting sources", () => {
  const abortController = new AbortController();
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController,
    environment: {
      HOME: "/home/user",
      ENABLE_CLAUDEAI_MCP_SERVERS: "true",
      FORCE_CODE_TERMINAL: "1",
    },
    cwd: "/workspace/project",
  });

  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.cwd, "/workspace/project");
  assert.deepEqual(options.settingSources, [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES]);
  assert.deepEqual(options.settings, { disableAllHooks: true });
  assert.deepEqual(options.allowedTools, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.pathToClaudeCodeExecutable, "/usr/bin/claude");
  assert.equal(options.abortController, abortController);
  assert.equal(options.env?.HOME, "/home/user");
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  assert.equal(options.env?.FORCE_CODE_TERMINAL, undefined);
  assert.equal(options.env?.CLAUDE_CODE_AUTO_CONNECT_IDE, "0");
  assert.equal(options.env?.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL, "1");
});

it.layer(NodeServices.layer)("Claude capability probe SDK boundary", (it) => {
  it.effect("serializes strict no-MCP options and still resolves account capabilities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-sdk-" });
      const executablePath = path.join(tempDir, "fake-claude.mjs");
      const invocationPath = path.join(tempDir, "invocation.json");
      const workspaceCwd = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspaceCwd, { recursive: true });

      yield* fs.writeFileString(
        executablePath,
        [
          "#!/usr/bin/env node",
          'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
          'import { createInterface } from "node:readline";',
          "const args = process.argv.slice(2);",
          'const mcpConfigIndex = args.indexOf("--mcp-config");',
          "const rawMcpConfig = mcpConfigIndex >= 0 ? args[mcpConfigIndex + 1] : undefined;",
          "let mcpConfig;",
          "if (rawMcpConfig) {",
          '  const contents = existsSync(rawMcpConfig) ? readFileSync(rawMcpConfig, "utf8") : rawMcpConfig;',
          "  try { mcpConfig = JSON.parse(contents); } catch { mcpConfig = contents; }",
          "}",
          "writeFileSync(process.env.T3_PROBE_INVOCATION_PATH, JSON.stringify({",
          "  args,",
          "  cwd: process.cwd(),",
          "  connectorEnv: process.env.ENABLE_CLAUDEAI_MCP_SERVERS,",
          "  mcpConfig,",
          "}));",
          "const lines = createInterface({ input: process.stdin });",
          'lines.on("line", (line) => {',
          "  const message = JSON.parse(line);",
          '  if (message.type !== "control_request") return;',
          "  const reply = (response) => process.stdout.write(JSON.stringify({",
          '    type: "control_response",',
          '    response: { subtype: "success", request_id: message.request_id, response },',
          '  }) + "\\n");',
          '  if (message.request?.subtype === "initialize") {',
          "    reply({",
          '      commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],',
          "      agents: [],",
          '      output_style: "default",',
          '      available_output_styles: ["default"],',
          "      models: [],",
          '      account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },',
          "    });",
          "  }",
          "  // The probe follows initialize with get_usage on the same process.",
          '  if (message.request?.subtype === "get_usage") {',
          "    reply({",
          "      session: {},",
          '      subscription_type: "pro",',
          "      rate_limits_available: true,",
          '      rate_limits: { five_hour: { utilization: 12, resets_at: "2026-07-18T14:39:00Z" } },',
          "      behaviors: null,",
          "    });",
          "  }",
          "});",
          "setInterval(() => {}, 1_000);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(executablePath, 0o755);

      const capabilities = yield* probeClaudeCapabilities(
        decodeClaudeSettings({ binaryPath: executablePath }),
        {
          ...process.env,
          T3_PROBE_INVOCATION_PATH: invocationPath,
          ENABLE_CLAUDEAI_MCP_SERVERS: "true",
        },
        workspaceCwd,
      );

      assert.deepEqual(capabilities, {
        email: "dev@example.com",
        subscriptionType: "pro",
        tokenSource: "oauth",
        apiProvider: undefined,
        slashCommands: [
          {
            name: "review",
            description: "Review changes",
            input: { hint: "[path]" },
          },
        ],
        usage: {
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 12, resets_at: "2026-07-18T14:39:00Z" } },
        },
      });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const invocation = JSON.parse(yield* fs.readFileString(invocationPath)) as {
        readonly args: ReadonlyArray<string>;
        readonly cwd: string;
        readonly connectorEnv: string;
        readonly mcpConfig: unknown;
      };
      assert.equal(invocation.cwd, yield* fs.realPath(workspaceCwd));
      assert.equal(invocation.connectorEnv, "false");
      assert.equal(invocation.args.includes("--strict-mcp-config"), true);
      assert.equal(invocation.args.includes("--mcp-config"), false);
      assert.equal(invocation.mcpConfig, undefined);

      assert.equal(invocation.args.includes("--setting-sources=user,project,local"), true);

      const settingsFlagIndex = invocation.args.indexOf("--settings");
      assert.notEqual(settingsFlagIndex, -1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const flagSettings = JSON.parse(invocation.args[settingsFlagIndex + 1] ?? "{}") as {
        readonly disableAllHooks?: boolean;
      };
      assert.equal(flagSettings.disableAllHooks, true);
    }).pipe(Effect.scoped),
  );
});

// A capabilities probe succeeds whenever the runtime starts, which is not the
// same as the config directory holding a sign-in. Instances get their own
// `CLAUDE_CONFIG_DIR`, so a fresh one probes clean and must not read as
// authenticated.
// Captured by probing one config directory each way on Claude Code 2.1.260.
it("treats the SDK's signed-out shape as signed out", () => {
  assert.equal(
    hasClaudeAccountEvidence({
      email: undefined,
      subscriptionType: undefined,
      // The SDK names the absence of credentials rather than omitting it.
      tokenSource: "none",
      apiProvider: "firstParty",
    }),
    false,
  );
});

it("treats the SDK's signed-in shape as signed in", () => {
  assert.equal(
    hasClaudeAccountEvidence({
      email: "user@example.com",
      subscriptionType: "Claude Max",
      tokenSource: undefined,
      apiProvider: "firstParty",
    }),
    true,
  );
});

it("treats a probe with no account fields as signed out", () => {
  assert.equal(
    hasClaudeAccountEvidence({
      email: undefined,
      subscriptionType: undefined,
      tokenSource: undefined,
      apiProvider: "firstParty",
    }),
    false,
  );
  assert.equal(
    hasClaudeAccountEvidence({
      email: "   ",
      subscriptionType: "",
      tokenSource: undefined,
      apiProvider: undefined,
    }),
    false,
  );
});

it("treats any first-party account field as a sign-in", () => {
  const base = {
    email: undefined,
    subscriptionType: undefined,
    tokenSource: undefined,
    apiProvider: "firstParty",
  };

  assert.equal(hasClaudeAccountEvidence({ ...base, email: "user@example.com" }), true);
  assert.equal(hasClaudeAccountEvidence({ ...base, subscriptionType: "max" }), true);
  assert.equal(hasClaudeAccountEvidence({ ...base, tokenSource: "anthropicApiKey" }), true);
});

it("treats a third-party backend as authenticated without account fields", () => {
  // Bedrock and Vertex authenticate with external cloud credentials, so they
  // report no email or subscription by design.
  assert.equal(
    hasClaudeAccountEvidence({
      email: undefined,
      subscriptionType: undefined,
      tokenSource: undefined,
      apiProvider: "bedrock",
    }),
    true,
  );
});
