import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { Alert, Platform, View } from "react-native";
import * as Notifications from "expo-notifications";
import { AppText as Text } from "../../components/AppText";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useEnvironments } from "../../state/environments";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { directPushStatusAtom } from "./DirectPushCoordinator";
import { supportsAgentAwarenessPush } from "./capabilities";

export function DirectPushSettings() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const statuses = useAtomValue(directPushStatusAtom);
  const { environments } = useEnvironments();
  const [busy, setBusy] = useState(false);
  if (Platform.OS !== "ios" || !supportsAgentAwarenessPush()) return null;
  const loaded = AsyncResult.isSuccess(preferences);
  const enabled = loaded && preferences.value.directPushEnabled === true;
  const liveEnabled = loaded && preferences.value.directLiveActivitiesEnabled !== false;
  return (
    <SettingsSection title="Apple notifications from my servers">
      <SettingsSwitchRow
        icon="bell.badge"
        label="Use my servers"
        value={enabled}
        disabled={!loaded || busy}
        subtitle="Receive input and approval alerts without a Cloud Connect account. Each server needs Apple notification setup."
        onValueChange={(value) => {
          setBusy(true);
          void (async () => {
            if (value) {
              const permission = await Notifications.requestPermissionsAsync({
                ios: { allowAlert: true, allowSound: true, allowBadge: true },
              });
              if (!permission.granted)
                Alert.alert(
                  "Notification permission needed",
                  "Allow notifications in iOS Settings to hear input and approval alerts. Live Activities can still be enabled separately.",
                );
            }
            save({ directPushEnabled: value });
          })()
            .catch(() =>
              Alert.alert(
                "Could not enable notifications",
                "Check notification access in iOS Settings.",
              ),
            )
            .finally(() => setBusy(false));
        }}
      />
      <SettingsSwitchRow
        icon="bolt.circle"
        label="Live Activities"
        value={enabled && liveEnabled}
        disabled={!enabled}
        subtitle="Open the app while work is active to show it on the Lock Screen and Dynamic Island."
        onValueChange={(value) => save({ directLiveActivitiesEnabled: value })}
      />
      {enabled ? (
        <View className="gap-2 px-4 pb-4">
          {environments.map((environment) => (
            <Text key={environment.environmentId} className="text-sm text-foreground-muted">
              {environment.label}:{" "}
              {statuses.get(environment.environmentId) ?? "Connect to register this device"}
            </Text>
          ))}
        </View>
      ) : null}
    </SettingsSection>
  );
}
