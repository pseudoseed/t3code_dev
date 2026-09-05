import type { ServerProviderUsageWindow, UsageLimitSourceAccount } from "@t3tools/contracts";
import {
  DIAL,
  dialRing,
  dialSafeBoxSize,
  formatDuration,
  limitSeverity,
  type LimitSeverity,
  limitsNotice,
  resetMillis,
  splitDialWindows,
} from "@t3tools/shared/usageLimits";
import type { ReactNode } from "react";
import { View } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { useUniwindTheme } from "../../lib/useUniwindTheme";

/**
 * The phone's version of the usage dial: two concentric rings for the two
 * windows that drive a decision, and every other window as a bar below.
 *
 * Geometry comes from `@t3tools/shared/usageLimits` so this and the web dial
 * cannot drift. Only the drawing differs: react-native-svg here, DOM SVG there.
 * Colours are read from the active theme rather than written in, since SVG
 * strokes cannot take a Uniwind className.
 *
 * @module usage/UsageDialCard
 */

/** Every line in the middle of the dial lives inside this square. */
const SAFE = dialSafeBoxSize();

type DialColors = {
  readonly severity: Record<LimitSeverity, string>;
  readonly accent: string;
  readonly track: string;
};

function useDialColors(): DialColors {
  const theme = useUniwindTheme();
  return {
    severity: {
      good: theme["--color-usage-good"],
      warn: theme["--color-usage-warn"],
      critical: theme["--color-usage-critical"],
    },
    accent: theme["--color-usage-overall"],
    track: theme["--color-usage-track"],
  };
}

/** `SESSION · 5H`, the caption naming which window the inner ring is showing. */
function windowCaption(window: ServerProviderUsageWindow): string {
  const hours = window.windowDurationMins === undefined ? null : window.windowDurationMins / 60;
  const span =
    hours === null ? null : hours >= 24 ? `${Math.round(hours / 24)}d` : `${Math.round(hours)}h`;
  return [window.kind, span].filter(Boolean).join(" · ").toUpperCase();
}

function Ring(props: {
  readonly window: ServerProviderUsageWindow;
  readonly radius: number;
  readonly width: number;
  readonly color: string;
  readonly track: string;
}) {
  const { circumference, dash, rotation } = dialRing(props.window.usedPercent, props.radius);
  const center = DIAL.size / 2;
  return (
    <>
      <Circle
        cx={center}
        cy={center}
        r={props.radius}
        fill="none"
        stroke={props.track}
        strokeWidth={props.width}
      />
      {dash > 0 ? (
        <Circle
          cx={center}
          cy={center}
          r={props.radius}
          fill="none"
          stroke={props.color}
          strokeWidth={props.width}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          transform={`rotate(${rotation} ${center} ${center})`}
        />
      ) : null}
    </>
  );
}

/**
 * The rings plus the reading in the middle. The centre always reports the
 * current window, because that is the number a user acts on; the outer ring's
 * exact percent stays in the bar list.
 */
function Dial(props: {
  readonly current: ServerProviderUsageWindow;
  readonly overall: ServerProviderUsageWindow | null;
  readonly now: number;
  readonly colors: DialColors;
}) {
  const { current, overall, now, colors } = props;
  const percent = Math.round(current.usedPercent);
  const color = colors.severity[limitSeverity(current.usedPercent)];
  const resetsAt = resetMillis(current);
  return (
    <View className="items-center justify-center" style={{ width: DIAL.size, height: DIAL.size }}>
      <View className="absolute inset-0">
        <Svg width="100%" height="100%" viewBox={`0 0 ${DIAL.size} ${DIAL.size}`}>
          {overall ? (
            <Ring
              window={overall}
              radius={DIAL.outer.radius}
              width={DIAL.outer.width}
              color={colors.accent}
              track={colors.track}
            />
          ) : null}
          <Ring
            window={current}
            radius={DIAL.inner.radius}
            width={DIAL.inner.width}
            color={color}
            track={colors.track}
          />
        </Svg>
      </View>
      {/* Clamped to the inscribed square so no line can reach the stroke,
          whatever the percent, the countdown, or the window's name. */}
      <View className="items-center gap-0.5" style={{ maxWidth: SAFE, maxHeight: SAFE }}>
        <Text className="text-[30px] leading-8 font-t3-medium tabular-nums text-foreground">
          {percent}%
        </Text>
        {resetsAt === null ? null : (
          <Text numberOfLines={1} className="text-[11px] leading-[14px] text-foreground-muted">
            resets{" "}
            <Text className="tabular-nums" style={{ color }}>
              {formatDuration(resetsAt - now)}
            </Text>
          </Text>
        )}
        <Text
          numberOfLines={1}
          className="text-[9px] leading-3 tracking-wide text-foreground-tertiary"
        >
          {windowCaption(current)}
        </Text>
      </View>
    </View>
  );
}

