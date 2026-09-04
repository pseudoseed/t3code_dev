import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";

import { readEnvironmentSupportsThreadReadState } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { unreadVisitedAtFor, useUiStateStore } from "../uiStateStore";

interface MarkUnreadThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly latestTurn: { readonly completedAt: string | null } | null;
}

/**
 * "I have not actually read this." Rewinds read state on the server so the
 * thread reads as unread on every surface, and mirrors it into this browser's
 * local record for servers that predate server-side read state.
 */
export function useMarkThreadUnread() {
  const markThreadUnreadLocally = useUiStateStore((state) => state.markThreadUnread);
  const recordThreadView = useAtomCommand(threadEnvironment.view, {
    label: "thread mark unread",
    reportFailure: false,
  });

  return useCallback(
    (thread: MarkUnreadThread) => {
      const completedAt = thread.latestTurn?.completedAt ?? null;
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      markThreadUnreadLocally(threadKey, completedAt);
      const viewedAt = unreadVisitedAtFor(completedAt);
      if (viewedAt === null) return;
      // Older servers reject the command; the local record above is all they
      // get, which is what they had before read state moved to the server.
      if (!readEnvironmentSupportsThreadReadState(thread.environmentId)) return;
      void recordThreadView({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, viewedAt },
      });
    },
    [markThreadUnreadLocally, recordThreadView],
  );
}
