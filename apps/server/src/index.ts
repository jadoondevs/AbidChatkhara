import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { scheduleOwnershipIntegrityCheck } from './partners/service.js';
import { openSqlite } from './platform/db/connection.js';
import { createDb } from './platform/db/kysely.js';
import { runMigrations } from './platform/db/migrate.js';

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(path.dirname(config.dbPath), { recursive: true });

  const sqlite = openSqlite(config.dbPath);
  const applied = runMigrations(sqlite, config.migrationsDir);
  if (applied.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`Applied migrations: ${applied.join(', ')}`);
  }

  const db = createDb(sqlite);
  const app = await buildApp({ db, printer: config.printer });
  scheduleOwnershipIntegrityCheck(db);

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
