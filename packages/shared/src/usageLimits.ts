/**
 * Selection and pace maths for the provider limits view, shared by web and
 * mobile so both agree on which providers show, what "ahead of pace" means,
 * and how a reset is phrased.
 *
 * @module usageLimits
 */
import {
  type EnvironmentId,
  isProviderAvailable,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Providers that belong on the Limits view: enabled, installed, and one whose
 * driver reports subscription usage at all. A driver with no notion of usage
 * never sets `usageLimits`, so it has no row rather than an empty one.
 */
export function providersWithLimits(
  providers: readonly ServerProvider[],
): readonly ServerProvider[] {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.usageLimits !== undefined,
  );
}

export interface LimitsGroup {
  readonly environmentId: EnvironmentId;
  /** Null while only one environment is connected; there is nothing to tell apart. */
  readonly environmentLabel: string | null;
  readonly providers: readonly ServerProvider[];
}

/**
 * One group per connected environment with a provider reporting limits.
 * Provider snapshots come from the config stream every client already holds,
 * so opening the view costs no extra request.
 */
export function collectLimitsGroups(
  presentations: ReadonlyMap<
    EnvironmentId,
    {
      readonly entry: { readonly target: { readonly label: string } };
      readonly serverConfig: { readonly providers: readonly ServerProvider[] } | null;
    }
  >,
): readonly LimitsGroup[] {
  const groups: LimitsGroup[] = [];
  for (const [environmentId, presentation] of presentations) {
    const providers = providersWithLimits(presentation.serverConfig?.providers ?? []);
    if (providers.length === 0) continue;
    groups.push({ environmentId, environmentLabel: presentation.entry.target.label, providers });
  }
  return groups.length > 1 ? groups : groups.map((group) => ({ ...group, environmentLabel: null }));
}

/**
 * Every usage-limit source across connected environments, keyed so two
 * environments pointing at the same hub still get their own rows. The label
 * carries the environment only when more than one environment has sources.
 */
export function collectLimitSources(
  presentations: ReadonlyMap<
    EnvironmentId,
    {
      readonly entry: { readonly target: { readonly label: string } };
      readonly serverConfig: {
        readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
      } | null;
    }
  >,
): ReadonlyArray<
  UsageLimitSourceSnapshot & { readonly key: string; readonly environmentId: EnvironmentId }
> {
  const perEnvironment: Array<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
    readonly sources: UsageLimitSourceSnapshots;
  }> = [];
  for (const [environmentId, presentation] of presentations) {
    const sources = presentation.serverConfig?.usageLimitSources ?? [];
    if (sources.length === 0) continue;
    perEnvironment.push({
      environmentId,
      environmentLabel: presentation.entry.target.label,
      sources,
    });
  }
  const labelEnvironment = perEnvironment.length > 1;
  return perEnvironment.flatMap(({ environmentId, environmentLabel, sources }) =>
    sources.map((source) => ({
      ...source,
      environmentId,
      key: `${environmentId}:${source.id}`,
      label: labelEnvironment ? `${environmentLabel} · ${source.label}` : source.label,
    })),
  );
}

/** The instance's configured name, else the driver's, else its raw kind. */
export function providerLimitsLabel(
  provider: ServerProvider,
  driverLabel: (driver: ServerProvider["driver"]) => string | undefined,
): string {
  return provider.displayName?.trim() || driverLabel(provider.driver) || String(provider.driver);
}

/** The one-line status under a provider heading when there are no bars to draw. */
export function limitsNotice(limits: ServerProviderUsageLimits): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? "This account has no subscription limits.";
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? "Could not read limits.";
  }
  return limits.windows.length === 0 ? "No limits reported." : null;
}

export function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/** Elapsed share of the window, 0..1, or null when its length or reset is unknown. */
export function elapsedShare(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === undefined) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

export type LimitPace = "ahead" | "on" | "under";

/**
 * Usage against the clock. The bar is the whole window, so the elapsed share
 * is also where even spending would have put the fill; within five points of
 * it counts as on pace.
 */
