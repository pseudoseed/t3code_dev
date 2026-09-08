import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getMailboxThreadCandidates } from "./mailboxCandidates.ts";

const environmentId = EnvironmentId.make("local");
const otherEnvironmentId = EnvironmentId.make("remote");
const projectId = ProjectId.make("pseudoapps");
const stagingProjectId = ProjectId.make("entriq");
const currentThreadId = ThreadId.make("current");
const projects = [
  { id: projectId, environmentId, title: "Pseudoapps" },
  { id: stagingProjectId, environmentId, title: "Entriq" },
  { id: stagingProjectId, environmentId: otherEnvironmentId, title: "Remote project" },
];

function thread(id: string, title = id) {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId,
    title,
    archivedAt: null,
    settledOverride: null,
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    latestUserMessageAt: null,
  };
}

type Candidate = Parameters<typeof getMailboxThreadCandidates>[0]["threads"][number];
const infrastructure = thread("infrastructure", "Placard Infrastructure Changes");
const staging = {
  ...thread("staging", "Build out Staging Env for Placrd"),
  projectId: stagingProjectId,
  latestUserMessageAt: "2026-09-08T00:00:00.000Z",
};
const settled = {
  ...thread("settled", "Older staging setup"),
  settledOverride: "settled" as const,
};

function candidates(
  threads: ReadonlyArray<Candidate>,
  search = "",
  linkedThreadIds: ThreadId[] = [],
) {
  return getMailboxThreadCandidates({
    threads,
    projects,
    environmentId,
    threadId: currentThreadId,
    linkedThreadIds,
    search,
  });
}

describe("mailbox thread candidates", () => {
  it("shows active threads across projects immediately, most recent first", () => {
    expect(candidates([infrastructure, settled, staging], "  ").map((entry) => entry.id)).toEqual([
      staging.id,
      infrastructure.id,
    ]);
  });

  it("excludes the current thread, archived threads, linked peers, and other environments", () => {
    expect(
      candidates(
        [
          thread(currentThreadId),
          infrastructure,
          staging,
          { ...thread("archived"), archivedAt: "2026-09-08T00:00:00.000Z" },
          { ...staging, environmentId: otherEnvironmentId },
        ],
        "",
        [infrastructure.id],
      ),
    ).toEqual([staging]);
  });

  it("matches trimmed, case-insensitive words across project and thread names", () => {
    expect(candidates([infrastructure, staging], "  STAGING   Entriq  ")).toEqual([staging]);
    expect(candidates([infrastructure, staging], "changes pseudoapps")).toEqual([infrastructure]);
    expect(candidates([staging], "remote")).toEqual([]);
    expect(candidates([staging], "Build out Staging Env for Placrd")).toEqual([staging]);
    expect(candidates([staging], "Entriq / Build out Staging Env for Placrd")).toEqual([staging]);
  });

  it("includes settled threads when searching, after equally matching active threads", () => {
    expect(candidates([settled, staging], "staging")).toEqual([staging, settled]);
    expect(candidates([settled], "nothing")).toEqual([]);
  });

  it("keeps every match available to the client for pagination", () => {
    const threads = Array.from({ length: 25 }, (_, index) => thread(`staging-${index}`));
    const matches = candidates([...threads, staging], "staging");
    expect(matches).toHaveLength(26);
    expect(matches[0]).toEqual(staging);
    expect(new Set(matches.map((entry) => entry.id)).size).toBe(26);
  });

  it("ranks an exact thread title ahead of project-name matches", () => {
    const exact = thread("exact", "Entriq");
    expect(candidates([staging, exact], "entriq")).toEqual([exact, staging]);
  });

  it("returns a peer to the picker after unlinking", () => {
    expect(candidates([infrastructure, staging], "staging", [staging.id])).toEqual([]);
    expect(candidates([infrastructure, staging], "staging", [])).toEqual([staging]);
  });
});
