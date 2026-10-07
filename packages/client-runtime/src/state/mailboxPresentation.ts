import type { MailboxGetResult, MailboxMessage, ThreadId } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";

export type MailboxStatusTone = "neutral" | "info" | "warning" | "error" | "success";

export interface MailboxStatus {
  readonly label: string;
  readonly tone: MailboxStatusTone;
}

type ThreadStatusInput = Pick<
  EnvironmentThreadShell,
  | "archivedAt"
  | "settledOverride"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "interactionMode"
  | "latestTurn"
  | "session"
  | "backgroundLiveness"
>;

/** Derived from live shells, so a peer's status updates without refetching mailbox history. */
export function getMailboxThreadStatus(thread: ThreadStatusInput | undefined): MailboxStatus {
  if (!thread) return { label: "Unavailable", tone: "neutral" };
  if (thread.archivedAt !== null) return { label: "Archived", tone: "neutral" };
  if (thread.hasPendingApprovals) return { label: "Needs approval", tone: "warning" };
  if (thread.hasPendingUserInput) return { label: "Awaiting input", tone: "warning" };
  if (thread.session?.status === "error") return { label: "Failed", tone: "error" };
  if (thread.session?.status === "running") return { label: "Working", tone: "info" };
  if (thread.session?.status === "starting") return { label: "Starting", tone: "info" };
  if (thread.latestTurn?.state === "error") return { label: "Failed", tone: "error" };
  if (
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    thread.latestTurn?.state === "completed"
  ) {
    return { label: "Plan ready", tone: "warning" };
  }
  if (thread.backgroundLiveness === "working") return { label: "Working", tone: "info" };
  if (thread.backgroundLiveness === "monitoring") return { label: "Monitoring", tone: "info" };
  if (thread.settledOverride === "settled") return { label: "Settled", tone: "neutral" };
  if (
    thread.session?.status === "stopped" ||
    thread.session?.status === "interrupted" ||
    thread.latestTurn?.state === "interrupted"
  ) {
    return { label: "Stopped", tone: "neutral" };
  }
  return { label: "Idle", tone: "neutral" };
}

export const mailboxMessageStatus: Record<MailboxMessage["state"], MailboxStatus> = {
  queued: { label: "Waiting", tone: "warning" },
  included: { label: "Delivered", tone: "info" },
  acknowledged: { label: "Acknowledged", tone: "info" },
  resolved: { label: "Resolved", tone: "success" },
  dismissed: { label: "Dismissed", tone: "neutral" },
};

export const mailboxTurnStatus: Record<MailboxGetResult["turns"][number]["state"], MailboxStatus> =
  {
    pending: { label: "Pending", tone: "neutral" },
    prepared: { label: "Prepared", tone: "neutral" },
    submitted: { label: "Running", tone: "info" },
    failed: { label: "Failed", tone: "error" },
    completed: { label: "Completed", tone: "neutral" },
  };

const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

export function formatMailboxTime(instant: string) {
  const timestamp = Date.parse(instant);
  return Number.isNaN(timestamp) ? instant : timeFormat.format(timestamp);
}

/** A conversation reads oldest first and contains only messages between these two threads. */
export function getMailboxConversationMessages(
  messages: ReadonlyArray<MailboxMessage>,
  threadId: ThreadId,
  peerThreadId: ThreadId,
) {
  return messages
    .filter(
      (message) =>
        (message.fromThreadId === threadId && message.toThreadId === peerThreadId) ||
        (message.fromThreadId === peerThreadId && message.toThreadId === threadId),
    )
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
}
