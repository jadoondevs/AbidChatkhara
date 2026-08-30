import type { Paisa } from '@pos/shared';
import type { Kysely } from 'kysely';
import { recordAudit } from '../identity/audit.js';
import type { ActorContext } from '../identity/service.js';
import type { Database } from '../platform/db/types.js';

// ---------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------

export interface CategorySummary {
  readonly id: number;
  readonly name: string;
  readonly sortOrder: number;
  readonly active: boolean;
}

interface CategoryRow {
  id: number;
  name: string;
  sort_order: number;
  active: number;
}

function toCategorySummary(row: CategoryRow): CategorySummary {
  return { id: row.id, name: row.name, sortOrder: row.sort_order, active: row.active === 1 };
}

export interface CreateCategoryInput {
  readonly name: string;
  readonly sortOrder?: number | undefined;
}

export async function createCategory(
  db: Kysely<Database>,
  input: CreateCategoryInput,
  actor: ActorContext,
): Promise<CategorySummary> {
  const row = await db
    .insertInto('category')
    .values({ name: input.name, sort_order: input.sortOrder ?? 0, active: 1 })
    .returningAll()
    .executeTakeFirstOrThrow();
  const summary = toCategorySummary(row);
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'category.create',
    entity: 'category',
    entityId: row.id,
    after: summary,
  });
  return summary;
}

export async function listCategories(
  db: Kysely<Database>,
  opts: { includeInactive?: boolean | undefined } = {},
): Promise<CategorySummary[]> {
  let query = db.selectFrom('category').selectAll();
  if (!opts.includeInactive) query = query.where('active', '=', 1);
  const rows = await query.orderBy('sort_order', 'asc').orderBy('name', 'asc').execute();
  return rows.map(toCategorySummary);
}

export interface UpdateCategoryInput {
  readonly name?: string | undefined;
  readonly sortOrder?: number | undefined;
  readonly active?: boolean | undefined;
}

export async function updateCategory(
  db: Kysely<Database>,
  id: number,
  input: UpdateCategoryInput,
  actor: ActorContext,
): Promise<CategorySummary> {
  const before = await db.selectFrom('category').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw new Error(`category ${id} not found`);

  const after = await db
    .updateTable('category')
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
      ...(input.active !== undefined ? { active: input.active ? 1 : 0 } : {}),
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'category.update',
    entity: 'category',
    entityId: id,
    before: toCategorySummary(before),
    after: toCategorySummary(after),
  });
  return toCategorySummary(after);
}

// ---------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------

export interface ItemSummary {
  readonly id: number;
  readonly categoryId: number;
  readonly name: string;
  readonly active: boolean;
}

interface ItemRow {
  id: number;
  category_id: number;
  name: string;
  active: number;
}

function toItemSummary(row: ItemRow): ItemSummary {
  return { id: row.id, categoryId: row.category_id, name: row.name, active: row.active === 1 };
}

export interface CreateItemInput {
  readonly categoryId: number;
  readonly name: string;
}

/**
 * Creates the item and its paired item_availability row (available by
 * default) in one go — every item always has exactly one availability
 * row, so callers never have to handle "no availability recorded yet".
 */
export async function createItem(
  db: Kysely<Database>,
  input: CreateItemInput,
  actor: ActorContext,
): Promise<ItemSummary> {
  const category = await db.selectFrom('category').select('id').where('id', '=', input.categoryId).executeTakeFirst();
  if (!category) throw new Error(`category ${input.categoryId} not found`);

  const row = await db
    .insertInto('item')
    .values({ category_id: input.categoryId, name: input.name, active: 1 })
    .returningAll()
    .executeTakeFirstOrThrow();

  const now = new Date().toISOString();
  await db
    .insertInto('item_availability')
    .values({ item_id: row.id, available: 1, changed_by: actor.actorId, changed_at: now })
    .execute();

  const summary = toItemSummary(row);
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'item.create',
    entity: 'item',
    entityId: row.id,
    after: summary,
  });
  return summary;
}

export async function listItems(
  db: Kysely<Database>,
  opts: { categoryId?: number | undefined; includeInactive?: boolean | undefined } = {},
): Promise<ItemSummary[]> {
  let query = db.selectFrom('item').selectAll();
  if (opts.categoryId !== undefined) query = query.where('category_id', '=', opts.categoryId);
  if (!opts.includeInactive) query = query.where('active', '=', 1);
  const rows = await query.orderBy('name', 'asc').execute();
  return rows.map(toItemSummary);
}

/** A single item by id, or null. What ordering looks up when adding a line. */
export async function getItem(db: Kysely<Database>, id: number): Promise<ItemSummary | null> {
  const row = await db.selectFrom('item').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toItemSummary(row) : null;
}

