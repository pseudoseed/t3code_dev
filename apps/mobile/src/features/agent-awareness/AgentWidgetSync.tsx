import { ProjectIconSync } from "../../widgets/pseudocode/ProjectIconSync";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { environmentCatalog } from "../../connection/catalog";
import { useProjects, useThreadShells } from "../../state/entities";
import { environmentShellSummaryAtom } from "../../state/shell";
import { agentWidgetContentKey, buildAgentWidgetSnapshot } from "../../widgets/agentWidgetSnapshot";
import { supportsAgentAwarenessPush } from "./capabilities";
import { saveWidgetSnapshot } from "../../widgets/widgetStorage";

/** Updates the shared widget snapshot from existing connections, including
 * direct connections without a Cloud Connect account. No transcript subscriptions. */
function IosAgentWidgetSync() {
  const projects = useProjects();
  const threads = useThreadShells();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const shell = useAtomValue(environmentShellSummaryAtom);
  const previousContent = useRef<string | null>(null);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const onIcon = useCallback(
    (key: string, icon: string | null) =>
      setIcons((previous) => {
        if (previous[key] === (icon ?? undefined)) return previous;
        const next = { ...previous };
        if (icon) next[key] = icon;
        else delete next[key];
        return Object.fromEntries(Object.entries(next).slice(-32));
      }),
    [],
  );
  const threadIndex = useMemo(
    () => new Map(threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread])),
    [threads],
  );
  const snapshot = useMemo(() => {
    const snapshot = buildAgentWidgetSnapshot({ projects, threads });
    return {
      ...snapshot,
      activities: snapshot.activities.map((row) => {
        const thread = threadIndex.get(`${row.environmentId}:${row.threadId}`);
        const projectIcon = thread
          ? icons[`${thread.environmentId}:${thread.projectId}`]
          : undefined;
        return { ...row, ...(projectIcon ? { projectIcon } : {}) };
      }),
    };
  }, [projects, threads, icons, threadIndex]);
  const contentKey = agentWidgetContentKey(snapshot);
  const canPublish =
    catalog.isReady &&
    (catalog.entries.size === 0 || (shell.hasSnapshot && !shell.hasSynchronizingShell));

  useEffect(() => {
    // Register the gallery layout even before a server snapshot is available.
    if (canPublish && previousContent.current === contentKey) return;
    let cancelled = false;
    void Promise.all([
      import("../../widgets/AgentWidget"),
      import("../../widgets/pseudocode/OverviewWidget"),
    ])
      .then(async () => {
        if (cancelled || !canPublish) return;
        await saveWidgetSnapshot(snapshot);
        previousContent.current = contentKey;
      })
      .catch((error: unknown) => {
        console.warn("Could not update the agent widget", error);
      });
    return () => {
      cancelled = true;
    };
  }, [canPublish, contentKey, snapshot]);
  const visibleProjectKeys = new Set(
    snapshot.activities.map((row) => {
      const thread = threadIndex.get(`${row.environmentId}:${row.threadId}`);
      return `${row.environmentId}:${thread?.projectId}`;
    }),
  );
  const visibleProjects = projects.filter((project) =>
    visibleProjectKeys.has(`${project.environmentId}:${project.id}`),
  );
  return visibleProjects.map((project) => (
    <ProjectIconSync
      key={`${project.environmentId}:${project.id}`}
      project={project}
      onIcon={onIcon}
    />
  ));
}

export function AgentWidgetSync() {
  return Platform.OS === "ios" && supportsAgentAwarenessPush() ? <IosAgentWidgetSync /> : null;
}
