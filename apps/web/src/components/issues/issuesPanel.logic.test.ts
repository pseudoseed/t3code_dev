import { describe, expect, it } from "vite-plus/test";

import { formatCommentCount, labelColor, narrowIssues, sortIssues } from "./issuesPanel.logic";

const issue = (overrides: Partial<Parameters<typeof sortIssues>[0][number]> = {}) =>
  ({
    provider: "forgejo",
    host: "git.example.org",
    projectId: "00000000-0000-4000-8000-000000000000",
    projectTitle: "web",
    repository: "acme/web",
    number: 1,
    title: "Cache is never invalidated",
    url: "https://git.example.org/acme/web/issues/1",
    author: { login: "bilal", name: null, avatarUrl: null },
    state: "open",
    createdAt: "2026-06-16T05:00:00Z",
    updatedAt: "2026-06-16T05:00:00Z",
    commentCount: 0,
    labels: [],
    assignees: [],
    ...overrides,
  }) as Parameters<typeof sortIssues>[0][number];

describe("sortIssues", () => {
  it("puts the most recently changed first", () => {
    const rows = sortIssues([
      issue({ number: 1, updatedAt: "2026-06-16T05:00:00Z" }),
      issue({ number: 2, updatedAt: "2026-06-17T05:00:00Z" }),
      issue({ number: 3, updatedAt: "2026-06-15T05:00:00Z" }),
    ]);
    expect(rows.map((row) => row.number)).toEqual([2, 1, 3]);
  });
});

describe("narrowIssues", () => {
  const rows = [
    issue({ number: 1, title: "Cache is never invalidated" }),
    issue({ number: 42, title: "Sign in loops", labels: [{ name: "bug", color: null }] }),
  ];

  it("matches a title, a label, or the number itself", () => {
    expect(narrowIssues(rows, "cache").map((row) => row.number)).toEqual([1]);
    expect(narrowIssues(rows, "bug").map((row) => row.number)).toEqual([42]);
    expect(narrowIssues(rows, "#42").map((row) => row.number)).toEqual([42]);
  });

  it("returns everything for an empty search", () => {
    expect(narrowIssues(rows, "   ")).toHaveLength(2);
  });
});

describe("formatCommentCount", () => {
  it("says nothing where the host reported no count", () => {
    // Zero means "not asked", which is what `gh issue list` answers with.
    expect(formatCommentCount(0)).toBeNull();
    expect(formatCommentCount(1)).toBe("1 comment");
    expect(formatCommentCount(4)).toBe("4 comments");
  });
});

describe("labelColor", () => {
  it("takes a hex triplet with or without its hash, and refuses anything else", () => {
    expect(labelColor("d73a4a")).toBe("#d73a4a");
    expect(labelColor("#d73a4a")).toBe("#d73a4a");
    expect(labelColor("f00")).toBe("#f00");
    expect(labelColor("red; background: url(x)")).toBeUndefined();
    expect(labelColor(null)).toBeUndefined();
  });
});
