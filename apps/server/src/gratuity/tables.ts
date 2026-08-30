import type { Paisa } from '@pos/shared';
import type { Generated } from 'kysely';

export interface ServiceChargeEntryTable {
  id: Generated<number>;
  order_id: number;
  waiter_id: number;
  amount_minor: Paisa;
  shift_id: number | null;
  created_by: number;
  created_at: string;
  reverses_entry_id: number | null;
}

export interface GratuityTables {
  service_charge_entry: ServiceChargeEntryTable;
}
