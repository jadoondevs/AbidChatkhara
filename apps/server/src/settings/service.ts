import type { Kysely } from 'kysely';
import { recordAudit } from '../identity/audit.js';
import type { ActorContext } from '../identity/service.js';
import type { Database } from '../platform/db/types.js';
import type { PrinterTarget } from '../platform/printing/client.js';
import {
  defaultsFor,
  SETTING_KEYS,
  SETTING_SCHEMAS,
  type AllSettings,
  type PrinterSettings,
  type SettingKey,
} from './schema.js';

/**
 * Reads one setting group, falling back to that group's defaults when
 * it has never been saved — or when what is stored no longer parses
 * (a hand-edited row, or a field this version of the code has since
 * tightened). A settings read is on the path of every bill print, so it
 * must never be the thing that fails one.
 *
 * Partial documents are filled in field-by-field from the defaults, so
 * adding a new setting to a schema does not invalidate what a
 * restaurant has already saved.
 */
export async function getSetting<K extends SettingKey>(
  db: Kysely<Database>,
  key: K,
): Promise<ReturnType<typeof defaultsFor<K>>> {
  const row = await db.selectFrom('app_setting').select('value_json').where('key', '=', key).executeTakeFirst();
  if (!row) return defaultsFor(key);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(row.value_json);
  } catch {
    return defaultsFor(key);
  }

  const result = SETTING_SCHEMAS[key].safeParse(parsedJson);
  return (result.success ? result.data : defaultsFor(key)) as ReturnType<typeof defaultsFor<K>>;
}

export async function getAllSettings(db: Kysely<Database>): Promise<AllSettings> {
  const [restaurant, receipt, serviceCharge, printer] = await Promise.all([
    getSetting(db, 'restaurant'),
    getSetting(db, 'receipt'),
    getSetting(db, 'serviceCharge'),
    getSetting(db, 'printer'),
  ]);
  return { restaurant, receipt, serviceCharge, printer };
}

/**
 * Writes one setting group. The incoming document is parsed by that
 * group's own schema first, so an unknown or malformed field is
 * rejected at the boundary rather than stored and discovered at print
 * time. Every save is audited with the previous value, like every other
 * mutation in the system.
 */
export async function saveSetting<K extends SettingKey>(
  db: Kysely<Database>,
  key: K,
  value: unknown,
  actor: ActorContext,
): Promise<ReturnType<typeof defaultsFor<K>>> {
  const parsed = SETTING_SCHEMAS[key].parse(value) as ReturnType<typeof defaultsFor<K>>;
  const before = await getSetting(db, key);
  const now = new Date().toISOString();

  await db
    .insertInto('app_setting')
    .values({ key, value_json: JSON.stringify(parsed), updated_at: now, updated_by: actor.actorId })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({ value_json: JSON.stringify(parsed), updated_at: now, updated_by: actor.actorId }),
    )
    .execute();

  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'setting.save',
    entity: 'app_setting',
    entityId: key,
    before,
    after: parsed,
  });

  return parsed;
}

export { SETTING_KEYS };

/**
 * Which printer to talk to: whatever an admin has configured in
 * Settings, else the POS_PRINTER_HOST environment variable the server
 * booted with, else nothing (print routes then answer 503, exactly as
 * before this table existed).
 *
 * Settings wins over the environment deliberately — an admin who has
 * typed an address into the POS is stating the current truth, and
 * should not have to know that a stale value exists in a `.env` file on
 * the machine. Setting `enabled: false` disables printing outright,
 * whatever the environment says, so a restaurant whose printer is away
 * for repair can stop every print attempt from stalling on a connect
 * timeout.
 */
export function resolvePrinterTarget(settings: PrinterSettings, fallback: PrinterTarget | null): PrinterTarget | null {
  if (!settings.enabled) return null;
  if (settings.host.trim() !== '') return { host: settings.host.trim(), port: settings.port };
  return fallback;
}
