import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import SubagentModelSelection from "./ForkMigrations/001_SubagentModelSelection.ts";
import ThreadViewed from "./ForkMigrations/002_ThreadViewed.ts";
import AgentMailbox from "./ForkMigrations/003_AgentMailbox.ts";
import MailboxWake from "./ForkMigrations/004_MailboxWake.ts";
import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";

const legacyForkEntries = [
  ...migrationEntries.filter(([id]) => id <= 47),
  [48, "ProjectionThreadSubagentModelSelection", SubagentModelSelection],
  [49, "ProjectionThreadsLastViewedAt", ThreadViewed],
  [50, "AgentMailbox", AgentMailbox],
  [51, "MailboxWake", MailboxWake],
  ...migrationEntries
    .filter(([id]) => id >= 48 && id <= 54)
    .map(([id, name, migration]) => [id + 4, name, migration] as const),
] as const;

const prepareLegacyFork = (through: number) =>
  Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        legacyForkEntries
          .filter(([id]) => id <= through)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });

it.effect.each([48, 49, 50, 51, 53, 56, 58])(
  "upgrades fork schema %s to V2 without losing credentials or mailbox messages",
  (startingMigration) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* prepareLegacyFork(startingMigration);
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('phone', 'owner', '["admin"]', 'pairing', '2026-09-01', '2027-09-01')`;
      if (startingMigration >= 50) {
        yield* sql`INSERT INTO projection_mailbox_messages
          (id, from_thread_id, to_thread_id, execution_id, body, state, created_at, updated_at, queued_sequence)
          VALUES ('pending', 'sender', 'receiver', 'execution', 'Keep this message', 'queued', '2026-09-01', '2026-09-01', 1)`;
      }
      const credentials = yield* sql`SELECT * FROM auth_sessions`;
      yield* runMigrations();
      assert.deepStrictEqual(yield* sql`SELECT * FROM auth_sessions`, credentials);
      const messages = yield* sql`SELECT id, body, state FROM projection_mailbox_messages`;
      assert.deepStrictEqual(
        messages,
        startingMigration >= 50
          ? [{ id: "pending", body: "Keep this message", state: "queued" }]
          : [],
      );
      const history = yield* sql<{ migration_id: number; name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name]),
        migrationManifest.map(([id, name]) => [id, name]),
      );
      const tables = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
      assert.includeMembers(
        tables.map((row) => row.name),
        ["orchestration_v2_events", "orchestration_v2_projection_threads", "pseudocode_migrations"],
      );
      const forkHistory = yield* sql`SELECT * FROM pseudocode_migrations ORDER BY migration_id`;
      assert.lengthOf(forkHistory, 4);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM pseudocode_migrations ORDER BY migration_id`,
        forkHistory,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("adds fork schema to an upstream database without changing its migration history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Migrator.make({})({
      loader: Migrator.fromRecord(
        Object.fromEntries(
          migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
        ),
      ),
    });
    const upstreamHistory = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      upstreamHistory,
    );
    assert.lengthOf(yield* sql`SELECT * FROM pseudocode_migrations`, 4);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("rejects an unknown fork ledger without partially rewriting history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* prepareLegacyFork(58);
    yield* sql`UPDATE effect_sql_migrations SET name = 'UnknownLocalMigration' WHERE migration_id = 57`;
    const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    const result = yield* runMigrations().pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      history,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_events'`,
      [],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
