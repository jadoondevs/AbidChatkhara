import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type SqliteDatabase from 'better-sqlite3';
import RawSqliteDatabase from 'better-sqlite3';
import type { Kysely } from 'kysely';
import { createDb } from './kysely.js';
import { runMigrations } from './migrate.js';
import type { Database } from './types.js';
import { defaultsFor } from '../../settings/schema.js';
import { saveSetting } from '../../settings/service.js';

const migrationsDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'migrations');

/**
 * A fresh, fully-migrated in-memory database for tests. Every test that
 * needs a real database gets its own isolated instance — never a shared
 * one — so tests can run in any order with no cross-test state.
 */
export function createTestDb(): { sqlite: SqliteDatabase.Database; db: Kysely<Database> } {
  const sqlite = new RawSqliteDatabase(':memory:');
  sqlite.pragma('foreign_keys = ON');
  runMigrations(sqlite, migrationsDir);
  return { sqlite, db: createDb(sqlite) };
}

/**
 * Switch the restaurant's service charge on for a test.
 *
 * Needed by any test that bills with a service charge, because a
 * disabled charge is now zero by rule and an override is refused
 * outright rather than silently ignored — see ordering's
 * `computeServiceCharge`. Tests about a CONFIGURED rate pass one;
 * tests that hand-enter an amount just need the feature on.
 */
export async function enableServiceCharge(
  db: Kysely<Database>,
  actor: { actorId: number | null; terminalId: string },
  rateBp = 0,
): Promise<void> {
  await saveSetting(db, 'serviceCharge', { ...defaultsFor('serviceCharge'), enabled: true, rateBp }, actor);
}
