import type { Wakeups } from "@t3tools/client-runtime/connection";

/**
 * iOS keeps the socket open while the app is suspended, and a Node host never
 * closes it for idleness, so a resume normally finds every event queued on the
 * live connection. The probe settles a dead socket within 3 seconds; only a
 * suspension long enough that the transport is surely gone skips it.
 */
export const MOBILE_BACKGROUND_RECONNECT_AFTER_MS = 15 * 60_000;

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
