import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useRef } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import type { TerminalPaneDockPosition } from "./ThreadTerminalPane";

/**
 * Where the workspace terminal pane lives, persisted per device. Defaults to
 * the trailing column, matching the other workspace panes.
 */
export function useTerminalPaneDockPosition() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const dockPosition: TerminalPaneDockPosition =
    loaded && preferencesResult.value.terminalPaneDockPosition === "bottom" ? "bottom" : "right";
  // The ref advances before persistence starts, so consecutive presses always
  // toggle the latest value even before the optimistic patch renders.
  const dockPositionRef = useRef(dockPosition);
  dockPositionRef.current = dockPosition;

  const toggleDockPosition = useCallback(() => {
    const next: TerminalPaneDockPosition =
      dockPositionRef.current === "bottom" ? "right" : "bottom";
    dockPositionRef.current = next;
    savePreferences({ terminalPaneDockPosition: next });
    return next;
  }, [savePreferences]);

  return { dockPosition, toggleDockPosition } as const;
}