export function paceOf(window: ServerProviderUsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  if (elapsed === null) return null;
  const gap = window.usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

/** `2h 13m`, `3d 4h`, `12m`. */
export function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** `resets in 2h 13m`, or null when the window has no reset. */
export function formatResetsIn(window: ServerProviderUsageWindow, now: number): string | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  return resetsAt <= now ? "resets now" : `resets in ${formatDuration(resetsAt - now)}`;
}

export type LimitSeverity = "good" | "warn" | "critical";

/**
 * How loud a window should read. The thresholds match what a user actually
 * reacts to: under 60% is background information, 60-85% is worth planning
 * around, and past 85% the window is about to stop being usable.
 */
export function limitSeverity(usedPercent: number): LimitSeverity {
  if (usedPercent >= 85) return "critical";
  return usedPercent >= 60 ? "warn" : "good";
}

/**
 * The two windows a dial draws as concentric rings, plus every window the card
 * lists as a bar underneath.
 *
 *   - `current` is the short window that decides whether a turn can start now:
 *     the session window when the account reports one, else the first.
 *   - `overall` is the long window that decides how much of the subscription
 *     is left this cycle: the first weekly, else the first monthly, else the
 *     next window after `current`.
 *
 * `rest` is every window except `current`, so the long window keeps its exact
 * percent and reset in the list even though the outer ring already shows its
 * shape. A single-window account gets a lone inner ring and no outer one.
 */
export function splitDialWindows(windows: readonly ServerProviderUsageWindow[]): {
  readonly current: ServerProviderUsageWindow | null;
  readonly overall: ServerProviderUsageWindow | null;
  readonly rest: readonly ServerProviderUsageWindow[];
} {
  const current = windows.find((window) => window.kind === "session") ?? windows[0] ?? null;
  if (current === null) return { current: null, overall: null, rest: [] };
  const rest = windows.filter((window) => window !== current);
  const overall =
    rest.find((window) => window.kind === "weekly") ??
    rest.find((window) => window.kind === "monthly") ??
    rest[0] ??
    null;
  return { current, overall, rest };
}

/**
 * The dial's measurements, in CSS pixels, shared so the web (SVG in the DOM)
 * and mobile (react-native-svg) dials cannot drift apart. The SVG viewBox is
 * `size` too, so one unit is one pixel and nothing has to be scaled by hand.
 *
 * The outer ring's far edge (`radius + width / 2`) stays inside `size / 2`,
 * which is what keeps the stroke from being clipped by the viewBox.
 */
export const DIAL = {
  size: 176,
  outer: { radius: 78, width: 6 },
  inner: { radius: 60, width: 12 },
} as const;

/**
 * The largest square that fits inside the inner ring, which is what the
 * reading in the middle of the dial is allowed to occupy.
 *
 * A circle's usable width is a chord, not its diameter: a line of text sitting
 * away from the centre has far less room than one across the middle, so sizing
 * the text against the diameter is how it ends up crossing the stroke. The
 * inscribed square is the one box every line can occupy at any height, so
 * constraining the whole block to it makes the overlap impossible rather than
 * unlikely.
 */
export function dialSafeBoxSize(dial: typeof DIAL = DIAL): number {
  return Math.floor((dial.inner.radius - dial.inner.width / 2) * Math.SQRT2);
}

/**
 * Stroke geometry for one ring of the dial.
 *
 * The arc is a dash the length of the used share with the remainder as the
 * gap, which draws a partial circle without a path. `rotation` starts it at
 * twelve o'clock instead of three.
 */
export function dialRing(usedPercent: number, radius: number) {
  const circumference = 2 * Math.PI * radius;
  const used = Math.max(0, Math.min(100, usedPercent)) / 100;
  return {
    circumference,
    /** Zero-length dashes disappear even with a round cap, so keep a visible minimum. */
    dash: used === 0 ? 0 : Math.max(circumference * used, 1.5),
    rotation: -90,
  };
}

/** What a source kind is called in a heading, shared by web and mobile. */
export const USAGE_LIMIT_SOURCE_KIND_LABEL: Record<UsageLimitSourceSnapshot["kind"], string> = {
  cliproxy: "CLIProxyAPI",
  aiusage: "usage dashboard",
};