export interface UpdateItemInput {
  readonly name?: string | undefined;
  readonly categoryId?: number | undefined;
  readonly active?: boolean | undefined;
}

export async function updateItem(
  db: Kysely<Database>,
  id: number,
  input: UpdateItemInput,
  actor: ActorContext,
): Promise<ItemSummary> {
  const before = await db.selectFrom('item').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw new Error(`item ${id} not found`);

  const after = await db
    .updateTable('item')
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.categoryId !== undefined ? { category_id: input.categoryId } : {}),
      ...(input.active !== undefined ? { active: input.active ? 1 : 0 } : {}),
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'item.update',
    entity: 'item',
    entityId: id,
    before: toItemSummary(before),
    after: toItemSummary(after),
  });
  return toItemSummary(after);
}

// ---------------------------------------------------------------------
// Item price (effective-dated)
// ---------------------------------------------------------------------

export interface ItemPriceRow {
  readonly id: number;
  readonly itemId: number;
  readonly priceMinor: Paisa;
  readonly validFrom: string;
  readonly validTo: string | null;
}

interface RawItemPriceRow {
  id: number;
  item_id: number;
  price_minor: Paisa;
  valid_from: string;
  valid_to: string | null;
}

function toItemPriceRow(row: RawItemPriceRow): ItemPriceRow {
  return { id: row.id, itemId: row.item_id, priceMinor: row.price_minor, validFrom: row.valid_from, validTo: row.valid_to };
}

/**
 * Set a new price for an item, effective now: closes the currently open
 * price row (if any) and inserts a new one. Never updates price_minor in
 * place — see docs/decisions/001 and the spec's catalog section: editing
 * a price must never alter historical sales, and this table is the
 * catalog's own price history (independent of order_line's own snapshot
 * of the price actually charged on a given sale).
 */
export async function setItemPrice(
  db: Kysely<Database>,
  itemId: number,
  priceMinor: Paisa,
  actor: ActorContext,
): Promise<ItemPriceRow> {
  const item = await db.selectFrom('item').select('id').where('id', '=', itemId).executeTakeFirst();
  if (!item) throw new Error(`item ${itemId} not found`);

  return db.transaction().execute(async (trx) => {
    const now = new Date().toISOString();
    const current = await trx
      .selectFrom('item_price')
      .selectAll()
      .where('item_id', '=', itemId)
      .where('valid_to', 'is', null)
      .executeTakeFirst();

    if (current) {
      await trx.updateTable('item_price').set({ valid_to: now }).where('id', '=', current.id).execute();
    }

    const row = await trx
      .insertInto('item_price')
      .values({ item_id: itemId, price_minor: priceMinor, valid_from: now, valid_to: null })
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: 'item.set_price',
      entity: 'item',
      entityId: itemId,
      before: current ? toItemPriceRow(current) : null,
      after: toItemPriceRow(row),
    });

    return toItemPriceRow(row);
  });
}

/** The price in effect at `atTime` (default: now), or null if none has ever been set. */
export async function getCurrentPrice(
  db: Kysely<Database>,
  itemId: number,
  atTime: Date = new Date(),
): Promise<Paisa | null> {
  const at = atTime.toISOString();
  const row = await db
    .selectFrom('item_price')
    .select('price_minor')
    .where('item_id', '=', itemId)
    .where('valid_from', '<=', at)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', at)]))
    .orderBy('valid_from', 'desc')
    .executeTakeFirst();
  return row ? row.price_minor : null;
}

export async function getPriceHistory(db: Kysely<Database>, itemId: number): Promise<ItemPriceRow[]> {
  const rows = await db.selectFrom('item_price').selectAll().where('item_id', '=', itemId).orderBy('valid_from', 'asc').execute();
  return rows.map(toItemPriceRow);
}

// ---------------------------------------------------------------------
// Modifier groups and modifiers
// ---------------------------------------------------------------------

export interface ModifierGroupSummary {
  readonly id: number;
  readonly name: string;
  readonly minSelect: number;
  readonly maxSelect: number;
}

interface ModifierGroupRow {
  id: number;
  name: string;
  min_select: number;
  max_select: number;
}

function toModifierGroupSummary(row: ModifierGroupRow): ModifierGroupSummary {
  return { id: row.id, name: row.name, minSelect: row.min_select, maxSelect: row.max_select };
}

function assertValidSelectRange(minSelect: number, maxSelect: number): void {
  if (minSelect < 0) throw new Error('modifier group: minSelect must be >= 0');
  if (maxSelect < minSelect) throw new Error('modifier group: maxSelect must be >= minSelect');
}

