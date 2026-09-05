import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  addArgsFor,
  canonicalToEntry,
  codexEntryToCanonical,
  toCanonicalServer,
} from "./ProviderMcpServers.ts";

const claudeInstance = {
  instanceId: ProviderInstanceId.make("claude_aws"),
  driver: "claudeAgent",
  displayName: "Claude",
  binaryPath: "claude",
  configDir: "/homes/claude_aws",
  resolvedHome: "/homes/claude_aws",
  environment: {},
  requiredEnvNames: [],
} as const;

const codexInstance = { ...claudeInstance, driver: "codex", displayName: "Codex" } as const;

describe("inventory entries", () => {
  it("keeps credential key names and drops their values", () => {
    const entry = canonicalToEntry(
      "uxpilot",
      toCanonicalServer({
        command: "npx",
        args: ["-y", "mcp-remote"],
        env: { AUTH_HEADER: "Bearer ep_super_secret" },
      }),
    );

    expect(entry.envKeys).toEqual(["AUTH_HEADER"]);
    expect(JSON.stringify(entry)).not.toContain("ep_super_secret");
  });

  it("drops header values on remote servers", () => {
    const entry = canonicalToEntry(
      "sentry",
      toCanonicalServer({
        type: "http",
        url: "https://mcp.sentry.dev/mcp",
        headers: { Authorization: "Bearer token-abc" },
      }),
    );

    expect(entry.headerKeys).toEqual(["Authorization"]);
    expect(entry.target).toBe("https://mcp.sentry.dev/mcp");
    expect(JSON.stringify(entry)).not.toContain("token-abc");
  });

  it("infers stdio from a command and http from a url when type is absent", () => {
    expect(canonicalToEntry("a", toCanonicalServer({ command: "uvx" })).transport).toBe("stdio");
    expect(canonicalToEntry("b", toCanonicalServer({ url: "https://x" })).transport).toBe("http");
    expect(canonicalToEntry("c", toCanonicalServer({})).transport).toBe("unknown");
  });
});

describe("codex entries", () => {
  it("reads a streamable http server", () => {
    const server = codexEntryToCanonical({
      name: "posthog",
      transport: { type: "streamable_http", url: "https://mcp.posthog.com/mcp" },
    });

    expect(server.url).toBe("https://mcp.posthog.com/mcp");
    expect(canonicalToEntry("posthog", server).transport).toBe("http");
  });

  it("reads a stdio server with its env", () => {
    const server = codexEntryToCanonical({
      name: "xcodebuildmcp",
      transport: {
        type: "stdio",
        command: "npx",
        args: ["--yes", "xcodebuildmcp@2.6.2", "mcp"],
        env: { XCODEBUILDMCP_ENABLED_WORKFLOWS: "simulator" },
      },
    });

    expect(canonicalToEntry("xcodebuildmcp", server).target).toBe(
      "npx --yes xcodebuildmcp@2.6.2 mcp",
    );
    expect(server.env.XCODEBUILDMCP_ENABLED_WORKFLOWS).toBe("simulator");
  });
});

describe("addArgsFor", () => {
  const raw = '{"type":"http","url":"https://mcp.example.com/mcp"}';

  it("hands Claude the definition untouched", () => {
    const plan = addArgsFor(claudeInstance, "example", toCanonicalServer(JSON.parse(raw)), raw);
    expect(plan).toEqual({ args: ["add-json", "--scope", "user", "example", raw] });
  });

  it("translates a remote server into codex flags", () => {
    const plan = addArgsFor(codexInstance, "example", toCanonicalServer(JSON.parse(raw)), raw);
    expect(plan).toEqual({
      args: ["add", "example", "--url", "https://mcp.example.com/mcp"],
    });
  });

  it("translates a stdio server, carrying its env through", () => {
    const server = toCanonicalServer({
      command: "npx",
      args: ["-y", "thing"],
      env: { KEY: "value" },
    });
    const plan = addArgsFor(codexInstance, "thing", server, "{}");
    expect(plan).toEqual({
      args: ["add", "thing", "--env", "KEY=value", "--", "npx", "-y", "thing"],
    });
  });

  it("refuses a remote server whose headers codex cannot store", () => {
    const server = toCanonicalServer({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer secret" },
    });
    const plan = addArgsFor(codexInstance, "example", server, "{}");
    expect(plan).toHaveProperty("reason");
    expect(JSON.stringify(plan)).not.toContain("secret");
  });

  it("refuses a definition with neither a url nor a command", () => {
    expect(addArgsFor(codexInstance, "broken", toCanonicalServer({}), "{}")).toHaveProperty(
      "reason",
    );
  });
});
