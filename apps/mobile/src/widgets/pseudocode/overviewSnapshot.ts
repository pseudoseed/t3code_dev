import { selectWidgetActivities } from "@t3tools/shared/agentAwareness";
import type { AgentWidgetSnapshot } from "../agentWidgetSnapshot";

/** A cached shell or late icon load must not roll back a more recent server push. */
export function reconcileOverviewSnapshot(
  snapshot: AgentWidgetSnapshot,
  previous?: AgentWidgetSnapshot,
): AgentWidgetSnapshot {
  const environments = snapshot.environments?.map((current) => {
    const cached = previous?.environments?.find(
      (entry) => entry.environmentId === current.environmentId,
    );
    return cached?.snapshot.updatedAt &&
      (!current.snapshot.updatedAt || cached.snapshot.updatedAt > current.snapshot.updatedAt)
      ? cached
      : current;
  });
  const merged = environments
    ? {
        ...snapshot,
        environments,
        activeCount: environments.reduce((sum, entry) => sum + entry.snapshot.activeCount, 0),
        attentionCount: environments.reduce((sum, entry) => sum + entry.snapshot.attentionCount, 0),
        updatedAt: environments.reduce<string | null>(
          (latest, entry) =>
            entry.snapshot.updatedAt && (!latest || entry.snapshot.updatedAt > latest)
              ? entry.snapshot.updatedAt
              : latest,
          null,
        ),
        activities: selectWidgetActivities(
          environments.flatMap((entry) => entry.snapshot.activities),
          Date.now(),
        ).slice(0, 5),
      }
    : snapshot;
  return {
    ...merged,
    activities: merged.activities.map((row) => {
      const cached = previous?.activities.find(
        (other) =>
          other.environmentId === row.environmentId &&
          other.threadId === row.threadId &&
          other.phase === row.phase &&
          other.turnId === row.turnId,
      );
      // Icons belong to a project, not a turn. Keep the last resolved bitmap while
      // the app reconnects, including when a different thread becomes visible.
      const icon = [...snapshot.activities, ...(previous?.activities ?? [])].find(
        (other) =>
          other.projectIcon &&
          other.environmentId === row.environmentId &&
          (row.projectId != null
            ? other.projectId === row.projectId
            : other.threadId === row.threadId),
      )?.projectIcon;
      return {
        ...row,
        ...(cached?.summary && !row.summary ? { summary: cached.summary } : {}),
        ...(icon ? { projectIcon: icon } : {}),
      };
    }),
  };
}