export interface CreateModifierGroupInput {
  readonly name: string;
  readonly minSelect: number;
  readonly maxSelect: number;
}

export async function createModifierGroup(
  db: Kysely<Database>,
  input: CreateModifierGroupInput,
  actor: ActorContext,
): Promise<ModifierGroupSummary> {
  assertValidSelectRange(input.minSelect, input.maxSelect);
  const row = await db
    .insertInto('modifier_group')
    .values({ name: input.name, min_select: input.minSelect, max_select: input.maxSelect })
    .returningAll()
    .executeTakeFirstOrThrow();
  const summary = toModifierGroupSummary(row);
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'modifier_group.create',
    entity: 'modifier_group',
    entityId: row.id,
    after: summary,
  });
  return summary;
}

export async function listModifierGroups(db: Kysely<Database>): Promise<ModifierGroupSummary[]> {
  const rows = await db.selectFrom('modifier_group').selectAll().orderBy('name', 'asc').execute();
  return rows.map(toModifierGroupSummary);
}

export interface UpdateModifierGroupInput {
  readonly name?: string | undefined;
  readonly minSelect?: number | undefined;
  readonly maxSelect?: number | undefined;
}

export async function updateModifierGroup(
  db: Kysely<Database>,
  id: number,
  input: UpdateModifierGroupInput,
  actor: ActorContext,
): Promise<ModifierGroupSummary> {
  const before = await db.selectFrom('modifier_group').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw new Error(`modifier group ${id} not found`);

  const minSelect = input.minSelect ?? before.min_select;
  const maxSelect = input.maxSelect ?? before.max_select;
  assertValidSelectRange(minSelect, maxSelect);

  const after = await db
    .updateTable('modifier_group')
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      min_select: minSelect,
      max_select: maxSelect,
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'modifier_group.update',
    entity: 'modifier_group',
    entityId: id,
    before: toModifierGroupSummary(before),
    after: toModifierGroupSummary(after),
  });
  return toModifierGroupSummary(after);
}

export interface ModifierSummary {
  readonly id: number;
  readonly groupId: number;
  readonly name: string;
  readonly priceDeltaMinor: Paisa;
}

interface ModifierRow {
  id: number;
  group_id: number;
  name: string;
  price_delta_minor: Paisa;
}

function toModifierSummary(row: ModifierRow): ModifierSummary {
  return { id: row.id, groupId: row.group_id, name: row.name, priceDeltaMinor: row.price_delta_minor };
}

export interface CreateModifierInput {
  readonly groupId: number;
  readonly name: string;
  readonly priceDeltaMinor: Paisa;
}

export async function createModifier(
  db: Kysely<Database>,
  input: CreateModifierInput,
  actor: ActorContext,
): Promise<ModifierSummary> {
  const group = await db.selectFrom('modifier_group').select('id').where('id', '=', input.groupId).executeTakeFirst();
  if (!group) throw new Error(`modifier group ${input.groupId} not found`);

  const row = await db
    .insertInto('modifier')
    .values({ group_id: input.groupId, name: input.name, price_delta_minor: input.priceDeltaMinor })
    .returningAll()
    .executeTakeFirstOrThrow();
  const summary = toModifierSummary(row);
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'modifier.create',
    entity: 'modifier',
    entityId: row.id,
    after: summary,
  });
  return summary;
}

export async function listModifiers(db: Kysely<Database>, opts: { groupId?: number | undefined } = {}): Promise<ModifierSummary[]> {
  let query = db.selectFrom('modifier').selectAll();
  if (opts.groupId !== undefined) query = query.where('group_id', '=', opts.groupId);
  const rows = await query.orderBy('name', 'asc').execute();
  return rows.map(toModifierSummary);
}

/** A single modifier by id, or null. What ordering looks up when adding a line's modifiers. */
export async function getModifier(db: Kysely<Database>, id: number): Promise<ModifierSummary | null> {
  const row = await db.selectFrom('modifier').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toModifierSummary(row) : null;
}

export interface UpdateModifierInput {
  readonly name?: string | undefined;
  readonly priceDeltaMinor?: Paisa | undefined;
}

export async function updateModifier(
  db: Kysely<Database>,
  id: number,
  input: UpdateModifierInput,
  actor: ActorContext,
): Promise<ModifierSummary> {
  const before = await db.selectFrom('modifier').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw new Error(`modifier ${id} not found`);

  const after = await db
    .updateTable('modifier')
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.priceDeltaMinor !== undefined ? { price_delta_minor: input.priceDeltaMinor } : {}),
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'modifier.update',
    entity: 'modifier',
    entityId: id,
    before: toModifierSummary(before),
    after: toModifierSummary(after),
  });
  return toModifierSummary(after);
}

