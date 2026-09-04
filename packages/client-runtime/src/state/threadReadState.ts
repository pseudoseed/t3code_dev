import type { OrchestrationThreadShell } from "@t3tools/contracts";

/**
 * Read state is server-side (`lastViewedAt`), so every surface agrees on what
 * has been seen: reading a thread on the desktop clears the unread indicator
 * on the phone.
 *
 * `localLastViewedAt` is the caller's own device-local record, used only when
 * the server predates the field (`lastViewedAt` absent, not null). Web keeps
 * one in local storage; a server that knows about read state always wins.
 */
export type ThreadReadStateShell = Pick<OrchestrationThreadShell, "latestTurn" | "lastViewedAt">;

interface ReadStateOptions {
  readonly localLastViewedAt?: string | null | undefined;
}

function resolveLastViewedAt(
  shell: Pick<ThreadReadStateShell, "lastViewedAt">,
  options?: ReadStateOptions,
): string | null {
  // `undefined` means the server never sent the field; `null` means it did and
  // nobody has opened the thread. Only the first case falls back to the device.
  if (shell.lastViewedAt !== undefined) return shell.lastViewedAt;
  return options?.localLastViewedAt ?? null;
}

/**
 * "Finished while you were away": the latest turn completed after the last
 * time any client had this thread open.
 *
 * A never-viewed thread reads as SEEN. Adopting read state must not light up
 * every thread in the history, and a thread nobody ever opened is history
 * rather than news — the first open is what arms the indicator.
 */
export function threadHasUnreadCompletion(
  shell: ThreadReadStateShell,
  options?: ReadStateOptions,
): boolean {
  const completedAt = shell.latestTurn?.completedAt;
  if (completedAt == null) return false;
  const completedAtMs = Date.parse(completedAt);
  if (Number.isNaN(completedAtMs)) return false;
  const lastViewedAt = resolveLastViewedAt(shell, options);
  if (lastViewedAt == null) return false;
  const lastViewedAtMs = Date.parse(lastViewedAt);
  // Corrupt stored state must never hide a completion the user has not seen.
  if (Number.isNaN(lastViewedAtMs)) return true;
  return completedAtMs > lastViewedAtMs;
}

/**
 * Whether having this thread open is worth a `thread.view` command. The first
 * open of a thread arms the indicator; after that only a turn that completed
 * since the last recorded view is worth writing, so re-opening a thread you
 * have already read (or watching one stream) writes nothing at all.
 */
export function threadNeedsViewRecord(shell: ThreadReadStateShell): boolean {
  if (shell.lastViewedAt == null) return true;
  const lastViewedAtMs = Date.parse(shell.lastViewedAt);
  if (Number.isNaN(lastViewedAtMs)) return true;
  const completedAt = shell.latestTurn?.completedAt;
  if (completedAt == null) return false;
  const completedAtMs = Date.parse(completedAt);
  if (Number.isNaN(completedAtMs)) return false;
  return completedAtMs > lastViewedAtMs;
}
