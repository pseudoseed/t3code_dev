import type { ScopedThreadRef } from "@t3tools/contracts";

const MAILBOX_OPEN_EVENT = "t3code:open-agent-mailbox";

export function openAgentMailbox(threadRef: ScopedThreadRef): void {
  window.dispatchEvent(new CustomEvent(MAILBOX_OPEN_EVENT, { detail: threadRef }));
}

export function onOpenAgentMailbox(listener: (threadRef: ScopedThreadRef) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<ScopedThreadRef>).detail);
  window.addEventListener(MAILBOX_OPEN_EVENT, handler);
  return () => window.removeEventListener(MAILBOX_OPEN_EVENT, handler);
}
