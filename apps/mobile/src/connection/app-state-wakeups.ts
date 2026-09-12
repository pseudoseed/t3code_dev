import type { Wakeups } from "@t3tools/client-runtime/connection";

/**
 * A short trip out of the app leaves the socket intact, so the probe keeps the
 * live subscriptions and the resume costs nothing. Past this window the socket
 * has usually been dropped somewhere the client cannot see it: NAT and router
 * idle timeouts, a Wi-Fi to cellular handoff, or a sleeping radio all end the
 * flow without a close frame, and neither side sends a heartbeat to notice.
 * Rebuilding is cheap now that the shell resumes from its cursor, so blind
 * replacement is the better trade once a resume is no longer quick.
 */
export const MOBILE_BACKGROUND_RECONNECT_AFTER_MS = 90_000;

export type MobileApplicationActiveWakeup = Extract<
  Wakeups.ConnectionWakeup,
  "application-active-probe" | "application-active-reconnect"
>;

export function mobileApplicationActiveWakeup(
  backgroundedAtMs: number | null,
  activeAtMs: number,
): MobileApplicationActiveWakeup {
  return backgroundedAtMs !== null &&
    activeAtMs - backgroundedAtMs >= MOBILE_BACKGROUND_RECONNECT_AFTER_MS
    ? "application-active-reconnect"
    : "application-active-probe";
}
