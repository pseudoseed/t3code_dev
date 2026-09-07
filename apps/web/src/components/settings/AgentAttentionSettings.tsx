import { useEffect, useState } from "react";

import {
  agentNotificationPermission,
  playAgentAttentionSound,
  requestAgentNotificationPermission,
  showAgentAttentionNotification,
} from "../../agentAttentionDelivery";
import { APP_DISPLAY_NAME } from "../../branding";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function AgentAttentionSettings() {
  const sound = useClientSettings((settings) => settings.agentAttentionSound);
  const notifications = useClientSettings((settings) => settings.agentAttentionNotifications);
  const update = useUpdateClientSettings();
  const [permission, setPermission] = useState(agentNotificationPermission);
  const [requesting, setRequesting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => setPermission(agentNotificationPermission());
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  const previewNotification = () => {
    setFeedback(null);
    try {
      const shown = showAgentAttentionNotification({
        title: `${APP_DISPLAY_NAME} — Notification test`,
        body: "You will receive alerts when an agent needs input or approval.",
        tag: "agent-attention:test",
        onClick: () => {},
        onError: () =>
          setFeedback(
            "The system could not display the test notification. Check notification permissions for this app or browser.",
          ),
      });
      setFeedback(
        shown
          ? "Test sent. Allow notifications if prompted. If no alert appears, check system notification settings and Focus mode."
          : "Allow notifications, then try again.",
      );
    } catch {
      setFeedback(
        "This browser could not show a notification. Try the desktop app or a supported desktop browser.",
      );
    }
  };

  const enableNotifications = async () => {
    setRequesting(true);
    setFeedback(null);
    try {
      const granted = await requestAgentNotificationPermission();
      update({ agentAttentionNotifications: granted });
      setPermission(agentNotificationPermission());
      if (granted) {
        // Electron's renderer permission can be granted before macOS has asked.
        // Sending an alert triggers the native permission prompt on first use.
        previewNotification();
      } else {
        setFeedback("Allow notifications in your browser or system settings, then try again.");
      }
    } catch {
      setFeedback(
        "Could not request notification permission. Check your browser or system settings.",
      );
    } finally {
      setRequesting(false);
    }
  };

  const previewSound = () => {
    setFeedback(null);
    void playAgentAttentionSound(true).catch(() => {
      setFeedback("Sound could not play. Check whether this app or browser tab is muted.");
    });
  };

  return (
    <SettingsSection id="agent-attention" title="Agent attention">
      <SettingsRow
        {...searchableSetting("agent-attention-sound")}
        description="Play a short chime when an agent needs input or approval. Applies to all connected environments on this device while the app is running."
        control={
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={previewSound}>
              Test sound
            </Button>
            <Switch
              checked={sound}
              onCheckedChange={(checked) => {
                update({ agentAttentionSound: checked });
                if (checked) previewSound();
              }}
              aria-label="Agent attention sound"
            />
          </div>
        }
      />
      <SettingsRow
        {...searchableSetting("agent-attention-notifications")}
        description={
          permission === "unsupported"
            ? "System alerts require a supported browser on HTTPS or localhost, or the desktop app."
            : permission === "denied"
              ? "Notifications are blocked. Allow them in your browser or system notification settings."
              : "Show a system alert for new input and approval requests while this app or browser tab is running. Click an alert to open its thread."
        }
        control={
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={permission !== "granted"}
              onClick={previewNotification}
            >
              Test notification
            </Button>
            <Switch
              checked={notifications && permission === "granted"}
              disabled={requesting || permission === "unsupported"}
              onCheckedChange={(checked) => {
                if (checked) void enableNotifications();
                else update({ agentAttentionNotifications: false });
              }}
              aria-label="Agent attention notifications"
            />
          </div>
        }
      />
      {feedback ? (
        <p role="status" className="text-sm text-muted-foreground">
          {feedback}
        </p>
      ) : null}
    </SettingsSection>
  );
}
