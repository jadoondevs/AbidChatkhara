import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type SqliteDatabase from 'better-sqlite3';
import RawSqliteDatabase from 'better-sqlite3';
import type { Kysely } from 'kysely';
import { createDb } from './kysely.js';
import { runMigrations } from './migrate.js';
import type { Database } from './types.js';

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
