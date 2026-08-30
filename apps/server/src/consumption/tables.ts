import type { Paisa } from '@pos/shared';
import type { Generated } from 'kysely';

export type PersonKind = 'staff' | 'partner';
export type MealPolicy = 'free' | 'discounted' | 'full_price' | 'payroll_deduction';
export type SettlementType = 'house_expense' | 'payroll_deduction' | 'partner_personal';

export interface PersonTable {
  id: Generated<number>;
  name: string;
  kind: PersonKind;
  active: number;
  meal_policy: MealPolicy;
  meal_discount_bp: number;
}

export interface ConsumptionRecordTable {
  id: Generated<number>;
  order_id: number;
  person_id: number;
  policy_snapshot: string;
  menu_value_minor: Paisa;
  charged_minor: Paisa;
  settlement_minor: Paisa;
  settlement_type: SettlementType | null;
  created_at: string;
}

export interface ConsumptionTables {
  person: PersonTable;
  consumption_record: ConsumptionRecordTable;
}
