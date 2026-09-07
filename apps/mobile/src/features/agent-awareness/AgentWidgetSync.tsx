import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useRef } from "react";
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
  const snapshot = useMemo(
    () => buildAgentWidgetSnapshot({ projects, threads }),
    [projects, threads],
  );
  const contentKey = agentWidgetContentKey(snapshot);
  const canPublish =
    catalog.isReady &&
    (catalog.entries.size === 0 || (shell.hasSnapshot && !shell.hasSynchronizingShell));

  useEffect(() => {
    // Register the gallery layout even before a server snapshot is available.
    if (canPublish && previousContent.current === contentKey) return;
    let cancelled = false;
    void import("../../widgets/AgentWidget")
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
  return null;
}

export function AgentWidgetSync() {
  return Platform.OS === "ios" && supportsAgentAwarenessPush() ? <IosAgentWidgetSync /> : null;
}
