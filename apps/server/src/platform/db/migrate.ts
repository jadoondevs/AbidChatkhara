import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type SqliteDatabase from 'better-sqlite3';

/**
 * Apply every numbered `.sql` file in `migrationsDir` that hasn't already
 * been applied, in filename order, each inside its own transaction.
 * Migration files are forward-only and immutable once committed — fix a
 * bad one by adding a new migration, never by editing an applied one (a
 * changed file would silently diverge from what every already-deployed
 * database actually ran).
 *
 * Returns the filenames that were newly applied (empty on a server that's
 * already up to date — this runs on every startup, not just the first).
 */
export function runMigrations(sqlite: SqliteDatabase.Database, migrationsDir: string): string[] {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const alreadyApplied = new Set(
    (sqlite.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((row) => row.id),
  );

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (alreadyApplied.has(file)) continue;
    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    const applyOne = sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
    });
    applyOne();
    newlyApplied.push(file);
  }
  return newlyApplied;
}
