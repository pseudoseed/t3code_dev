import { DirectWidgetUpdate } from "@t3tools/contracts";
import { Schema } from "effect";
import { Platform } from "react-native";
import * as TaskManager from "expo-task-manager";
import * as Notifications from "expo-notifications";
import { loadPreferences } from "../../persistence/imperative";
import { supportsAgentAwarenessPush } from "./capabilities";

const TASK = "agent-widget-push";
const Payload = Schema.Struct({ directWidget: DirectWidgetUpdate });
const decodePayload = Schema.decodeUnknownOption(Payload);
const decodePayloadJson = Schema.decodeUnknownOption(Schema.fromJsonString(Payload));
TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data, error }) => {
  if (
    error ||
    !data ||
    "actionIdentifier" in data ||
    Platform.OS !== "ios" ||
    !supportsAgentAwarenessPush()
  )
    return Notifications.BackgroundNotificationTaskResult.NoData;
  const preferences = await loadPreferences();
  if (preferences.directPushEnabled !== true)
    return Notifications.BackgroundNotificationTaskResult.NoData;
  const decoded = data.data.dataString
    ? decodePayloadJson(data.data.dataString)
    : decodePayload(data.data);
  const { recordConnectionDiagnostic } = await import("../../connection/diagnostics");
  if (decoded._tag === "None") {
    recordConnectionDiagnostic("widget-push", "payload not decodable");
    return Notifications.BackgroundNotificationTaskResult.NoData;
  }
  try {
    const { saveWidgetPush } = await import("../../widgets/widgetStorage");
    const outcome = await saveWidgetPush(decoded.value.directWidget);
    recordConnectionDiagnostic(
      "widget-push",
      `${outcome} env=${decoded.value.directWidget.environmentId} active=${decoded.value.directWidget.activity.activeCount}`,
    );
    return Notifications.BackgroundNotificationTaskResult.NewData;
  } catch (error) {
    recordConnectionDiagnostic(
      "widget-push",
      `failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return Notifications.BackgroundNotificationTaskResult.Failed;
  }
});
if (Platform.OS === "ios" && supportsAgentAwarenessPush()) {
  void Notifications.registerTaskAsync(TASK).catch(() =>
    console.warn("Could not register background widget updates."),
  );
}
