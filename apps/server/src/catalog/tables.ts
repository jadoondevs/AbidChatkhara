import type { Paisa } from '@pos/shared';
import type { Generated } from 'kysely';

export interface CategoryTable {
  id: Generated<number>;
  name: string;
  sort_order: number;
  active: number;
}

export interface ItemTable {
  id: Generated<number>;
  category_id: number;
  name: string;
  active: number;
}

export interface ItemPriceTable {
  id: Generated<number>;
  item_id: number;
  price_minor: Paisa;
  valid_from: string;
  valid_to: string | null;
}

/**
 * `pricing_mode` (migration 0021) says how each option's price is read:
 * a 'variant' (size) option IS the line's price and the admin enters the
 * final selling price; an 'add_on' option is charged ON TOP and the admin
 * enters the extra. Storage is a delta from the item's base either way —
 * see the migration and catalog/service.ts.
 */
export type ModifierPricingMode = 'variant' | 'add_on';

export interface ModifierGroupTable {
  id: Generated<number>;
  name: string;
  min_select: number;
  max_select: number;
  pricing_mode: ModifierPricingMode;
}

export interface ModifierTable {
  id: Generated<number>;
  group_id: number;
  name: string;
  price_delta_minor: Paisa;
}

export interface ItemModifierGroupTable {
  item_id: number;
  group_id: number;
}

/** What one modifier costs on ONE item, overriding the modifier's own
 * default. Effective-dated like item_price — see migration 0020. */
export interface ItemModifierPriceTable {
  id: Generated<number>;
  item_id: number;
  modifier_id: number;
  price_delta_minor: Paisa;
  valid_from: string;
  valid_to: string | null;
}

export interface ItemAvailabilityTable {
  item_id: number;
  available: number;
  changed_by: number | null;
  changed_at: string;
}

export interface CatalogTables {
  category: CategoryTable;
  item: ItemTable;
  item_price: ItemPriceTable;
  modifier_group: ModifierGroupTable;
  modifier: ModifierTable;
  item_modifier_group: ItemModifierGroupTable;
  item_modifier_price: ItemModifierPriceTable;
  item_availability: ItemAvailabilityTable;
}
