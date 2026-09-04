import { describe, expect, it } from "vite-plus/test";

import {
  findAuthorizationUrl,
  findDeviceUserCode,
  stripAnsi,
  summarizeCliFailure,
} from "./cliLoginOutput.ts";

const CLAUDE_HOSTS = ["claude.com", "claude.ai", "anthropic.com"];
const CODEX_HOSTS = ["openai.com", "chatgpt.com"];

// Captured from `claude auth login` and `codex login --device-auth` with stdout
// piped. These are the exact shapes the controller has to read.
const CLAUDE_URL_LINE =
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&state=T9iV1GS8";
const CODEX_URL_LINE = "   \u001B[94mhttps://auth.openai.com/codex/device\u001B[0m";
const CODEX_CODE_LINE = "   \u001B[94mUNK7-0HJFF\u001B[0m";

describe("stripAnsi", () => {
  it("removes the color codes both CLIs emit to a pipe", () => {
    expect(stripAnsi(CODEX_CODE_LINE).trim()).toBe("UNK7-0HJFF");
  });
});

describe("findAuthorizationUrl", () => {
  it("reads the Claude sign-in URL out of its prose line", () => {
    expect(findAuthorizationUrl(CLAUDE_URL_LINE, CLAUDE_HOSTS)).toBe(
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&state=T9iV1GS8",
    );
  });

  it("reads the Codex device URL through its color codes", () => {
    expect(findAuthorizationUrl(CODEX_URL_LINE, CODEX_HOSTS)).toBe(
      "https://auth.openai.com/codex/device",
    );
  });

  it("accepts a subdomain of an allowed host", () => {
    expect(findAuthorizationUrl("visit https://auth.openai.com/x", ["openai.com"])).toBe(
      "https://auth.openai.com/x",
    );
  });

  it("ignores a URL on a host the provider does not serve sign-in from", () => {
    expect(findAuthorizationUrl("see https://evil.example/auth", CLAUDE_HOSTS)).toBeUndefined();
  });

  it("ignores a lookalike host that only suffixes an allowed one", () => {
    expect(findAuthorizationUrl("https://notclaude.com/a", CLAUDE_HOSTS)).toBeUndefined();
  });

  it("ignores plaintext http even on an allowed host", () => {
    expect(findAuthorizationUrl("http://claude.com/a", CLAUDE_HOSTS)).toBeUndefined();
  });

  it("drops sentence punctuation that follows the URL", () => {
    expect(findAuthorizationUrl("go to https://claude.com/a.", CLAUDE_HOSTS)).toBe(
      "https://claude.com/a",
    );
  });

  it("returns nothing for the ordinary prose lines around the link", () => {
    expect(findAuthorizationUrl("Opening browser to sign in…", CLAUDE_HOSTS)).toBeUndefined();
  });
});

describe("findDeviceUserCode", () => {
  it("reads the one-time code off its own line", () => {
    expect(findDeviceUserCode(CODEX_CODE_LINE)).toBe("UNK7-0HJFF");
  });

  it("ignores a code embedded in prose, which is never how it is printed", () => {
    expect(findDeviceUserCode("Enter this code: UNK7-0HJFF")).toBeUndefined();
  });

  it("ignores lines that are not codes", () => {
    expect(findDeviceUserCode("2. Enter this one-time code")).toBeUndefined();
    expect(findDeviceUserCode("")).toBeUndefined();
  });
});

describe("summarizeCliFailure", () => {
  it("keeps the last meaningful line", () => {
    const output = "Opening browser\nPaste code here if prompted > Login failed: status code 400\n";
    expect(summarizeCliFailure(output)).toBe(
      "Paste code here if prompted > Login failed: status code 400",
    );
  });

  it("redacts a URL so a failure message cannot leak PKCE state", () => {
    const output = `failed after visiting https://claude.com/cai/oauth/authorize?state=secret\n`;
    const summary = summarizeCliFailure(output);
    expect(summary).toBe("failed after visiting [link]");
    expect(summary).not.toContain("secret");
  });

  it("truncates a long line", () => {
    expect(summarizeCliFailure(`${"x".repeat(500)}\n`, 20)).toHaveLength(20);
  });

  it("returns nothing when the command printed nothing usable", () => {
    expect(summarizeCliFailure("\n  \n")).toBeUndefined();
  });
});
