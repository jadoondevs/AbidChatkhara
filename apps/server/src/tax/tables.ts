import type { Generated } from 'kysely';
import type { OrderType } from '../ordering/tables.js';

export interface TaxRuleTable {
  id: Generated<number>;
  name: string;
  rate_bp: number;
  applies_to_category_id: number | null;
  applies_to_order_type: OrderType | null;
  inclusive: number;
  valid_from: string;
  valid_to: string | null;
  active: number;
}

export interface TaxTables {
  tax_rule: TaxRuleTable;
}
