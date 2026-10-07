import type { MailboxMessage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

// Reserve room for the turn key, instructions and unresolved count outside the JSON array.
export const MAILBOX_CONTEXT_OVERHEAD = 1_600;

/** Large bodies remain durable and readable without blocking this or later messages. */
export const encodeMailboxSnapshot = Effect.fn("Mailbox.encodeSnapshot")(function* (
  messages: ReadonlyArray<MailboxMessage>,
  contextBudget: number,
) {
  const entries: string[] = [];
  const incoming: string[] = [];
  let remaining = Math.max(0, contextBudget - MAILBOX_CONTEXT_OVERHEAD - 2);
  for (const { id, fromThreadId, body, replyTo } of messages.slice(0, 8)) {
    let entry = yield* encode({ id, fromThreadId, body, replyTo });
    const separatorLength = entries.length === 0 ? 0 : 1;
    if (entry.length + separatorLength > remaining) {
      entry = yield* encode({ id, fromThreadId, replyTo, bodyAvailableVia: "mailbox_read" });
    }
    if (entry.length + separatorLength > remaining) break;
    entries.push(entry);
    incoming.push(id);
    remaining -= entry.length + separatorLength;
  }
  return { incoming, encoded: `[${entries.join(",")}]` };
});
