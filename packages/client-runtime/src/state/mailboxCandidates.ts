import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";
import { getThreadSortTimestamp } from "./threadSort.ts";

type MailboxThread = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "projectId"
  | "title"
  | "archivedAt"
  | "settledOverride"
  | "createdAt"
  | "updatedAt"
  | "latestUserMessageAt"
>;

/** Only unsettled threads are browsable, including when searching by project/title words. */
export function getMailboxThreadCandidates<T extends MailboxThread>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly projects: ReadonlyArray<Pick<EnvironmentProject, "id" | "environmentId" | "title">>;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly linkedThreadIds: ReadonlyArray<ThreadId>;
  readonly search: string;
}): T[] {
  const query = normalizeSearchQuery(input.search).replace(/\s+/g, " ");
  const words = query ? query.split(" ") : [];
  const linked = new Set(input.linkedThreadIds);
  const projectTitles = new Map(
    input.projects
      .filter((project) => project.environmentId === input.environmentId)
      .map((project) => [project.id, project.title]),
  );
  const candidates = [];
  for (const thread of input.threads) {
    if (
      thread.environmentId !== input.environmentId ||
      thread.id === input.threadId ||
      thread.archivedAt !== null ||
      linked.has(thread.id) ||
      thread.settledOverride === "settled"
    )
      continue;

    const title = normalizeSearchQuery(thread.title).replace(/\s+/g, " ");
    const searchable = `${projectTitles.get(thread.projectId) ?? ""} / ${title}`.toLowerCase();
    if (!words.every((word) => searchable.includes(word))) continue;
    candidates.push({
      thread,
      rank: !query || title === query ? 0 : title.includes(query) ? 1 : 2,
      timestamp: getThreadSortTimestamp(thread, "updated_at"),
    });
  }
  candidates.sort(
    (left, right) =>
      left.rank - right.rank ||
      right.timestamp - left.timestamp ||
      left.thread.id.localeCompare(right.thread.id),
  );
  return candidates.map(({ thread }) => thread);
}
