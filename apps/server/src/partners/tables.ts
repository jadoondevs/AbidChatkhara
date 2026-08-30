import type { Paisa } from '@pos/shared';
import type { Generated } from 'kysely';
import type { AllocationBaseMode } from './engine.js';

export interface PartnerTable {
  id: Generated<number>;
  name: string;
  active: number;
  joined_at: string;
  left_at: string | null;
}

export interface ItemOwnershipTable {
  id: Generated<number>;
  item_id: number;
  partner_id: number;
  share_bp: number;
  valid_from: string;
  valid_to: string | null;
}

export interface ModifierOwnershipTable {
  id: Generated<number>;
  modifier_id: number;
  partner_id: number;
  share_bp: number;
  valid_from: string;
  valid_to: string | null;
}

export interface LineAllocationTable {
  id: Generated<number>;
  order_line_id: number;
  order_line_modifier_id: number | null;
  partner_id: number;
  share_bp_snapshot: number;
  amount_minor: Paisa;
  allocation_base_mode: AllocationBaseMode;
  created_at: string;
  reverses_allocation_id: number | null;
}

export interface PartnersTables {
  partner: PartnerTable;
  item_ownership: ItemOwnershipTable;
  modifier_ownership: ModifierOwnershipTable;
  line_allocation: LineAllocationTable;
}
