import { useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironments } from "../../state/environments";
import { useThreadShells } from "../../state/entities";
import { mobilePreferencesAtom } from "../../state/preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import { supportsAgentAwarenessPush } from "./capabilities";
import { disableDirectPush, rememberDirectPushToken, syncDirectPush } from "./directRegistration";
import {
  endLocalLiveActivities,
  updateAgentAwarenessRegistrationPreferences,
} from "./remoteRegistration";
import { runtime } from "../../lib/runtime";

export const directPushStatusAtom = Atom.make<ReadonlyMap<EnvironmentId, string>>(new Map());
function setStatus(id: EnvironmentId, status: string) {
  appAtomRegistry.set(
    directPushStatusAtom,
    new Map(appAtomRegistry.get(directPushStatusAtom)).set(id, status),
  );
}

function Coordinator() {
  const { environments } = useEnvironments();
  const threads = useThreadShells();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const [refresh, setRefresh] = useState(0);
  const enabled =
    AsyncResult.isSuccess(preferences) && preferences.value.directPushEnabled === true;
  const liveEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.directLiveActivitiesEnabled !== false;
  const loaded = AsyncResult.isSuccess(preferences);
  const chosen = loaded && preferences.value.directPushEnabled !== undefined;
  // Work on all environments, without transcript subscriptions or timestamp-only refreshes.
  const connectionKey = JSON.stringify(
    environments.map((entry) => [entry.environmentId, entry.connection.phase]),
  );
  const activityKey = JSON.stringify(
    threads.map((thread) => [
      thread.environmentId,
      thread.id,
      thread.archivedAt,
      thread.hasPendingApprovals,
      thread.hasPendingUserInput,
      thread.session?.status,
      thread.session?.activeTurnId,
      thread.latestTurn?.state,
      thread.title,
    ]),
  );

  useEffect(() => {
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") setRefresh((n) => n + 1);
    });
    const tokens = Notifications.addPushTokenListener((token) => {
      if (rememberDirectPushToken(token)) setRefresh((n) => n + 1);
    });
    return () => {
      app.remove();
      tokens.remove();
    };
  }, []);
  useEffect(() => {
    if (!enabled) return;
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
    return () => Notifications.setNotificationHandler(null);
  }, [enabled]);

  useEffect(() => {
    if (!chosen) return;
    if (enabled) endLocalLiveActivities("Could not close the Cloud Connect Live Activity.");
    void runtime
      .runPromise(updateAgentAwarenessRegistrationPreferences({ directPushEnabled: enabled }))
      .catch(() => {
        console.warn("Could not update Cloud Connect notification preferences.");
      });
  }, [enabled, chosen]);

  useEffect(() => {
    if (!chosen || enabled || AppState.currentState !== "active") return;
    for (const environment of environments) {
      if (environment.connection.phase === "connected") {
        void disableDirectPush(environment.environmentId)
          .then(() => setStatus(environment.environmentId, "Disabled"))
          .catch(() =>
            setStatus(environment.environmentId, "Could not disable delivery. Reconnect to retry."),
          );
      }
    }
  }, [connectionKey, chosen, enabled, refresh]);

  useEffect(() => {
    if (!loaded || !enabled || AppState.currentState !== "active") return;
    let cancelled = false;
    // Coalesce bursts from shell hydration and provider lifecycle changes.
    const timer = setTimeout(() => {
      for (const environment of environments) {
        if (environment.connection.phase !== "connected") continue;
        const id = environment.environmentId;
        setStatus(id, "Registering…");
        void syncDirectPush(id, liveEnabled)
          .then((status) => {
            if (cancelled) return;
            setStatus(
              id,
              status?.registered
                ? "Registered with Apple notification delivery"
                : "APNs setup needed on this server",
            );
          })
          .catch((error: unknown) => {
            if (!cancelled)
              setStatus(
                id,
                error instanceof Error ? error.message : "Registration failed. Reconnect to retry.",
              );
          });
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // The signatures exclude incidental object changes from shell updates.
  }, [connectionKey, activityKey, enabled, liveEnabled, loaded, refresh]);
  return null;
}
export function DirectPushCoordinator() {
  return Platform.OS === "ios" && supportsAgentAwarenessPush() ? <Coordinator /> : null;
}
