import { z } from 'zod';

/**
 * Every setting group's shape, in one place. The `app_setting` table
 * stores an opaque JSON document per group (migration 0012), so THIS is
 * what actually guarantees a print template never receives a malformed
 * value — a row hand-edited in `sqlite3` fails the parse and the group
 * falls back to its defaults rather than crashing a print.
 *
 * Every field has a default, so a restaurant that has never opened the
 * Settings screen still gets a working, obviously-unconfigured receipt
 * rather than an empty one. No default names a real restaurant.
 */

export const restaurantSettingsSchema = z.object({
  name: z.string().max(60).default(''),
  addressLine1: z.string().max(80).default(''),
  addressLine2: z.string().max(80).default(''),
  phone: z.string().max(40).default(''),
  /** Printed under the phone number — an NTN, an STRN, a licence
   * number; whatever this restaurant is required to show. */
  registrationLine: z.string().max(80).default(''),
});

export const receiptSettingsSchema = z.object({
  /** Blank means "use the restaurant name" — one fewer thing to keep in
   * step when the restaurant is renamed. */
  headerName: z.string().max(60).default(''),
  showAddress: z.boolean().default(true),
  showPhone: z.boolean().default(true),
  headerNote: z.string().max(120).default(''),
  footerMessage: z.string().max(120).default('Thank you'),
  footerNote: z.string().max(120).default(''),
  showOrderNumber: z.boolean().default(true),
  showTable: z.boolean().default(true),
  showWaiter: z.boolean().default(true),
  showPaymentAccounts: z.boolean().default(true),
  /** Extra blank lines before the cut, for printers whose tear bar sits
   * above the print head. */
  feedLines: z.number().int().min(0).max(10).default(3),
});

/**
 * How this restaurant charges for service.
 *
 * A rate in basis points rather than a percentage float, for the same
 * reason money is in paisa: 5% is 500, exactly, and there is no
 * rounding to argue about. `proportionalAmount` in the money module
 * turns it into an amount.
 *
 * Disabled is the shipped default. A restaurant that does not levy a
 * service charge should not have to turn one off, and an installation
 * that has configured nothing must never quietly add 10% to a bill.
 */
export const serviceChargeSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Basis points of net sales — 500 is 5%. Capped well below 100% as a
   * typo guard: a service charge larger than the food is a keying
   * error, not a business model. */
  rateBp: z.number().int().min(0).max(5_000).default(0),
  /** What it is called on the bill, the receipt and the screen. */
  displayName: z.string().min(1).max(40).default('Service charge'),
  /** Most restaurants levy it on table service only — a takeaway
   * customer carried their own food. Off by default so enabling the
   * charge does not silently apply it to counter sales too. */
  dineInOnly: z.boolean().default(true),
});

export const printerSettingsSchema = z.object({
  /** Empty means "not configured here" — the POS_PRINTER_HOST
   * environment variable is then used instead (see settings/service.ts's
   * resolvePrinterTarget). */
  host: z.string().max(255).default(''),
  port: z.number().int().min(1).max(65535).default(9100),
  enabled: z.boolean().default(true),
  /**
   * How dark the printer burns. 0 leaves the printer on its own
   * setting and sends no command; 1-8 is passed through as the ESC/POS
   * print-density level. Thermal darkness is a printer property, and
   * this is the only way to make ORDINARY receipt text dark without
   * emphasising every line and flattening the receipt into one weight.
   * The right value is the one that reads well on the paper — Settings
   * has a test print for exactly that.
   */
  densityLevel: z.number().int().min(0).max(8).default(5),
});

export const SETTING_SCHEMAS = {
  restaurant: restaurantSettingsSchema,
  receipt: receiptSettingsSchema,
  serviceCharge: serviceChargeSettingsSchema,
  printer: printerSettingsSchema,
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;

export const SETTING_KEYS = Object.keys(SETTING_SCHEMAS) as SettingKey[];

export type RestaurantSettings = z.infer<typeof restaurantSettingsSchema>;
export type ReceiptSettings = z.infer<typeof receiptSettingsSchema>;
export type ServiceChargeSettings = z.infer<typeof serviceChargeSettingsSchema>;
export type PrinterSettings = z.infer<typeof printerSettingsSchema>;

export interface AllSettings {
  readonly restaurant: RestaurantSettings;
  readonly receipt: ReceiptSettings;
  readonly serviceCharge: ServiceChargeSettings;
  readonly printer: PrinterSettings;
}

export function defaultsFor<K extends SettingKey>(key: K): z.infer<(typeof SETTING_SCHEMAS)[K]> {
  return SETTING_SCHEMAS[key].parse({}) as z.infer<(typeof SETTING_SCHEMAS)[K]>;
}
