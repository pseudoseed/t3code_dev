import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN mailbox_pending_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN mailbox_revision INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE TABLE IF NOT EXISTS projection_mailbox_links (
    thread_id TEXT NOT NULL, peer_thread_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, peer_thread_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS projection_mailbox_messages (
    id TEXT PRIMARY KEY, from_thread_id TEXT NOT NULL, to_thread_id TEXT NOT NULL,
    execution_id TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT,
    state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, queued_sequence INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS mailbox_inbox ON projection_mailbox_messages (to_thread_id, state, created_at, id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS mailbox_outbox ON projection_mailbox_messages (from_thread_id, execution_id, created_at, id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS projection_mailbox_turns (
    thread_id TEXT NOT NULL, execution_id TEXT NOT NULL, turn_id TEXT,
    state TEXT NOT NULL, incoming_json TEXT NOT NULL, created_at TEXT NOT NULL,
    turn_key TEXT NOT NULL, provider_session_id TEXT, prepared_sequence INTEGER NOT NULL,
    PRIMARY KEY (thread_id, execution_id)
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS mailbox_turn_key ON projection_mailbox_turns (turn_key)`;
  yield* sql`CREATE TABLE IF NOT EXISTS projection_mailbox_reads (
    thread_id TEXT NOT NULL, execution_id TEXT NOT NULL, message_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, execution_id, message_id)
  )`;
});
