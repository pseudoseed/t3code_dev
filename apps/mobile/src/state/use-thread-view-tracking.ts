import { useFocusEffect } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadNeedsViewRecord } from "@t3tools/client-runtime/state/thread-read-state";
import { useCallback, useEffect, useRef } from "react";

import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom } from "./server";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

// Older servers reject the command outright, so a thread open there must not
// fire a doomed round trip. Read from the registry rather than a hook: this
// is checked inside a callback, not during render.
function environmentRecordsReadState(
  environmentId: EnvironmentThreadShell["environmentId"],
): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadReadState === true
  );
}

/**
 * Tell the server this device has the thread on screen, so the unread
 * indicator clears everywhere rather than only here.
 *
 * Records on focus and again whenever a turn completes while the thread stays
 * open — the two moments at which "you have seen this" changes. Streaming
 * activity is deliberately ignored: unread is defined by a COMPLETED turn, so
 * a turn still running writes nothing. Blur clears the guard so a record that
 * could not reach an offline server is retried the next time the user looks.
 */
export function useRecordThreadView(thread: EnvironmentThreadShell | null) {
  // A read receipt is not worth an error toast; the next focus retries.
  const recordView = useAtomCommand(threadEnvironment.view, {
    label: "thread view",
    reportFailure: false,
  });
  // Seeded from the first render and advanced in the effect below, so the
  // focus callback can read the current shell without depending on it.
  const threadRef = useRef(thread);
  const focusedRef = useRef(false);
  // One record per (thread, completion): re-renders while the thread is open
  // must not re-send a receipt the server already has.
  const recordedRef = useRef<string | null>(null);

  const sync = useCallback(() => {
    const current = threadRef.current;
    if (!focusedRef.current || current === null) return;
    if (!environmentRecordsReadState(current.environmentId)) return;
    if (!threadNeedsViewRecord(current)) return;
    const key = `${current.environmentId}:${current.id}:${current.latestTurn?.completedAt ?? ""}`;
    if (recordedRef.current === key) return;
    recordedRef.current = key;
    void recordView({ environmentId: current.environmentId, input: { threadId: current.id } });
  }, [recordView]);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      sync();
      return () => {
        focusedRef.current = false;
        recordedRef.current = null;
      };
    }, [sync]),
  );

  // A turn completing while the thread is open counts as read.
  useEffect(() => {
    threadRef.current = thread;
    sync();
  }, [sync, thread]);
}
