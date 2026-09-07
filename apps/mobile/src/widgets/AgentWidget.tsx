import { HStack, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { font, foregroundStyle, lineLimit, padding, widgetURL } from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";
import type { AgentWidgetSnapshot } from "./agentWidgetSnapshot";

/** Serialized for the extension: keep the layout self-contained, including
 * gallery defaults, because WidgetKit can render before the app has synced. */
export function AgentWidget(props: Partial<AgentWidgetSnapshot>, environment: WidgetEnvironment) {
  "widget";
  const activities = props.activities ?? [];
  const first = activities[0];
  const accessory = environment.widgetFamily === "accessoryRectangular";
  const small = environment.widgetFamily === "systemSmall";
  const rows = activities.slice(0, accessory || small ? 1 : 3);
  const attention = props.attentionCount ?? 0;
  const count = props.activeCount ?? 0;
  const dark = environment.colorScheme !== "light";
  const color = attention > 0 ? (dark ? "#fcd34d" : "#92400e") : dark ? "#7dd3fc" : "#075985";
  const heading =
    attention > 0
      ? `${attention} need${attention === 1 ? "s" : ""} attention`
      : count > 0
        ? `${count} active agent${count === 1 ? "" : "s"}`
        : "Recent activity";
  const deepLink = first?.deepLink;
  const url =
    deepLink?.startsWith("/") && !deepLink.startsWith("//")
      ? `t3code://${deepLink.slice(1)}`
      : "t3code://";
  return (
    <VStack
      alignment="leading"
      spacing={accessory ? 2 : 6}
      modifiers={[padding({ all: accessory ? 0 : 12 }), widgetURL(url)]}
    >
      <Text
        modifiers={[
          font({ size: accessory ? 12 : 14, weight: "semibold" }),
          foregroundStyle(color),
          lineLimit(1),
        ]}
      >
        {activities.length === 0 ? "Agent activity" : heading}
      </Text>
      {rows.map((row) => (
        <VStack key={`${row.environmentId}:${row.threadId}`} alignment="leading" spacing={1}>
          <Text
            modifiers={[
              font({ size: accessory ? 12 : 13, weight: "semibold" }),
              foregroundStyle("primary"),
              lineLimit(small ? 2 : 1),
            ]}
          >
            {row.threadTitle}
          </Text>
          <Text modifiers={[font({ size: 11 }), foregroundStyle("secondary"), lineLimit(1)]}>
            {row.projectTitle} · {row.headline}
          </Text>
        </VStack>
      ))}
      {activities.length === 0 ? (
        <Text modifiers={[font({ size: 12 }), foregroundStyle("secondary"), lineLimit(3)]}>
          {props.activities === undefined
            ? "Open the app to sync agent activity."
            : "No agent activity. Open the app to refresh."}
        </Text>
      ) : null}
      {!accessory ? <Spacer minLength={0} /> : null}
      {!accessory ? (
        <HStack spacing={4}>
          <Text modifiers={[font({ size: 10 }), foregroundStyle("secondary")]}>
            {props.updatedAt ? "Updated" : "Open app to refresh"}
          </Text>
          {props.updatedAt ? (
            <Text
              date={new Date(props.updatedAt)}
              dateStyle="time"
              modifiers={[font({ size: 10 }), foregroundStyle("secondary")]}
            />
          ) : null}
        </HStack>
      ) : null}
    </VStack>
  );
}

// A normal widget and a Live Activity use different native storage keys,
// even when their configuration name is the same.
const agentWidget = createWidget<AgentWidgetSnapshot>("AgentActivity", AgentWidget);
agentWidget.reload();
export default agentWidget;
