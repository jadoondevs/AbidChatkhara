import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import RawSqliteDatabase from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite } from './connection.js';
import { createDb } from './kysely.js';
import { runMigrations } from './migrate.js';

const migrationsDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'migrations');

/**
 * Proves the backup/restore procedure documented in README.md actually
 * works: SQLite's online backup API (what the `sqlite3 <db> ".backup ..."`
 * CLI command in the README invokes; better-sqlite3's `.backup()` method
 * is the same underlying mechanism, used here because this environment
 * doesn't have the standalone sqlite3 CLI installed) can snapshot the
 * database file while it's open — i.e. while the server would still be
 * running — and the snapshot restores to an exact, working replica.
 */
describe('backup / restore procedure', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('backs up a live (open, WAL-mode) database and restores it to an identical, working copy', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'pos-backup-'));
    const liveDbPath = path.join(dir, 'pos.sqlite');
    const backupPath = path.join(dir, 'pos-snapshot.sqlite');

    // 1. Stand up a "live" database, the way the server does on startup.
    const live = openSqlite(liveDbPath);
    runMigrations(live, migrationsDir);
    const liveKysely = createDb(live);
    const created = await liveKysely
      .insertInto('user')
      .values({
        name: 'Ayesha',
        pin_hash: 'scrypt$deadbeef$deadbeef',
        role: 'admin',
        active: 1,
        created_at: new Date().toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // 2. Back it up online — the database handle stays open throughout,
    // simulating a backup taken while the server is running and serving
    // requests.
    await live.backup(backupPath);

    // 3. "Restart" the server against the backup, the way the documented
    // restore procedure does: stop the server (close the handle), move
    // the live file aside, put the backup in its place, start again.
    live.close();
    renameSync(liveDbPath, `${liveDbPath}.bak`);
    renameSync(backupPath, liveDbPath);

    const restored = openSqlite(liveDbPath);
    const stillApplied = runMigrations(restored, migrationsDir); // startup always runs this; should be a no-op
    expect(stillApplied).toEqual([]);

    const restoredKysely = createDb(restored);
    const row = await restoredKysely.selectFrom('user').selectAll().where('id', '=', created.id).executeTakeFirst();
    expect(row).toMatchObject({ name: 'Ayesha', role: 'admin', active: 1 });

    restored.close();
  });

  it('restoring does not silently lose data — the restored row count matches exactly', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'pos-backup-'));
    const liveDbPath = path.join(dir, 'pos.sqlite');
    const backupPath = path.join(dir, 'pos-snapshot.sqlite');

    const live = openSqlite(liveDbPath);
    runMigrations(live, migrationsDir);
    const liveKysely = createDb(live);
    for (const name of ['Ayesha', 'Bilal', 'Chand']) {
      await liveKysely
        .insertInto('user')
        .values({
          name,
          pin_hash: 'scrypt$deadbeef$deadbeef',
          role: 'server',
          active: 1,
          created_at: new Date().toISOString(),
        })
        .execute();
    }

    await live.backup(backupPath);
    live.close();

    const restored = new RawSqliteDatabase(backupPath, { readonly: true });
    const count = restored.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number };
    expect(count.n).toBe(3);
    restored.close();
  });
});
