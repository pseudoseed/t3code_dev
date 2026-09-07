import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { MailboxBody } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

await NodeTest.test(
  "mailbox message validation preserves multiline contracts and rejects invalid bodies",
  async () => {
    const decode = Schema.decodeUnknownSync(MailboxBody);
    const body = "GET /items\nResponse: { items: string[] }";
    NodeAssert.equal(decode(body), body);
    const release = new Promise((resolve) => process.once("message", resolve));
    process.send({ type: "test-running" });
    NodeAssert.deepEqual(await release, { type: "release-test" });
    NodeAssert.throws(() => decode("   "));
    NodeAssert.throws(() => decode("x".repeat(8_001)));
    NodeAssert.equal(decode(body), body);
  },
);
process.send({ type: "test-passed" });
process.disconnect();
