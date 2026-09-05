import type SqliteDatabase from 'better-sqlite3';

/**
 * Clearing the day's trading away for a fresh start, WITHOUT touching the
 * restaurant's own setup.
 *
 * This exists for exactly one moment: the till was tested with pretend
 * orders, and the operator is about to use it for real. The pretend
 * orders, payments and shifts have to go, but the menu, prices,
 * modifiers, users, partners, people, payment methods and settings that
 * were configured must stay — re-doing all of that would be the reason
 * nobody clears the test data and the reports open on nonsense.
 *
 * So this wipes the transactional record and nothing else. It is
 * deliberately NOT reachable from the running app: erasing the sales
 * record is a one-time terminal action taken with the till closed, never
 * a button a cashier can reach mid-service.
 */

/**
 * The transactional tables — the record of trading, and everything that
 * hangs off it. Listed child-first so the delete is valid even with
 * foreign keys enforced, though the reset also drops the constraint for
 * the duration to be safe against the self-references (a reversing
 * payment points at the payment it reverses, and so on).
 *
 * Everything NOT in this list — category, item, item_price, modifier and
 * its groups/links/overrides, item availability and ownership, partner,
 * user, person, app_setting, payment_method, payment_account, tax_rule —
 * is configuration, and is kept.
 */
const TRANSACTIONAL_TABLES = [
  'line_allocation',
  'payment',
  'service_charge_entry',
  'consumption_record',
  'order_line_modifier',
  'order_line',
  'order',
  'shift',
  'audit_log',
  'sync_queue_entry',
] as const;

export interface ResetCounts {
  readonly orders: number;
  readonly payments: number;
  readonly shifts: number;
}

/** How much trading is currently on the books — what the reset would clear. */
export function countTransactional(sqlite: SqliteDatabase.Database): ResetCounts {
  const count = (table: string): number => (sqlite.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
  return { orders: count('order'), payments: count('payment'), shifts: count('shift') };
}

/**
 * Delete every transactional row, restart invoice and order numbering at
 * 1, and leave the catalog and every other setup table untouched. Returns
 * what was on the books before, so the caller can report it.
 *
 * Throws — leaving the database unchanged — if the result would have a
 * dangling reference, which for this fixed set of tables it never should.
 */
export function resetTransactionalData(sqlite: SqliteDatabase.Database): ResetCounts {
  const before = countTransactional(sqlite);

  const hasSqliteSequence =
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get() !== undefined;

  // A PRAGMA toggle is a no-op inside a transaction, so drop the
  // constraint out here and restore it whatever happens.
  sqlite.pragma('foreign_keys = OFF');
  try {
    sqlite.transaction(() => {
      for (const table of TRANSACTIONAL_TABLES) sqlite.prepare(`DELETE FROM "${table}"`).run();

      // Invoices are a legal sequence a customer reads off the receipt;
      // the real record should start at 1, not continue from the test
      // run's numbering.
      sqlite.prepare('UPDATE invoice_counter SET next_value = 1 WHERE id = 1').run();

      // Restart the AUTOINCREMENT ids of the cleared tables too, so the
      // first real order is #1 — but only theirs, never the catalog's,
      // whose ids the kept menu rows still point at.
      if (hasSqliteSequence) {
        const placeholders = TRANSACTIONAL_TABLES.map(() => '?').join(', ');
        sqlite.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${placeholders})`).run(...TRANSACTIONAL_TABLES);
      }
    })();
  } finally {
    sqlite.pragma('foreign_keys = ON');
  }

  const violations = sqlite.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(`reset left ${violations.length} dangling reference(s); the database was not changed`);
  }

  return before;
}
