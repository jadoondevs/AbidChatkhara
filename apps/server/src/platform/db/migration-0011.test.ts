import RawSqliteDatabase from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const migrationsDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'migrations');

/**
 * Migration 0011 has to run against databases that already exist — a
 * real till with real users in it, who must still be able to sign in
 * afterwards. So these tests build the schema as it stood BEFORE 0011,
 * put users in it, and then migrate, rather than testing the finished
 * schema (which would never exercise the backfill at all).
 */
function migratedThrough(upTo: string): RawSqliteDatabase.Database {
  const sqlite = new RawSqliteDatabase(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql') && name <= upTo)
    .sort();
  const apply = sqlite.transaction(() => {
    for (const file of files) sqlite.exec(readFileSync(path.join(migrationsDir, file), 'utf8'));
  });
  apply();
  // Record what we applied by hand, so runMigrations picks up from here.
  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const record = sqlite.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');
  for (const file of files) record.run(file, new Date().toISOString());
  return sqlite;
}

function insertUser(sqlite: RawSqliteDatabase.Database, name: string, role = 'server'): number {
  const info = sqlite
    .prepare('INSERT INTO user (name, pin_hash, role, active, created_at) VALUES (?, ?, ?, 1, ?)')
    .run(name, 'scrypt$aa$bb', role, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

interface UserRow {
  id: number;
  name: string;
  username: string;
  pin_hash: string;
  role: string;
  active: number;
}

describe('migration 0011 — adding usernames to an existing database', () => {
  it('preserves every existing user, their id, name, role and credential hash', () => {
    const sqlite = migratedThrough('0010_shifts.sql');
    const ids = [
      insertUser(sqlite, 'Amina Qureshi', 'admin'),
      insertUser(sqlite, 'Danish Raza', 'manager'),
      insertUser(sqlite, 'Sana Iqbal', 'cashier'),
      insertUser(sqlite, 'Faisal Ahmed', 'server'),
      insertUser(sqlite, 'Hina Malik', 'server'),
    ];

    runMigrations(sqlite, migrationsDir);

    const rows = sqlite.prepare('SELECT * FROM user ORDER BY id').all() as UserRow[];
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(rows.map((r) => r.name)).toEqual(['Amina Qureshi', 'Danish Raza', 'Sana Iqbal', 'Faisal Ahmed', 'Hina Malik']);
    expect(rows.map((r) => r.role)).toEqual(['admin', 'manager', 'cashier', 'server', 'server']);
    // Nobody's credential is touched: they sign in with what they had.
    expect(rows.every((r) => r.pin_hash === 'scrypt$aa$bb')).toBe(true);
    sqlite.close();
  });

  it('backfills a usable username from the first word of each name', () => {
    const sqlite = migratedThrough('0010_shifts.sql');
    insertUser(sqlite, 'Amina Qureshi', 'admin');
    insertUser(sqlite, 'Danish Raza', 'manager');

    runMigrations(sqlite, migrationsDir);

    const rows = sqlite.prepare('SELECT username FROM user ORDER BY id').all() as { username: string }[];
    expect(rows.map((r) => r.username)).toEqual(['amina', 'danish']);
    sqlite.close();
  });

  it('disambiguates two people who share a first name, rather than failing', () => {
    const sqlite = migratedThrough('0010_shifts.sql');
    const first = insertUser(sqlite, 'Ali Khan');
    const second = insertUser(sqlite, 'Ali Ahmed');
    const alone = insertUser(sqlite, 'Sana Iqbal');

    runMigrations(sqlite, migrationsDir);

    const rows = sqlite.prepare('SELECT id, username FROM user ORDER BY id').all() as { id: number; username: string }[];
    expect(rows.find((r) => r.id === first)?.username).toBe(`ali.${first}`);
    expect(rows.find((r) => r.id === second)?.username).toBe(`ali.${second}`);
    expect(rows.find((r) => r.id === alone)?.username).toBe('sana');
    sqlite.close();
  });

  it('strips punctuation a login form could not round-trip', () => {
    const sqlite = migratedThrough('0010_shifts.sql');
    insertUser(sqlite, "O'Brien Patrick");
    insertUser(sqlite, 'Jean-Luc Picard');

    runMigrations(sqlite, migrationsDir);

    const rows = sqlite.prepare('SELECT username FROM user ORDER BY id').all() as { username: string }[];
    expect(rows.map((r) => r.username)).toEqual(['obrien', 'jeanluc']);
    sqlite.close();
  });

  it('falls back to a guaranteed-unique name when one cannot be derived', () => {
    const sqlite = migratedThrough('0010_shifts.sql');
    const id = insertUser(sqlite, '...');

    runMigrations(sqlite, migrationsDir);

    const row = sqlite.prepare('SELECT username FROM user WHERE id = ?').get(id) as { username: string };
    expect(row.username).toBe(`user${id}`);
    sqlite.close();
  });

  it('leaves the resulting usernames unique, as the index requires', () => {
    const sqlite = migratedThrough('0010_shifts.sql');
    for (const name of ['Ali Khan', 'Ali Ahmed', 'Ali Raza', 'Sana Iqbal', '...', '..']) insertUser(sqlite, name);

    runMigrations(sqlite, migrationsDir);

    const rows = sqlite.prepare('SELECT username FROM user').all() as { username: string }[];
    expect(new Set(rows.map((r) => r.username)).size).toBe(rows.length);
    sqlite.close();
  });

  it('runs on an empty database without error', () => {
    const sqlite = migratedThrough('0010_shifts.sql');
    expect(() => runMigrations(sqlite, migrationsDir)).not.toThrow();
    sqlite.close();
  });

  it('is idempotent — a second startup applies nothing', () => {
    const sqlite = migratedThrough('0010_shifts.sql');
    insertUser(sqlite, 'Amina Qureshi', 'admin');

    const first = runMigrations(sqlite, migrationsDir);
    expect(first.length).toBeGreaterThan(0);
    expect(runMigrations(sqlite, migrationsDir)).toEqual([]);
    sqlite.close();
  });
});

describe('migration 0014 — orders and lines that already exist', () => {
  it('marks already-voided lines as voids, not corrections', () => {
    const sqlite = migratedThrough('0013_payment_accounts.sql');
    const actorId = insertUser(sqlite, 'Amina Qureshi', 'admin');
    sqlite
      .prepare(
        `INSERT INTO "order" (order_type, channel, opened_at, opened_by, status, subtotal_minor, order_discount_minor,
           net_sales_minor, tax_minor, service_charge_minor, rounding_adjustment_minor, total_minor, version)
         VALUES ('takeaway', 'customer', ?, ?, 'open', 0, 0, 0, 0, 0, 0, 0, 0)`,
      )
      .run(new Date().toISOString(), actorId);
    sqlite.prepare("INSERT INTO category (name, sort_order, active) VALUES ('Mains', 1, 1)").run();
    sqlite.prepare("INSERT INTO item (category_id, name, active) VALUES (1, 'Karahi', 1)").run();
    sqlite
      .prepare(
        `INSERT INTO order_line (order_id, item_id, qty, unit_price_minor, gross_minor, prorated_discount_minor,
           net_sales_minor, allocation_base_minor, voided, void_reason)
         VALUES (1, 1, 1, 50000, 50000, 0, 50000, 50000, 1, 'sent back')`,
      )
      .run();

    runMigrations(sqlite, migrationsDir);

    const row = sqlite.prepare('SELECT void_kind FROM order_line WHERE id = 1').get() as { void_kind: string };
    expect(row.void_kind).toBe('void');
    sqlite.close();
  });

  it('back-dates first_billed_at for orders that were already billed or closed', () => {
    const sqlite = migratedThrough('0013_payment_accounts.sql');
    const actorId = insertUser(sqlite, 'Amina Qureshi', 'admin');
    const insert = sqlite.prepare(
      `INSERT INTO "order" (order_type, channel, opened_at, billed_at, closed_at, opened_by, status, subtotal_minor,
         order_discount_minor, net_sales_minor, tax_minor, service_charge_minor, rounding_adjustment_minor, total_minor, version)
       VALUES ('takeaway', 'customer', ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0)`,
    );
    insert.run('2026-08-31T10:00:00.000Z', '2026-08-31T11:00:00.000Z', null, actorId, 'billed');
    insert.run('2026-08-31T10:00:00.000Z', null, '2026-08-31T12:00:00.000Z', actorId, 'closed');
    insert.run('2026-08-31T10:00:00.000Z', null, null, actorId, 'open');

    runMigrations(sqlite, migrationsDir);

    const rows = sqlite.prepare('SELECT id, first_billed_at FROM "order" ORDER BY id').all() as {
      id: number;
      first_billed_at: string | null;
    }[];
    expect(rows[0]?.first_billed_at).toBe('2026-08-31T11:00:00.000Z');
    expect(rows[1]?.first_billed_at).toBe('2026-08-31T12:00:00.000Z');
    // An order that never got as far as a bill has nothing to back-date.
    expect(rows[2]?.first_billed_at).toBeNull();
    sqlite.close();
  });
});
