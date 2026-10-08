import type { Paisa } from '@pos/shared';
import type { Generated } from 'kysely';

/** The owner's configurable list of purchase categories (Settings). Its
 * own list, not the menu categories — see migration 0025. */
export interface PurchaseCategoryTable {
  id: Generated<number>;
  name: string;
  active: number;
  sort_order: number;
  created_at: string;
}

/** The owner's configurable list of purchase payment sources — where a
 * purchase's money came from (Cash drawer, a person who fronted it). A
 * pure record, like the purchase; see migration 0026. */
export interface PurchaseSourceTable {
  id: Generated<number>;
  name: string;
  active: number;
  sort_order: number;
  created_at: string;
}

/** One purchase: one partner, one category, one amount. A correction is a
 * void (voided = 1), never an edit. */
export interface PurchaseTable {
  id: Generated<number>;
  shift_id: number | null;
  partner_id: number;
  purchase_category_id: number;
  description: string | null;
  amount_minor: Paisa;
  payment_source_id: number | null;
  note: string | null;
  created_by: number;
  created_at: string;
  voided: number;
  voided_by: number | null;
  voided_at: string | null;
  void_reason: string | null;
}

export interface PurchasesTables {
  purchase_category: PurchaseCategoryTable;
  purchase_source: PurchaseSourceTable;
  purchase: PurchaseTable;
}
