import type { Wakeups } from "@t3tools/client-runtime/connection";

/**
 * iOS suspends the app about 30 seconds after backgrounding and SocketRocket never reports a
 * flow that died while suspended. Short trips keep the socket via a probe; past this window the
 * probe would mostly time out on a dead socket, and a shell rebuild from its cursor is cheap.
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