// ---------------------------------------------------------------------
// Item <-> modifier group linking
// ---------------------------------------------------------------------

export async function linkModifierGroup(
  db: Kysely<Database>,
  itemId: number,
  groupId: number,
  actor: ActorContext,
): Promise<void> {
  await db.insertInto('item_modifier_group').values({ item_id: itemId, group_id: groupId }).execute();
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'item.link_modifier_group',
    entity: 'item',
    entityId: itemId,
    after: { groupId },
  });
}

export async function unlinkModifierGroup(
  db: Kysely<Database>,
  itemId: number,
  groupId: number,
  actor: ActorContext,
): Promise<void> {
  await db.deleteFrom('item_modifier_group').where('item_id', '=', itemId).where('group_id', '=', groupId).execute();
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'item.unlink_modifier_group',
    entity: 'item',
    entityId: itemId,
    before: { groupId },
  });
}

export async function listModifierGroupsForItem(db: Kysely<Database>, itemId: number): Promise<ModifierGroupSummary[]> {
  const rows = await db
    .selectFrom('item_modifier_group')
    .innerJoin('modifier_group', 'modifier_group.id', 'item_modifier_group.group_id')
    .where('item_modifier_group.item_id', '=', itemId)
    .selectAll('modifier_group')
    .orderBy('modifier_group.name', 'asc')
    .execute();
  return rows.map(toModifierGroupSummary);
}

// ---------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------

export interface AvailabilityStatus {
  readonly itemId: number;
  readonly available: boolean;
  readonly changedBy: number | null;
  readonly changedAt: string;
}

interface AvailabilityRow {
  item_id: number;
  available: number;
  changed_by: number | null;
  changed_at: string;
}

function toAvailabilityStatus(row: AvailabilityRow): AvailabilityStatus {
  return { itemId: row.item_id, available: row.available === 1, changedBy: row.changed_by, changedAt: row.changed_at };
}

export async function setAvailability(
  db: Kysely<Database>,
  itemId: number,
  available: boolean,
  actor: ActorContext,
): Promise<AvailabilityStatus> {
  const before = await db.selectFrom('item_availability').selectAll().where('item_id', '=', itemId).executeTakeFirst();
  if (!before) throw new Error(`item ${itemId} has no availability row (was it created via createItem?)`);

  const now = new Date().toISOString();
  const after = await db
    .updateTable('item_availability')
    .set({ available: available ? 1 : 0, changed_by: actor.actorId, changed_at: now })
    .where('item_id', '=', itemId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: available ? 'item.mark_available' : 'item.mark_unavailable',
    entity: 'item',
    entityId: itemId,
    before: toAvailabilityStatus(before),
    after: toAvailabilityStatus(after),
  });
  return toAvailabilityStatus(after);
}

export async function getAvailability(db: Kysely<Database>, itemId: number): Promise<AvailabilityStatus | null> {
  const row = await db.selectFrom('item_availability').selectAll().where('item_id', '=', itemId).executeTakeFirst();
  return row ? toAvailabilityStatus(row) : null;
}

// ---------------------------------------------------------------------
// Combined menu view (item + current price + availability) — what the
// order screen's item grid and the menu management screen both need.
// ---------------------------------------------------------------------

export interface MenuItem {
  readonly id: number;
  readonly categoryId: number;
  readonly name: string;
  readonly active: boolean;
  readonly priceMinor: Paisa | null;
  readonly available: boolean;
}

export async function listMenu(
  db: Kysely<Database>,
  opts: { categoryId?: number | undefined; includeInactive?: boolean | undefined } = {},
): Promise<MenuItem[]> {
  let query = db
    .selectFrom('item')
    .leftJoin('item_price', (join) => join.onRef('item_price.item_id', '=', 'item.id').on('item_price.valid_to', 'is', null))
    .leftJoin('item_availability', 'item_availability.item_id', 'item.id')
    .select([
      'item.id as id',
      'item.category_id as categoryId',
      'item.name as name',
      'item.active as active',
      'item_price.price_minor as priceMinor',
      'item_availability.available as available',
    ]);
  if (opts.categoryId !== undefined) query = query.where('item.category_id', '=', opts.categoryId);
  if (!opts.includeInactive) query = query.where('item.active', '=', 1);

  const rows = await query.orderBy('item.name', 'asc').execute();
  return rows.map((row) => ({
    id: row.id,
    categoryId: row.categoryId,
    name: row.name,
    active: row.active === 1,
    priceMinor: row.priceMinor ?? null,
    // No availability row should never happen (createItem always makes
    // one), but if it somehow did, default to unavailable rather than
    // silently showing an item nobody has confirmed can be sold.
    available: row.available === 1,
  }));
}
