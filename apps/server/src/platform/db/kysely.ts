import type SqliteDatabase from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { Database } from './types.js';

export function createDb(sqlite: SqliteDatabase.Database): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
}
