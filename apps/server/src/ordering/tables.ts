import type { Paisa } from '@pos/shared';
import type { Generated } from 'kysely';

export type OrderType = 'dine_in' | 'takeaway' | 'delivery';
export type OrderChannel = 'customer' | 'staff_meal' | 'owner_meal';
export type OrderStatus = 'open' | 'billed' | 'closed' | 'voided';

export interface OrderTable {
  id: Generated<number>;
  invoice_no: number | null;
  order_type: OrderType;
  channel: OrderChannel;
  table_label: string | null;
  waiter_id: number | null;
  beneficiary_person_id: number | null;
  shift_id: number | null;
  opened_at: string;
  billed_at: string | null;
  closed_at: string | null;
  opened_by: number;
  closed_by: number | null;
  status: OrderStatus;
  subtotal_minor: Paisa;
  order_discount_minor: Paisa;
  discount_reason: string | null;
  net_sales_minor: Paisa;
  tax_minor: Paisa;
  service_charge_minor: Paisa;
  rounding_adjustment_minor: Paisa;
  total_minor: Paisa;
  version: number;
}

export interface OrderLineTable {
  id: Generated<number>;
  order_id: number;
  item_id: number;
  qty: number;
  unit_price_minor: Paisa;
  gross_minor: Paisa;
  prorated_discount_minor: Paisa;
  net_sales_minor: Paisa;
  allocation_base_minor: Paisa;
  voided: number;
  void_reason: string | null;
  void_approved_by: number | null;
}

export interface OrderLineModifierTable {
  id: Generated<number>;
  order_line_id: number;
  modifier_id: number;
  price_delta_minor: Paisa;
  gross_minor: Paisa;
  prorated_discount_minor: Paisa;
  net_sales_minor: Paisa;
  allocation_base_minor: Paisa;
}

export interface OrderingTables {
  order: OrderTable;
  order_line: OrderLineTable;
  order_line_modifier: OrderLineModifierTable;
}
