import {
  MailboxError,
  type MailboxGetInput,
  type MailboxGetResult,
  type MailboxMessage,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { getMailboxConversationMessages } from "./mailboxPresentation.ts";

export interface MailboxConversationInput {
  readonly threadId: ThreadId;
  readonly peerThreadId: ThreadId;
}

/** Fetch the complete pair history through bounded pages, independent of the UI's search or page. */
export function loadMailboxConversation<E, R>(
  input: MailboxConversationInput,
  loadPage: (input: MailboxGetInput) => Effect.Effect<MailboxGetResult, E, R>,
) {
  return Effect.gen(function* () {
    const messages: MailboxMessage[] = [];
    const cursors = new Set<string>();
    let before: MailboxGetInput["before"];
    while (true) {
      const page = yield* loadPage({ ...input, ...(before ? { before } : {}) });
      messages.push(...page.messages);
      if (page.nextCursor === null) break;
      const cursorKey = `${page.nextCursor.createdAt.length}:${page.nextCursor.createdAt}${page.nextCursor.id}`;
      if (cursors.has(cursorKey)) {
        return yield* new MailboxError({
          message: "Conversation export could not advance to the next page.",
        });
      }
      cursors.add(cursorKey);
      before = page.nextCursor;
    }
    return getMailboxConversationMessages(messages, input.threadId, input.peerThreadId);
  });
}

interface MailboxParticipant {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly project: string | null;
}

export function formatMailboxConversationExport(input: {
  readonly participants: readonly [MailboxParticipant, MailboxParticipant];
  readonly messages: ReadonlyArray<MailboxMessage>;
  readonly exportedAt: string;
}) {
  const slug = (title: string) =>
    title
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "thread";
  const [current, peer] = input.participants;
  return {
    filename: `mailbox-${slug(current.title)}-${slug(peer.title)}.json`,
    contents: JSON.stringify(
      {
        version: 1,
        exportedAt: input.exportedAt,
        participants: input.participants,
        messages: getMailboxConversationMessages(input.messages, current.threadId, peer.threadId),
      },
      null,
      2,
    ),
  };
}
