import type {
  ProviderDriverKind,
  ServerProviderUsageWindow,
  UsageLimitSourceAccount,
} from "@t3tools/contracts";
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
import { type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Badge } from "../ui/badge";

/**
 * One account as a single readable card: who it is, two concentric rings for
 * the two windows that actually drive a decision, and every other window as a
 * thin bar underneath.
 *
 * The outer ring is the long window (how much of the cycle is left) and the
 * inner ring the short one (whether a turn can start now). They are different
 * questions, so the outer keeps one steady accent while only the inner takes
 * the severity colour — a weekly bar going amber would read as urgent when it
 * is merely large.
 *
 * Colour comes from the theme's semantic tokens rather than fixed hex values.
 * Nothing here transitions or animates: this view sits open beside running
 * agents, where a ring that redraws on every poll is a continuous repaint.
 *
 * @module usage/UsageDialCard
 */

const SEVERITY_COLOR: Record<LimitSeverity, string> = {
  good: "var(--success)",
  warn: "var(--warning)",
  critical: "var(--error)",
};

/** Every line in the middle of the dial lives inside this square. */
const SAFE = dialSafeBoxSize();

/** `SESSION · 5H`, the caption naming which window the inner ring is showing. */
function windowCaption(window: ServerProviderUsageWindow): string {
  const hours = window.windowDurationMins === undefined ? null : window.windowDurationMins / 60;
  const span =
    hours === null ? null : hours >= 24 ? `${Math.round(hours / 24)}d` : `${Math.round(hours)}h`;
  return [window.kind, span].filter(Boolean).join(" · ").toUpperCase();
}

function Ring({
  window,
  radius,
  width,
  color,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly radius: number;
  readonly width: number;
  readonly color: string;
}) {
  const { circumference, dash, rotation } = dialRing(window.usedPercent, radius);
  const center = DIAL.size / 2;
  return (
    <>
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke="var(--muted)"
        strokeWidth={width}
      />
      {dash > 0 ? (
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={width}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          transform={`rotate(${rotation} ${center} ${center})`}
        />
      ) : null}
    </>
  );
}

/**
 * The two rings plus the reading in the middle. The centre always reports the
 * current window, because that is the number a user acts on; the outer ring's
 * exact percent is in the bar list.
 */
function Dial({
  current,
  overall,
  now,
}: {
  readonly current: ServerProviderUsageWindow;
  readonly overall: ServerProviderUsageWindow | null;
  readonly now: number;
}) {
  const percent = Math.round(current.usedPercent);
  const color = SEVERITY_COLOR[limitSeverity(current.usedPercent)];
  const resetsAt = resetMillis(current);
  const label = overall
    ? `${current.label}: ${percent}% used; ${overall.label}: ${Math.round(overall.usedPercent)}% used`
    : `${current.label}: ${percent}% used`;
  return (
    <div
      className="relative grid place-items-center"
      style={{ width: DIAL.size, height: DIAL.size }}
      role="img"
      aria-label={label}
    >
      <svg
        viewBox={`0 0 ${DIAL.size} ${DIAL.size}`}
        className="absolute inset-0 size-full"
        aria-hidden
      >
        {overall ? (
          <Ring
            window={overall}
            radius={DIAL.outer.radius}
            width={DIAL.outer.width}
            color="var(--info)"
          />
        ) : null}
        <Ring window={current} radius={DIAL.inner.radius} width={DIAL.inner.width} color={color} />
      </svg>
      {/* Clamped to the inscribed square so no line can reach the stroke,
          whatever the percent, the countdown, or the window's name. */}
      <div
        className="relative flex min-w-0 flex-col items-center gap-0.5 text-center"
        style={{ maxWidth: SAFE, maxHeight: SAFE }}
      >
        <span className="text-[30px] leading-8 font-semibold tabular-nums text-foreground">
          {percent}
          <span className="ml-px align-super text-sm text-muted-foreground">%</span>
        </span>
        {resetsAt === null ? null : (
          <span className="text-[11px] leading-[14px] whitespace-nowrap text-muted-foreground">
            resets{" "}
            <span className="font-medium tabular-nums" style={{ color }}>
              {formatDuration(resetsAt - now)}
            </span>
          </span>
        )}
        <span className="max-w-full truncate text-[9px] leading-3 tracking-wide text-muted-foreground">
          {windowCaption(current)}
        </span>
      </div>
    </div>
  );
}

