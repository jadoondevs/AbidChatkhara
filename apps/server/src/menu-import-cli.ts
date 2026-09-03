import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from '@pos/shared';
import { importMenu, planMenuImport, readMenuFile, type MenuImportAction } from './catalog/menu-import.js';
import { loadConfig } from './config.js';
import { openSqlite } from './platform/db/connection.js';
import { createDb } from './platform/db/kysely.js';
import { runMigrations } from './platform/db/migrate.js';

const DEFAULT_MENU = fileURLToPath(new URL('../menu/abid-chatkhara.json', import.meta.url));

function describe(action: MenuImportAction): string {
  const price = (minor: number | null): string => (minor === null ? 'nothing' : format(minor as never));
  switch (action.kind) {
    case 'create-category':
      return `category   + ${action.name}`;
    case 'create-group':
      return `group      + ${action.name}`;
    case 'create-option':
      return `option     + ${action.group} / ${action.name}`;
    case 'create-item':
      return `item       + ${action.at.category} / ${action.at.name}`;
    case 'set-price':
      return `price        ${action.at.category} / ${action.at.name}: ${price(action.fromMinor)} → ${price(action.toMinor)}`;
    case 'link-group':
      return `sizes        ${action.at.category} / ${action.at.name}: ${action.group}`;
    case 'set-modifier-price':
      return `size price   ${action.at.name} / ${action.option}: ${price(action.fromMinor)} → ${price(action.toMinor)}`;
  }
}

/**
 * `npm run menu:import [-- --file path.json] [--plan]`
 *
 * Loads a restaurant's real menu into the till. Safe to re-run: it only
 * writes what differs, and a price that differs becomes a new
 * effective-dated row rather than an edit to the old one, so the till's
 * price history survives. `--plan` prints exactly what a real run would
 * do and writes nothing.
 *
 * The preview flag is `--plan` and not the more obvious `--dry-run`
 * because npm claims `--dry-run` for itself: `npm run menu:import --
 * --dry-run` never reaches this script, and the "preview" would import
 * the whole menu for real. A flag that silently means its own opposite
 * is not a flag worth keeping.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--plan');
  const fileFlag = args.indexOf('--file');
  const menuPath = fileFlag === -1 ? DEFAULT_MENU : args[fileFlag + 1];
  if (menuPath === undefined) throw new Error('--file needs a path');

  const config = loadConfig();
  mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const sqlite = openSqlite(config.dbPath);
  runMigrations(sqlite, config.migrationsDir);
  const db = createDb(sqlite);

  const file = readMenuFile(menuPath);
  const itemCount = file.categories.reduce((total, category) => total + category.items.length, 0);

  /* eslint-disable no-console -- a CLI's whole output is its console */
  console.log(`${menuPath}`);
  console.log(`  ${file.categories.length} categories, ${itemCount} items, ${file.modifierGroups.length} size groups`);
  console.log(`${dryRun ? 'Would change (--plan: nothing is written)' : 'Changing'} ${config.dbPath}:`);

  const result = dryRun
    ? await planMenuImport(db, file)
    : await importMenu(db, file, { actorId: null, terminalId: 'menu-import' });

  if (result.actions.length === 0) {
    console.log('  nothing — the menu is already loaded exactly as the file describes it');
  } else {
    for (const action of result.actions) console.log(`  ${describe(action)}`);
    console.log(`  (${result.actions.length} change${result.actions.length === 1 ? '' : 's'}, ${result.unchangedItems} item(s) already correct)`);
  }

  if (!dryRun && result.actions.length > 0) {
    console.log('');
    console.log('Imported items are owned by NOBODY and cannot be sold until they are.');
    console.log('Set that in Partners → Ownership by category; the Menu screen flags every item still waiting.');
  }
  /* eslint-enable no-console */

  sqlite.close();
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
