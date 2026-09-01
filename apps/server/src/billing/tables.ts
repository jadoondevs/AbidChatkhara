import type { Paisa } from '@pos/shared';
import type { Generated } from 'kysely';

export type PaymentMethodKind = 'cash' | 'wallet' | 'bank_transfer' | 'card';

export interface PaymentMethodTable {
  id: Generated<number>;
  code: string;
  display_name: string;
  kind: PaymentMethodKind;
  active: number;
  sort_order: number;
  print_on_bill: number;
  account_title: string | null;
  account_number: string | null;
  bank_name: string | null;
  instructions_line: string | null;
}

export interface PaymentTable {
  id: Generated<number>;
  order_id: number;
  payment_method_id: number;
  amount_minor: Paisa;
  reference_no: string | null;
  received_by: number;
  received_at: string;
  reversed_by_payment_id: number | null;
  payment_account_id: number | null;
  /** Cash only: handed over, and handed back. Never used to derive a
   * financial figure — see migration 0013. */
  tendered_minor: Paisa | null;
  change_minor: Paisa | null;
}

export interface PaymentAccountTable {
  id: Generated<number>;
  payment_method_id: number;
  label: string;
  account_title: string | null;
  account_number: string | null;
  bank_name: string | null;
  active: number;
  sort_order: number;
  created_at: string;
  /** Nullable at the database layer only because SQLite's ALTER TABLE
   * cannot add a NOT NULL column without a default; migration 0015
   * backfills every existing row and the service never writes null. */
  updated_at: string | null;
}

export interface InvoiceCounterTable {
  id: number;
  next_value: number;
}

export interface BillingTables {
  payment_method: PaymentMethodTable;
  payment: PaymentTable;
  payment_account: PaymentAccountTable;
  invoice_counter: InvoiceCounterTable;
}
