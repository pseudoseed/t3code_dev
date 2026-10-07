import {
  MailboxError,
  MessageId,
  ThreadId,
  type MailboxGetInput,
  type MailboxGetResult,
  type MailboxMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { formatMailboxConversationExport, loadMailboxConversation } from "./mailboxExport.ts";

const threadId = ThreadId.make("current");
const peerThreadId = ThreadId.make("peer");
const input = { threadId, peerThreadId };
const createdAt = "2026-10-07T12:00:00.000Z";
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const message = (index: number): MailboxMessage => ({
  id: `message-${String(index).padStart(2, "0")}`,
  fromThreadId: index % 2 === 0 ? threadId : peerThreadId,
  toThreadId: index % 2 === 0 ? peerThreadId : threadId,
  executionId: MessageId.make(`execution-${index}`),
  body: `Line one ${index}\n  Line two: %_ “文字”`,
  replyTo: index === 0 ? null : `message-${String(index - 1).padStart(2, "0")}`,
  state: index === 0 ? "resolved" : "queued",
  createdAt,
  updatedAt: "2026-10-07T12:01:00.000Z",
});
const page = (
  messages: MailboxMessage[],
  nextCursor: MailboxGetResult["nextCursor"] = null,
): MailboxGetResult => ({
  peers: [peerThreadId],
  pendingCount: 0,
  messages,
  turns: [],
  nextCursor,
  nextTurnCursor: null,
});

describe("mailbox conversation export", () => {
  it.effect(
    "loads every page in both directions and exports chronological messages with exact audit fields",
    () =>
      Effect.gen(function* () {
        const messages = Array.from({ length: 65 }, (_, i) => message(i));
        const pages = [
          page(messages.slice(35).toReversed(), { createdAt, id: messages[35]!.id }),
          page(messages.slice(5, 35).toReversed(), { createdAt, id: messages[5]!.id }),
          page(messages.slice(0, 5).toReversed()),
        ];
        const calls: MailboxGetInput[] = [];
        const loaded = yield* loadMailboxConversation(input, (request) => {
          calls.push(request);
          return Effect.succeed(pages[calls.length - 1]!);
        });
        expect(calls).toEqual([
          input,
          { ...input, before: pages[0]!.nextCursor },
          { ...input, before: pages[1]!.nextCursor },
        ]);
        expect(loaded).toEqual(messages);
        const participants = [
          { threadId, title: "API / backend", project: "Project A" },
          { threadId: peerThreadId, title: "UI: frontend", project: "Project B" },
        ] as const;
        const exported = formatMailboxConversationExport({
          participants,
          messages: loaded,
          exportedAt: createdAt,
        });
        expect(decodeJson(exported.contents)).toEqual({
          version: 1,
          exportedAt: createdAt,
          participants,
          messages,
        });
        expect(exported.filename).toBe("mailbox-API-backend-UI-frontend.json");
      }),
  );

  it.effect("exports an empty conversation and safely bounds unavailable or unusual titles", () =>
    Effect.gen(function* () {
      const loaded = yield* loadMailboxConversation(input, () => Effect.succeed(page([])));
      const exported = formatMailboxConversationExport({
        participants: [
          { threadId, title: "../\\\n", project: null },
          { threadId: peerThreadId, title: "A".repeat(1_000), project: null },
        ],
        messages: loaded,
        exportedAt: createdAt,
      });
      expect(exported.filename).toBe(`mailbox-thread-${"A".repeat(60)}.json`);
      expect(decodeJson(exported.contents)).toMatchObject({ messages: [] });
    }),
  );

  it.effect("returns failure rather than a partial export if an older page fails", () =>
    Effect.gen(function* () {
      let calls = 0;
      const error = new MailboxError({ message: "Environment disconnected" });
      const result = yield* loadMailboxConversation(input, () => {
        calls += 1;
        return calls === 1
          ? Effect.succeed(page([message(1)], { createdAt, id: "cursor" }))
          : Effect.fail(error);
      }).pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: error });
    }),
  );

  it.effect("fails when the server repeats a page cursor", () =>
    Effect.gen(function* () {
      let calls = 0;
      const result = yield* loadMailboxConversation(input, () => {
        calls += 1;
        return Effect.succeed(page([message(0)], { createdAt, id: "cursor" }));
      }).pipe(Effect.result);
      expect(calls).toBe(2);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { message: "Conversation export could not advance to the next page." },
      });
    }),
  );
});
