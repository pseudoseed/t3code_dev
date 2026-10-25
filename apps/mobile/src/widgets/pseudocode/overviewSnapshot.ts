import { selectWidgetActivities } from "@t3tools/shared/agentAwareness";
import type { AgentWidgetSnapshot } from "../agentWidgetSnapshot";

/** Bounded by WidgetKit's App Group defaults and extension memory; 5 rows are visible. */
const PROJECT_ICON_LIMIT = 8;

const projectIconKey = (row: AgentWidgetSnapshot["activities"][number]) =>
  row.projectId != null ? `${row.environmentId}:${row.projectId}` : null;

/**
 * Icons belong to a project, not a turn. They resolve only while the app is open,
 * so every write carries the last known bitmap forward in `projectIcons`, including
 * for projects that a background push rotated out of the visible rows.
 */
export function carryProjectIcons(
  snapshot: AgentWidgetSnapshot,
  previous?: AgentWidgetSnapshot,
): AgentWidgetSnapshot {
  const icons = new Map(Object.entries(previous?.projectIcons ?? {}));
  for (const row of [...(previous?.activities ?? []), ...snapshot.activities]) {
    const key = projectIconKey(row);
    if (!key || !row.projectIcon) continue;
    icons.delete(key);
    icons.set(key, row.projectIcon);
  }
  const projectIcons = Object.fromEntries([...icons].slice(-PROJECT_ICON_LIMIT));
  const activities = snapshot.activities.map((row) => {
    if (row.projectIcon) return row;
    const key = projectIconKey(row);
    const icon = key
      ? projectIcons[key]
      : [...snapshot.activities, ...(previous?.activities ?? [])].find(
          (other) =>
            other.projectIcon &&
            other.environmentId === row.environmentId &&
            other.threadId === row.threadId,
        )?.projectIcon;
    return icon ? { ...row, projectIcon: icon } : row;
  });
  return { ...snapshot, activities, projectIcons };
}

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
      return { ...row, ...(cached?.summary && !row.summary ? { summary: cached.summary } : {}) };
    }),
  };
}
