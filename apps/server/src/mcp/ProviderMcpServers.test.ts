import { describe, expect, it } from "@effect/vitest";

import { toServerEntry } from "./ProviderMcpServers.ts";

describe("toServerEntry", () => {
  it("keeps credential key names and drops their values", () => {
    const entry = toServerEntry("uxpilot", {
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.example.com/mcp"],
      env: { AUTH_HEADER: "Bearer ep_super_secret" },
    });

    expect(entry.envKeys).toEqual(["AUTH_HEADER"]);
    expect(JSON.stringify(entry)).not.toContain("ep_super_secret");
  });

  it("drops header values on remote servers", () => {
    const entry = toServerEntry("sentry", {
      type: "http",
      url: "https://mcp.sentry.dev/mcp",
      headers: { Authorization: "Bearer token-abc" },
    });

    expect(entry.headerKeys).toEqual(["Authorization"]);
    expect(entry.target).toBe("https://mcp.sentry.dev/mcp");
    expect(JSON.stringify(entry)).not.toContain("token-abc");
  });

  it("infers stdio from a command and http from a url when type is absent", () => {
    expect(toServerEntry("a", { command: "uvx", args: ["thing"] }).transport).toBe("stdio");
    expect(toServerEntry("b", { url: "https://example.com" }).transport).toBe("http");
    expect(toServerEntry("c", {}).transport).toBe("unknown");
  });

  it("renders a stdio command line as the target", () => {
    expect(toServerEntry("a", { command: "uvx", args: ["--from", "pkg", "run"] }).target).toBe(
      "uvx --from pkg run",
    );
  });
});