/** A secondary window: name, fill, percent, and how long it has left. */
function WindowBar({
  window,
  now,
  isOverall,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly isOverall: boolean;
}) {
  const resetsAt = resetMillis(window);
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3">
      <span className="truncate text-[10px] tracking-wider text-muted-foreground uppercase">
        {window.label}
      </span>
      <span className="h-1.5 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full"
          style={{
            width: `${Math.max(window.usedPercent, window.usedPercent > 0 ? 1.5 : 0)}%`,
            // The window on the outer ring keeps the ring's colour, so the eye
            // can pair the bar with the arc it belongs to.
            background: isOverall
              ? "var(--info)"
              : SEVERITY_COLOR[limitSeverity(window.usedPercent)],
          }}
        />
      </span>
      <span className="text-xs tabular-nums text-foreground">
        {Math.round(window.usedPercent)}%
        {resetsAt === null ? null : (
          <span className="ml-2 text-muted-foreground">{formatDuration(resetsAt - now)}</span>
        )}
      </span>
    </div>
  );
}

/**
 * The card body shared by a source account and a signed-in provider, so both
 * read identically whether the numbers came from a usage source or the CLI.
 */
export function UsageDialCard({
  driver,
  title,
  subtitle,
  plan,
  windows,
  notice,
  now,
  footer,
  className,
}: {
  readonly driver: ProviderDriverKind;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly plan?: string | undefined;
  readonly windows: readonly ServerProviderUsageWindow[];
  readonly notice: string | null;
  readonly now: number;
  readonly footer?: ReactNode;
  readonly className?: string;
}) {
  const { current, overall, rest } = splitDialWindows(windows);
  return (
    <section
      className={cn("flex flex-col gap-3 rounded-xl border border-border bg-card p-4", className)}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <ProviderInstanceIcon
            driverKind={driver}
            displayName={title}
            showBadge={false}
            className="mt-0.5"
          />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-base font-semibold text-foreground">{title}</span>
            {subtitle ? (
              <RedactedSensitiveText
                value={subtitle}
                ariaLabel="Toggle account email visibility"
                revealTooltip="Click to reveal email"
                hideTooltip="Click to hide email"
                className="truncate text-xs text-muted-foreground"
              />
            ) : null}
          </div>
        </div>
        {plan ? (
          <Badge variant="outline" className="shrink-0 whitespace-nowrap">
            {plan}
          </Badge>
        ) : null}
      </header>
      {notice ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{notice}</p>
      ) : current ? (
        <div className="flex flex-col items-center gap-3 py-2">
          <Dial current={current} overall={overall} now={now} />
          {rest.length > 0 ? (
            <div className="flex w-full flex-col gap-2 pt-1">
              {rest.map((window) => (
                <WindowBar
                  key={window.id}
                  window={window}
                  now={now}
                  isOverall={window === overall}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {footer}
    </section>
  );
}

/** A card for one account a usage-limit source pools. */
export function SourceAccountDialCard({
  account,
  now,
  footer,
}: {
  readonly account: UsageLimitSourceAccount;
  readonly now: number;
  readonly footer?: ReactNode;
}) {
  return (
    <UsageDialCard
      driver={account.driver}
      title={account.label ?? account.email ?? account.id}
      subtitle={account.label ? account.email : undefined}
      plan={account.plan}
      windows={account.usageLimits.windows}
      notice={limitsNotice(account.usageLimits)}
      now={now}
      footer={footer}
    />
  );
}
