import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useEffect, useEffectEvent } from "react";

import { createAgentAttentionTracker, type AgentAttentionRequest } from "../agentAttention";
import {
  playAgentAttentionSound,
  showAgentAttentionNotification,
  unlockAgentAttentionAudio,
} from "../agentAttentionDelivery";
import { APP_DISPLAY_NAME } from "../branding";
import { environmentCatalog } from "../connection/catalog";
import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentShell } from "../state/shell";
import { buildThreadRouteParams } from "../threadRoutes";

function EnvironmentAttentionObserver({ environmentId }: { environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const deliver = useEffectEvent((requests: AgentAttentionRequest[]) => {
    const settings = getClientSettings();
    const delivered: Array<{ threadId: ThreadId; notification: Notification }> = [];
    if (requests.length === 0) return delivered;
    if (settings.agentAttentionSound) {
      void playAgentAttentionSound().catch((error: unknown) => {
        console.warn("Could not play attention sound", error);
      });
    }
    if (!settings.agentAttentionNotifications) return delivered;
    for (const request of requests) {
      const ref = scopeThreadRef(environmentId, request.threadId);
      try {
        const notification = showAgentAttentionNotification({
          title: `${APP_DISPLAY_NAME} — ${request.kind === "approval" ? "Approval needed" : "Input needed"}`,
          body: request.title,
          tag: `agent-attention:${scopedThreadKey(ref)}`,
          onClick: () => {
            void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
          },
          onError: () => console.warn("The system could not display an attention notification"),
        });
        if (notification) delivered.push({ threadId: request.threadId, notification });
      } catch (error) {
        console.warn("Could not show attention notification", error);
      }
    }
    return delivered;
  });

  useEffect(() => {
    const track = createAgentAttentionTracker();
    const notifications = new Map<ThreadId, Notification>();
    const atom = environmentShell.stateValueAtom(environmentId);
    const observe = (state: EnvironmentShellState) => {
      const threads = Option.isSome(state.snapshot) ? state.snapshot.value.threads : [];
      const requests = track(threads, state.status === "live");
      const pendingIds = new Set(
        threads
          .filter(
            (thread) =>
              thread.archivedAt === null &&
              (thread.hasPendingApprovals || thread.hasPendingUserInput),
          )
          .map((thread) => thread.id),
      );
      for (const [threadId, notification] of notifications) {
        if (!pendingIds.has(threadId)) {
          notification.close();
          notifications.delete(threadId);
        }
      }
      for (const request of requests) notifications.get(request.threadId)?.close();
      for (const { threadId, notification } of deliver(requests)) {
        notifications.set(threadId, notification);
        notification.addEventListener(
          "close",
          () => {
            if (notifications.get(threadId) === notification) notifications.delete(threadId);
          },
          { once: true },
        );
      }
    };
    const unsubscribe = appAtomRegistry.subscribe(atom, observe);
    observe(appAtomRegistry.get(atom));
    return () => {
      unsubscribe();
      for (const notification of notifications.values()) notification.close();
    };
  }, [environmentId]);

  return null;
}

export function AgentAttentionCoordinator() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const soundEnabled = useClientSettings((settings) => settings.agentAttentionSound);
  useEffect(() => {
    if (!soundEnabled) return;
    const removeListeners = () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    const unlock = () => {
      void unlockAgentAttentionAudio().catch(() => {
        // A later gesture can retry if this browser blocked audio activation.
      });
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return removeListeners;
  }, [soundEnabled]);

  return [...catalog.entries.keys()].map((environmentId) => (
    <EnvironmentAttentionObserver key={environmentId} environmentId={environmentId} />
  ));
}
