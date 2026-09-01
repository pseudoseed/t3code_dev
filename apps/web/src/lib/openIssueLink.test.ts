import { describe, expect, it } from "vite-plus/test";

import { parseIssueUrl } from "./openIssueLink";

describe("parseIssueUrl", () => {
  it("reads a GitHub issue", () => {
    expect(parseIssueUrl("https://github.com/T3Tools/T3Code/issues/123")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
  });

  it("reads an issue on a self-hosted Forgejo, which has no hostname to check", () => {
    expect(parseIssueUrl("https://git.acme.test/acme/web/issues/42")).toEqual({
      host: "git.acme.test",
      repository: "acme/web",
      number: 42,
    });
  });

  it("leaves a pull request alone, which the change-request matcher owns", () => {
    expect(parseIssueUrl("https://github.com/acme/web/pull/42")).toBeNull();
    expect(parseIssueUrl("https://git.acme.test/acme/web/pulls/42")).toBeNull();
  });

  it("refuses anything that is not one issue", () => {
    expect(parseIssueUrl("https://github.com/acme/web/issues")).toBeNull();
    expect(parseIssueUrl("https://github.com/acme/web/issues/new")).toBeNull();
    expect(parseIssueUrl("javascript:alert(1)")).toBeNull();
    expect(parseIssueUrl("not a url")).toBeNull();
  });
});
