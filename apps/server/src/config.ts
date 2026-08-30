import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrinterTarget } from './platform/printing/client.js';

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly dbPath: string;
  readonly migrationsDir: string;
  /** null until POS_PRINTER_HOST is set — no admin screen for this in
   * the spec's screen list, so it's environment-configured like
   * everything else here, not a database table. Printing simply doesn't
   * happen (a clear error, not a crash) until this is set. */
  readonly printer: PrinterTarget | null;
}

/**
 * Configuration comes from the environment (see .env.example), never from
 * a committed file — this is where a printer IP or a real backup path
 * would live, and none of that belongs in git (see .gitignore).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.POS_PORT ?? 4000),
    host: env.POS_HOST ?? '0.0.0.0',
    dbPath: env.POS_DB_PATH ?? path.resolve(process.cwd(), 'data', 'pos.sqlite'),
    migrationsDir: fileURLToPath(new URL('./platform/db/migrations', import.meta.url)),
    printer: env.POS_PRINTER_HOST ? { host: env.POS_PRINTER_HOST, port: Number(env.POS_PRINTER_PORT ?? 9100) } : null,
  };
}
