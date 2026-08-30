import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SqliteDatabase from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const migrationsDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'migrations');

// Computed from the directory, not hardcoded, so this test doesn't need
// editing every time a later milestone adds a migration file — it's
// testing "every .sql file gets applied", not a specific list of names.
const allMigrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

function openMemoryDb(): SqliteDatabase.Database {
  const db = new SqliteDatabase(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

describe('runMigrations', () => {
  it('applies every migration file in order and records them', () => {
    const db = openMemoryDb();
    const applied = runMigrations(db, migrationsDir);
    expect(applied).toEqual(allMigrationFiles);

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(tables).toEqual(expect.arrayContaining(['user', 'session', 'audit_log', 'sync_queue_entry']));
  });

  it('is idempotent — a second run applies nothing', () => {
    const db = openMemoryDb();
    runMigrations(db, migrationsDir);
    const secondRun = runMigrations(db, migrationsDir);
    expect(secondRun).toEqual([]);
  });

  it('records applied migrations in schema_migrations', () => {
    const db = openMemoryDb();
    runMigrations(db, migrationsDir);
    const rows = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(allMigrationFiles);
  });

  it('rolls back a failing migration entirely rather than applying it partially', () => {
    const db = openMemoryDb();
    db.exec('CREATE TABLE user (id INTEGER PRIMARY KEY)'); // collides with migration 0001's CREATE TABLE
    expect(() => runMigrations(db, migrationsDir)).toThrow();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    // schema_migrations itself is created outside the failing transaction,
    // but nothing from the failed 0001 migration (e.g. session) was applied.
    expect(tables).not.toContain('session');
    expect(db.prepare('SELECT id FROM schema_migrations').all()).toEqual([]);
  });
});
