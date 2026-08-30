import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly dbPath: string;
  readonly migrationsDir: string;
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
  };
}
