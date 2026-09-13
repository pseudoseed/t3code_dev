import type { Wakeups } from "@t3tools/client-runtime/connection";

/**
 * A short trip out of the app leaves the socket intact, so the probe keeps the
 * live subscriptions and the resume costs nothing. iOS suspends the process
 * about 30 seconds after it leaves the foreground, and React Native's socket
 * (SocketRocket) never reports a flow that died while suspended, so past this
 * window the probe would mostly spend its timeout on a corpse. Rebuilding is
 * cheap now that the shell resumes from its cursor, so replace blindly.
 */
export const MOBILE_BACKGROUND_RECONNECT_AFTER_MS = 30_000;

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