/** A secondary window: name, fill, percent, and how long it has left. */
function WindowBar(props: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly isOverall: boolean;
  readonly colors: DialColors;
}) {
  const { window, now, colors } = props;
  const used = Math.round(Math.max(0, Math.min(100, window.usedPercent)));
  const resetsAt = resetMillis(window);
  // The window on the outer ring keeps the ring's colour, so the eye can pair
  // the bar with the arc it belongs to.
  const fill = props.isOverall ? colors.accent : colors.severity[limitSeverity(used)];
  return (
    <View className="flex-row items-center gap-3">
      <Text
        numberOfLines={1}
        className="w-28 text-[10px] tracking-wider text-foreground-muted uppercase"
      >
        {window.label}
      </Text>
      <View className="h-1.5 flex-1 flex-row overflow-hidden rounded-full bg-subtle">
        <View className="h-full rounded-full" style={{ flex: used, backgroundColor: fill }} />
        <View style={{ flex: 100 - used }} />
      </View>
      <Text className="text-xs tabular-nums text-foreground">
        {used}%
        {resetsAt === null ? null : (
          <Text className="text-foreground-muted"> {formatDuration(resetsAt - now)}</Text>
        )}
      </Text>
    </View>
  );
}

export function UsageDialCard(props: {
  readonly driver: string;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly plan?: string | undefined;
  readonly windows: readonly ServerProviderUsageWindow[];
  readonly notice: string | null;
  readonly now: number;
  readonly footer?: ReactNode;
}) {
  const colors = useDialColors();
  const { current, overall, rest } = splitDialWindows(props.windows);
  return (
    <View className="gap-3 rounded-[24px] border-continuous bg-card p-4">
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1 flex-row items-start gap-2.5">
          <View className="pt-0.5">
            <ProviderIcon provider={props.driver} size={20} />
          </View>
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-lg font-t3-medium text-foreground">
              {props.title}
            </Text>
            {props.subtitle ? (
              <Text numberOfLines={1} className="text-xs text-foreground-muted">
                {props.subtitle}
              </Text>
            ) : null}
          </View>
        </View>
        {props.plan ? (
          <View className="shrink-0 rounded-full border-continuous bg-subtle px-2 py-0.5">
            <Text className="text-xs text-foreground-muted">{props.plan}</Text>
          </View>
        ) : null}
      </View>
      {props.notice ? (
        <Text className="py-6 text-center text-sm text-foreground-muted">{props.notice}</Text>
      ) : current ? (
        <View className="items-center gap-3 py-1">
          <Dial current={current} overall={overall} now={props.now} colors={colors} />
          {rest.length > 0 ? (
            <View className="w-full gap-2 pt-1">
              {rest.map((window) => (
                <WindowBar
                  key={window.id}
                  window={window}
                  now={props.now}
                  isOverall={window === overall}
                  colors={colors}
                />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {props.footer}
    </View>
  );
}

const DRIVER_LABEL: Partial<Record<string, string>> = {
  codex: "Codex",
  claudeAgent: "Claude",
  antigravity: "Antigravity",
  grok: "Grok",
};

/** A card for one account a usage-limit source pools. */
export function SourceAccountDialCard(props: {
  readonly account: UsageLimitSourceAccount;
  readonly now: number;
  readonly footer?: ReactNode;
}) {
  const { account } = props;
  const title =
    account.label ?? account.email ?? DRIVER_LABEL[account.driver] ?? String(account.driver);
  return (
    <UsageDialCard
      driver={account.driver}
      title={title}
      subtitle={account.label ? account.email : undefined}
      plan={account.plan}
      windows={account.usageLimits.windows}
      notice={limitsNotice(account.usageLimits)}
      now={props.now}
      footer={props.footer}
    />
  );
}
