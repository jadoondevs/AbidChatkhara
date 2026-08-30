import SqliteDatabase from 'better-sqlite3';

/**
 * Open the SQLite database file in WAL mode. WAL is what lets one writer
 * (this server) and any number of readers (report queries running while
 * an order closes) work against the file concurrently without blocking
 * each other — the concurrency story this system relies on instead of a
 * client-server database.
 */
export function openSqlite(filePath: string): SqliteDatabase.Database {
  const db = new SqliteDatabase(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // NORMAL is safe under WAL: a power loss can lose the last commit's durability
  // guarantee at the OS level but never corrupts the database file itself.
  db.pragma('synchronous = NORMAL');
  return db;
}
