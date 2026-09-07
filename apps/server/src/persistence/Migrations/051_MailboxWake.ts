import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_mailbox_turns ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`;
  yield* sql`CREATE TABLE projection_mailbox_controls (
    thread_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, reason TEXT
  )`;
});
