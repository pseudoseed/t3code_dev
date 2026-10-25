import { HStack, Image, Link, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import type { ComponentProps } from "react";
import {
  accessibilityLabel,
  background,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  padding,
  resizable,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import {
  createLiveActivity,
  type LiveActivityComponent,
  type LiveActivityLayout,
} from "expo-widgets";

type LiveActivityEnvironment = Parameters<LiveActivityComponent<AgentActivityProps>>[1];
export type AgentActivityPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";
export interface AgentActivityRowProps {
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly modelTitle: string;
  readonly phase: AgentActivityPhase;
  readonly status: string;
  readonly detail?: string;
  readonly summary?: string | undefined;
  readonly projectIcon?: string | undefined;
  readonly updatedAt: string;
  readonly deepLink: string;
}
export interface AgentActivityProps {
  readonly appScheme?: string | undefined;
  readonly title: string;
  readonly subtitle: string;
  readonly activeCount: number;
  readonly updatedAt: string;
  readonly activities: ReadonlyArray<AgentActivityRowProps>;
}

/** Expo serializes this function into the extension; keep helpers inside its closure. */
export function AgentActivity(
  props: AgentActivityProps,
  environment: LiveActivityEnvironment,
): LiveActivityLayout {
  "widget";
  // The Island and our banner have dark backgrounds even when iOS reports light mode.
  const muted = environment.isLuminanceReduced;
  const tint = (phase?: AgentActivityPhase) => {
    if (muted || (environment.isStale && !phase?.startsWith("waiting"))) return "secondary";
    if (phase === "waiting_for_approval") return "#fcd34d";
    if (phase === "waiting_for_input") return "#c4b5fd";
    if (phase === "failed") return "#fca5a5";
    if (phase === "completed") return "#6ee7b7";
    return "#5eead4";
  };
  const label = (phase: AgentActivityPhase) => {
    if (environment.isStale && (phase === "running" || phase === "starting"))
      return "Update delayed";
    switch (phase) {
      case "starting":
        return "Starting";
      case "running":
        return "Working";
      case "waiting_for_approval":
        return "Approval needed";
      case "waiting_for_input":
        return "Needs your input";
      case "completed":
        return "Ready to review";
      case "failed":
        return "Needs review";
      case "stale":
        return "Update delayed";
    }
  };
  type SymbolName = NonNullable<ComponentProps<typeof Image>["systemName"]>;
  const symbol = (phase?: AgentActivityPhase): SymbolName => {
    switch (phase) {
      case "waiting_for_approval":
        return "hand.raised.fill";
      case "waiting_for_input":
        return "bubble.left.and.text.bubble.right.fill";
      case "failed":
        return "exclamationmark.triangle.fill";
      case "completed":
        return "checkmark.circle.fill";
      case "stale":
        return "clock";
      default:
        return "terminal.fill";
    }
  };
  const priority = (row: AgentActivityRowProps) =>
    row.phase.startsWith("waiting")
      ? 0
      : row.phase === "running" || row.phase === "starting"
        ? 1
        : 2;
  const ordered = [...props.activities].sort(
    (a, b) => priority(a) - priority(b) || b.updatedAt.localeCompare(a.updatedAt),
  );
  const attention = ordered.filter((row) => row.phase.startsWith("waiting"));
  const hero = ordered[0];
  const done = props.activeCount === 0;
  const summary = attention.length
    ? `${attention.length} need${attention.length === 1 ? "s" : ""} you`
    : done
      ? hero?.phase === "failed"
        ? "Needs review"
        : hero
          ? "Done"
          : "All caught up"
      : `${props.activeCount} active`;
  const url =
    hero?.deepLink.startsWith("/") && !hero.deepLink.startsWith("//")
      ? `${props.appScheme ?? "t3code"}://${hero.deepLink.slice(1)}`
      : null;
  const logo = (size: number) => (
    <HStack modifiers={[frame({ width: size, height: size })]}>
      <Image assetName="AppMark" modifiers={[resizable(), accessibilityLabel("PseudoCode")]} />
    </HStack>
  );
  const glyph = (row: AgentActivityRowProps, size: number) => (
    <HStack modifiers={[frame({ width: size, height: size }), foregroundStyle(tint(row.phase))]}>
      <Image systemName={symbol(row.phase)} modifiers={[resizable()]} />
    </HStack>
  );
  const badge = (text: string, phase?: AgentActivityPhase) => (
    <Text
      modifiers={[
        font({ size: 12, weight: "semibold" }),
        foregroundStyle(tint(phase)),
        lineLimit(1),
      ]}
    >
      {text}
    </Text>
  );
  const detail = (row: AgentActivityRowProps) =>
    row.summary ||
    (row.phase === "failed"
      ? row.detail || "Open thread to review the error"
      : row.phase === "waiting_for_approval"
        ? "Tap to review and approve"
        : row.phase === "waiting_for_input"
          ? "Tap to answer your agent"
          : row.phase === "completed"
            ? "Ready to review"
            : "Your agent is working on this thread.");
  const rowView = (row: AgentActivityRowProps, prominent: boolean) => (
    <Link
      key={`${row.environmentId}:${row.threadId}`}
      destination={
        row.deepLink.startsWith("/threads/")
          ? `${props.appScheme ?? "t3code"}://${row.deepLink.slice(1)}`
          : `${props.appScheme ?? "t3code"}://`
      }
    >
      <HStack alignment="top" spacing={10}>
        <VStack modifiers={[padding({ top: 3 })]}>
          {row.projectIcon ? (
            <Image
              uiImage={row.projectIcon}
              modifiers={[resizable(), frame({ width: 22, height: 22 })]}
            />
          ) : (
            <Image
              systemName="folder"
              modifiers={[font({ size: 18 }), foregroundStyle("#a8bac3")]}
            />
          )}
        </VStack>
        <VStack
          alignment="leading"
          spacing={4}
          modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
        >
          <Text
            modifiers={[
              font({ size: prominent ? 16 : 13, weight: "semibold" }),
              foregroundStyle("#f4f8fa"),
              lineLimit(1),
            ]}
          >
            {row.threadTitle}
          </Text>
          <HStack spacing={6}>
            <Text modifiers={[font({ size: 11 }), foregroundStyle("#a8bac3"), lineLimit(1)]}>
              {row.projectTitle}
            </Text>
            <Spacer minLength={4} />
            <Text
              modifiers={[
                font({ size: 12, weight: "semibold" }),
                foregroundStyle(tint(row.phase)),
                lineLimit(1),
              ]}
            >
              {label(row.phase)}
            </Text>
          </HStack>
          {prominent || row.summary ? (
            <Text
              modifiers={[
                font({ size: 12 }),
                foregroundStyle(row.phase === "failed" ? tint(row.phase) : "#a8bac3"),
                lineLimit(1),
              ]}
            >
              {detail(row)}
            </Text>
          ) : null}
        </VStack>
      </HStack>
    </Link>
  );
  const extra = Math.max(
    0,
    props.activeCount - ordered.slice(0, 2).filter((row) => priority(row) < 2).length,
  );
  return {
    banner: (
      <VStack
        alignment="leading"
        spacing={12}
        modifiers={[
          frame({ maxWidth: Infinity, alignment: "leading" }),
          padding({ horizontal: 16, vertical: 14 }),
          background("#101a1f"),
          ...(url ? [widgetURL(url)] : []),
        ]}
      >
        <HStack spacing={7}>
          {logo(23)}
          <Text modifiers={[font({ size: 14, weight: "semibold" }), foregroundStyle("#f4f8fa")]}>
            PseudoCode
          </Text>
          <Spacer minLength={8} />
          {badge(summary, hero?.phase)}
        </HStack>
        {hero ? (
          rowView(hero, true)
        ) : (
          <Text modifiers={[font({ size: 13 }), foregroundStyle("#a8bac3")]}>
            Your tasks are up to date.
          </Text>
        )}
        {ordered[1] ? rowView(ordered[1], false) : null}
        {extra > 0 ? (
          <Text modifiers={[font({ size: 11 }), foregroundStyle("#a8bac3")]}>
            +{extra} more active in PseudoCode
          </Text>
        ) : null}
      </VStack>
    ),
    bannerSmall: (
      <VStack
        alignment="leading"
        spacing={8}
        modifiers={[padding({ all: 10 }), background("#101a1f"), ...(url ? [widgetURL(url)] : [])]}
      >
        <HStack spacing={6}>
          {logo(20)}
          <Text modifiers={[font({ size: 12, weight: "semibold" })]}>PseudoCode</Text>
          <Spacer minLength={0} />
        </HStack>
        {hero ? rowView(hero, false) : null}
        {badge(summary, hero?.phase)}
      </VStack>
    ),
    compactLeading: logo(22),
    compactTrailing: (
      <Text
        modifiers={[
          font({ size: 12, weight: "semibold" }),
          foregroundStyle(tint(hero?.phase)),
          lineLimit(1),
        ]}
      >
        {attention.length
          ? hero?.phase === "waiting_for_approval"
            ? "Approve"
            : "Reply"
          : summary}
      </Text>
    ),
    minimal: hero && (done || attention.length) ? glyph(hero, 16) : logo(20),
    expandedLeading: (
      <HStack spacing={6} modifiers={[padding({ leading: 4, top: 3 })]}>
        {logo(22)}
        <Text modifiers={[font({ size: 12, weight: "semibold" })]}>PseudoCode</Text>
      </HStack>
    ),
    expandedTrailing: (
      <HStack modifiers={[padding({ trailing: 4, top: 3 })]}>{badge(summary, hero?.phase)}</HStack>
    ),
    expandedCenter: null,
    expandedBottom: (
      <VStack
        alignment="leading"
        spacing={8}
        modifiers={[padding({ horizontal: 8, vertical: 6 }), ...(url ? [widgetURL(url)] : [])]}
      >
        {hero ? rowView(hero, true) : null}
        {extra > 0 || props.activeCount > 1 ? (
          <Text modifiers={[font({ size: 11 }), foregroundStyle("#a8bac3")]}>
            Open PseudoCode for all {props.activeCount} active tasks
          </Text>
        ) : null}
      </VStack>
    ),
  };
}

export default createLiveActivity<AgentActivityProps>("AgentActivity", AgentActivity);
