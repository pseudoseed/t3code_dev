import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo, useRef } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/**
 * Persisted per-project section state for the iPad sidebar.
 *
 * Collapse is stored as the folded set rather than the expanded set, so a
 * project added later starts open instead of silently hidden. Like the shelf
 * preferences, writes advance a ref first so consecutive taps toggle the
 * latest value without waiting for a render.
 */
export function useThreadListV2ProjectSections() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const enabled = !loaded || preferencesResult.value.sidebarProjectSectionsEnabled !== false;
  const collapsedKeys = useMemo(
    () => new Set(loaded ? (preferencesResult.value.collapsedSidebarProjectSections ?? []) : []),
    [loaded, preferencesResult],
  );
  const collapsedKeysRef = useRef(collapsedKeys);
  collapsedKeysRef.current = collapsedKeys;

  const toggleProjectSection = useCallback(
    (projectKey: string) => {
      if (!loaded) return;
      const next = new Set(collapsedKeysRef.current);
      if (next.has(projectKey)) next.delete(projectKey);
      else next.add(projectKey);
      collapsedKeysRef.current = next;
      savePreferences({ collapsedSidebarProjectSections: [...next] });
    },
    [loaded, savePreferences],
  );

  return { loaded, enabled, collapsedKeys, toggleProjectSection } as const;
}
