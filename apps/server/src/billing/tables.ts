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
  /**
   * Superseded by `payment_account.print_on_receipt` (migration 0019).
   * A method is a TYPE of payment — cash, a wallet, a bank transfer —
   * and these four columns described a receiving account, which is a
   * different thing that can exist more than once per method. Nothing
   * reads them any more; they remain because dropping a column in
   * SQLite means rewriting the table, and the data is what 0019
   * backfilled the new flag from.
   */
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
  /**
   * What the method and the account were CALLED when the money arrived,
   * and whether the account's details were printing then (0019).
   * Nullable at the database layer only because SQLite cannot add a NOT
   * NULL column without a default; 0019 backfills every existing row
   * and the service never writes null for a payment that has an
   * account.
   */
  method_name_snapshot: string | null;
  account_label_snapshot: string | null;
  account_number_snapshot: string | null;
  account_bank_snapshot: string | null;
  account_print_on_receipt_snapshot: number | null;
}

export interface PaymentAccountTable {
  id: Generated<number>;
  payment_method_id: number;
  label: string;
  account_title: string | null;
  account_number: string | null;
  bank_name: string | null;
  active: number;
  /** Whether this account's details are printed for a customer to pay
   * into. Independent of `active`: an account can take money without
   * being advertised on the ticket (0019). */
  print_on_receipt: number;
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
