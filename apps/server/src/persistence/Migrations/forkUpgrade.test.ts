import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.effect("upgrades the released fork without losing device credentials or mailbox state", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 53 });
    yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
      VALUES ('remote-device', 'phone', '["admin"]', 'pairing', '2026-09-01', '2027-09-01')`;
    yield* sql`INSERT INTO projection_mailbox_messages
      (id, from_thread_id, to_thread_id, execution_id, body, state, created_at, updated_at, queued_sequence)
      VALUES ('pending-mail', 'sender', 'receiver', 'execution', 'Keep this message', 'queued', '2026-09-01', '2026-09-01', 1)`;
    const sessions = yield* sql`SELECT * FROM auth_sessions`;
    const messages = yield* sql`SELECT * FROM projection_mailbox_messages`;
    const applied = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

    const upgraded = yield* runMigrations();
    assert.deepStrictEqual(
      upgraded.map(([id]) => id),
      [54, 55, 56],
    );
    assert.deepStrictEqual(yield* sql`SELECT * FROM auth_sessions`, sessions);
    assert.deepStrictEqual(yield* sql`SELECT * FROM projection_mailbox_messages`, messages);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 53 ORDER BY migration_id`,
      applied,
    );
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
    for (const name of [
      "subagent_model_selection_json",
      "last_viewed_at",
      "mailbox_revision",
      "title_state_json",
    ]) {
      assert.ok(
        columns.some((column) => column.name === name),
        name,
      );
    }
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
