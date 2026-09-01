import type { IssueListEntry, IssueListState } from "@t3tools/contracts";

export const ISSUE_STATE_FILTERS: ReadonlyArray<{
  readonly value: IssueListState;
  readonly label: string;
}> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

export const ISSUE_SORTS = [
  { value: "recent", label: "Recent" },
  { value: "oldest", label: "Oldest" },
  { value: "comments", label: "Discussed" },
] as const;

export type IssueSort = (typeof ISSUE_SORTS)[number]["value"];

/**
 * Rows as the panel shows them.
 *
 * Newest change first by default, which is the order somebody scanning a list expects and the
 * order every host reports its own "recently updated" in. The other two answer the two
 * questions a list of issues actually gets asked: what has been sitting here longest, and what
 * is being argued about.
 */
export function sortIssues(
  entries: ReadonlyArray<IssueListEntry>,
  sort: IssueSort = "recent",
): ReadonlyArray<IssueListEntry> {
  const rows = [...entries];
  switch (sort) {
    case "oldest":
      return rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    case "comments":
      // A host that reports no counts leaves every row at zero, so this falls back to recency
      // rather than shuffling the list into an order that means nothing.
      return rows.sort(
        (left, right) =>
          right.commentCount - left.commentCount || right.updatedAt.localeCompare(left.updatedAt),
      );
    case "recent":
      return rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}

/**
 * What a search box narrows locally.
 *
 * Only used for a host that does not search its own issues: where one does, it has already
 * matched bodies this cannot see, and narrowing again would hide rows it deliberately returned.
 */
export function narrowIssues(
  entries: ReadonlyArray<IssueListEntry>,
  query: string,
): ReadonlyArray<IssueListEntry> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return entries;
  return entries.filter(
    (entry) =>
      entry.title.toLowerCase().includes(needle) ||
      String(entry.number) === needle.replace(/^#/u, "") ||
      entry.labels.some((label) => label.name.toLowerCase().includes(needle)),
  );
}

/** "3 comments", or nothing at all where the host does not count them. */
export function formatCommentCount(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? "comment" : "comments"}`;
}

/** A label colour as CSS, guarding against whatever a host chose to put in that field. */
export function labelColor(color: string | null): string | undefined {
  if (color === null) return undefined;
  const hex = color.trim().replace(/^#/u, "");
  return /^[0-9a-f]{3}$|^[0-9a-f]{6}$/iu.test(hex) ? `#${hex}` : undefined;
}

/**
 * An issue as a block of context for the composer.
 *
 * The whole thing rather than a link: an agent handed a URL has to go and fetch it, and it
 * cannot — the panel read it with the reader's own credentials. Comments are included because
 * the argument in them is usually the part worth acting on, and the description alone often is
 * not the current state of the question.
 */
export function issueContextForComposer(issue: {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly repository: string;
  readonly body: string;
  readonly comments: ReadonlyArray<{
    readonly author: { readonly login: string } | null;
    readonly body: string;
  }>;
}): string {
  const lines = [
    `## ${issue.repository}#${issue.number}: ${issue.title}`,
    "",
    `State: ${issue.state}`,
    `Link: ${issue.url}`,
    "",
    issue.body.trim().length > 0 ? issue.body.trim() : "_No description._",
  ];
  for (const comment of issue.comments) {
    lines.push(
      "",
      `### Comment from ${comment.author?.login ?? "unknown"}`,
      "",
      comment.body.trim(),
    );
  }
  return lines.join("\n");
}

/**
 * The composer's new contents once an issue is added.
 *
 * Appended rather than replacing: whatever was already typed is the reader's, and an issue is
 * context for it rather than a substitute.
 */
export function appendIssueContext(prompt: string, context: string): string {
  const existing = prompt.trimEnd();
  return existing.length === 0 ? `${context}\n\n` : `${existing}\n\n${context}\n\n`;
}
