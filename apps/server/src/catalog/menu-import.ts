import { readFileSync } from 'node:fs';
import { parseRupees, sub, type Paisa } from '@pos/shared';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { ActorContext } from '../identity/service.js';
import type { Database } from '../platform/db/types.js';
import {
  createCategory,
  createItem,
  createModifier,
  createModifierGroup,
  getCurrentPrice,
  getItemModifierPrice,
  linkModifierGroup,
  setItemModifierPrice,
  setItemPrice,
} from './service.js';

/**
 * Loading a real restaurant's printed menu into a fresh till.
 *
 * This is deliberately NOT part of seed.ts. The seed is a fictional demo
 * restaurant that the test suites assert on and that ships in the repo;
 * a real menu is this restaurant's own data, changes on its own
 * schedule, and has to be re-runnable against a till that is already
 * taking orders. So it is a separate file and a separate command.
 *
 * Everything it does is idempotent. Run it twice and the second run
 * reports no changes; edit a price in the file and re-run and it writes
 * one new effective-dated price row, exactly as the Menu screen would —
 * the till's price history stays intact either way.
 *
 * What it deliberately does NOT do is set ownership. Who owns which item
 * is a partnership agreement, not menu data, and partner names have no
 * business in this repository. The imported items arrive owned by
 * nobody, the Menu screen flags them as unsellable, and Partners →
 * Ownership by category is where that is answered — two operations for
 * the whole menu.
 */

const rupees = z.number().int().nonnegative();

const sizesSchema = z.object({
  /** The modifier group carrying the sizes, by name. */
  group: z.string().min(1),
  /** The ABSOLUTE price of the item at each size, in whole rupees —
   * what the menu board says. The importer turns those into per-item
   * price deltas itself, and checks that the base size's price matches
   * the item's own price, so a typo is caught rather than silently
   * mispriced. */
  prices: z.record(z.string().min(1), rupees),
});

const itemSchema = z.object({
  name: z.string().min(1),
  /** What the item costs at its base (smallest) size. */
  price: rupees,
  sizes: sizesSchema.optional(),
});

const menuFileSchema = z.object({
  modifierGroups: z.array(
    z.object({
      name: z.string().min(1),
      minSelect: z.number().int().nonnegative(),
      maxSelect: z.number().int().positive(),
      /** In menu-board order. The FIRST option is the base size: it is
       * the one whose price must equal the item's own price. */
      options: z.array(z.string().min(1)).min(1),
    }),
  ),
  categories: z.array(
    z.object({
      name: z.string().min(1),
      items: z.array(itemSchema).min(1),
    }),
  ),
});

export type MenuFile = z.infer<typeof menuFileSchema>;

export function parseMenuFile(json: unknown): MenuFile {
  const file = menuFileSchema.parse(json);
  const groups = new Map(file.modifierGroups.map((group) => [group.name, group]));

  for (const category of file.categories) {
    for (const item of category.items) {
      if (!item.sizes) continue;
      const group = groups.get(item.sizes.group);
      if (!group) throw new Error(`"${item.name}" uses modifier group "${item.sizes.group}", which the file does not define`);

      const named = Object.keys(item.sizes.prices);
      const unknownOption = named.find((name) => !group.options.includes(name));
      if (unknownOption) throw new Error(`"${item.name}" prices "${unknownOption}", which is not an option of "${group.name}"`);
      const missing = group.options.filter((name) => !named.includes(name));
      if (missing.length > 0) throw new Error(`"${item.name}" does not price ${missing.map((m) => `"${m}"`).join(', ')} of "${group.name}"`);

      const base = group.options[0] as string;
      if (item.sizes.prices[base] !== item.price) {
        throw new Error(`"${item.name}" is priced ${item.price} but its "${base}" size is ${String(item.sizes.prices[base])} — they must agree`);
      }
    }
  }
  return file;
}

export function readMenuFile(path: string): MenuFile {
  return parseMenuFile(JSON.parse(readFileSync(path, 'utf8')));
}

// ---------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------

/**
 * Every item action names its item by category, name AND occurrence.
 *
 * A real printed menu can list the same dish twice at different prices,
 * and this one does — the restaurant asked for those kept exactly as
 * they are. So "the item called X in category Y" is not a unique
 * address; "the Nth item called X in category Y, by creation order" is.
 */
export interface ItemAddress {
  readonly category: string;
  readonly name: string;
  readonly occurrence: number;
}

export type MenuImportAction =
  | { readonly kind: 'create-category'; readonly name: string; readonly sortOrder: number }
  | { readonly kind: 'create-group'; readonly name: string; readonly minSelect: number; readonly maxSelect: number }
  | { readonly kind: 'create-option'; readonly group: string; readonly name: string }
  | { readonly kind: 'create-item'; readonly at: ItemAddress }
  | { readonly kind: 'set-price'; readonly at: ItemAddress; readonly fromMinor: Paisa | null; readonly toMinor: Paisa }
  | { readonly kind: 'link-group'; readonly at: ItemAddress; readonly group: string }
  | {
      readonly kind: 'set-modifier-price';
      readonly at: ItemAddress;
      readonly group: string;
      readonly option: string;
      readonly fromMinor: Paisa | null;
      readonly toMinor: Paisa;
    };

export interface MenuImportPlan {
  readonly actions: readonly MenuImportAction[];
  /** Items the file lists that the database already has, priced as the
   * file says — nothing to do for them. */
  readonly unchangedItems: number;
}

function toPaisa(rupeeAmount: number, what: string): Paisa {
  // Through the money module's own parser, never bare arithmetic here
  // (docs/decisions/001 and the money-arithmetic guard).
  const value = parseRupees(String(rupeeAmount));
  if (value === null) throw new Error(`${what}: ${rupeeAmount} is not a usable amount`);
  return value;
}

/**
 * Work out what importing `file` would change, without changing
 * anything. This is what `--dry-run` prints, and what the apply step
 * then executes — one description of the work, so what you are shown is
 * what runs.
 */
export async function planMenuImport(db: Kysely<Database>, file: MenuFile): Promise<MenuImportPlan> {
  const actions: MenuImportAction[] = [];
  let unchangedItems = 0;

  const groupsByName = new Map(file.modifierGroups.map((group) => [group.name, group]));

  // ---- modifier groups and their options ----
  const existingGroups = await db.selectFrom('modifier_group').select(['id', 'name']).execute();
  const groupIdByName = new Map(existingGroups.map((group) => [group.name, group.id]));

  for (const group of file.modifierGroups) {
    const groupId = groupIdByName.get(group.name);
    if (groupId === undefined) {
      actions.push({ kind: 'create-group', name: group.name, minSelect: group.minSelect, maxSelect: group.maxSelect });
      for (const option of group.options) actions.push({ kind: 'create-option', group: group.name, name: option });
      continue;
    }
    const existingOptions = await db.selectFrom('modifier').select('name').where('group_id', '=', groupId).execute();
    const have = new Set(existingOptions.map((option) => option.name));
    for (const option of group.options) {
      if (!have.has(option)) actions.push({ kind: 'create-option', group: group.name, name: option });
    }
  }

  // ---- categories, items, prices, sizes ----
  const existingCategories = await db.selectFrom('category').select(['id', 'name']).execute();
  const categoryIdByName = new Map(existingCategories.map((category) => [category.name, category.id]));
  const maxSortOrder = await db.selectFrom('category').select(db.fn.max('sort_order').as('max')).executeTakeFirst();
  let nextSortOrder = (maxSortOrder?.max ?? 0) + 1;

  for (const category of file.categories) {
    const categoryId = categoryIdByName.get(category.name);
    if (categoryId === undefined) actions.push({ kind: 'create-category', name: category.name, sortOrder: nextSortOrder++ });

    // Existing items in this category, by name, in creation order — the
    // order the occurrence index counts in.
    const existingItems =
      categoryId === undefined
        ? []
        : await db.selectFrom('item').select(['id', 'name']).where('category_id', '=', categoryId).orderBy('id', 'asc').execute();
    const byName = new Map<string, number[]>();
    for (const item of existingItems) {
      byName.set(item.name, [...(byName.get(item.name) ?? []), item.id]);
    }

    const seen = new Map<string, number>();
    for (const item of category.items) {
      const occurrence = seen.get(item.name) ?? 0;
      seen.set(item.name, occurrence + 1);
      const at: ItemAddress = { category: category.name, name: item.name, occurrence };
      const itemId = byName.get(item.name)?.[occurrence];

      if (itemId === undefined) actions.push({ kind: 'create-item', at });

      const before = actions.length;

      const wanted = toPaisa(item.price, `${category.name} / ${item.name}`);
      const current = itemId === undefined ? null : await getCurrentPrice(db, itemId);
      if (current !== wanted) actions.push({ kind: 'set-price', at, fromMinor: current, toMinor: wanted });

      if (item.sizes) {
        const group = groupsByName.get(item.sizes.group);
        if (!group) throw new Error(`unknown modifier group "${item.sizes.group}"`); // parseMenuFile already refused this
        const groupId = groupIdByName.get(group.name);

        const linked =
          itemId === undefined || groupId === undefined
            ? false
            : (await db
                .selectFrom('item_modifier_group')
                .select('item_id')
                .where('item_id', '=', itemId)
                .where('group_id', '=', groupId)
                .executeTakeFirst()) !== undefined;
        if (!linked) actions.push({ kind: 'link-group', at, group: group.name });

        for (const option of group.options) {
          const absolute = toPaisa(item.sizes.prices[option] as number, `${item.name} / ${option}`);
          const delta = sub(absolute, wanted);
          let currentDelta: Paisa | null = null;
          if (itemId !== undefined && groupId !== undefined) {
            const modifier = await db
              .selectFrom('modifier')
              .select('id')
              .where('group_id', '=', groupId)
              .where('name', '=', option)
              .executeTakeFirst();
            if (modifier) currentDelta = await getItemModifierPrice(db, itemId, modifier.id);
          }
          if (currentDelta !== delta) {
            actions.push({ kind: 'set-modifier-price', at, group: group.name, option, fromMinor: currentDelta, toMinor: delta });
          }
        }
      }

      if (itemId !== undefined && actions.length === before) unchangedItems += 1;
    }
  }

  return { actions, unchangedItems };
}

// ---------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------

/** The (occurrence+1)th item with this name in this category, by
 * creation order — see ItemAddress for why a name alone will not do. */
async function resolveItem(db: Kysely<Database>, categoryId: number, at: ItemAddress): Promise<number> {
  const rows = await db.selectFrom('item').select('id').where('category_id', '=', categoryId).where('name', '=', at.name).orderBy('id', 'asc').execute();
  const row = rows[at.occurrence];
  if (!row) throw new Error(`menu import: "${at.name}" #${at.occurrence + 1} not found in "${at.category}"`);
  return row.id;
}

export interface MenuImportResult extends MenuImportPlan {
  readonly applied: number;
}

/**
 * Apply the plan. Not one big transaction: each action is an ordinary
 * catalog write with its own audit entry, exactly as if a manager had
 * made it on the Menu screen — which is what makes a half-finished run
 * safe to simply re-run, rather than something that has to be unwound.
 */
export async function importMenu(db: Kysely<Database>, file: MenuFile, actor: ActorContext): Promise<MenuImportResult> {
  const plan = await planMenuImport(db, file);

  const categoryIds = new Map<string, number>();
  for (const category of await db.selectFrom('category').select(['id', 'name']).execute()) categoryIds.set(category.name, category.id);
  const groupIds = new Map<string, number>();
  for (const group of await db.selectFrom('modifier_group').select(['id', 'name']).execute()) groupIds.set(group.name, group.id);

  const categoryId = (name: string): number => {
    const id = categoryIds.get(name);
    if (id === undefined) throw new Error(`menu import: category "${name}" was not created`);
    return id;
  };
  const groupId = (name: string): number => {
    const id = groupIds.get(name);
    if (id === undefined) throw new Error(`menu import: modifier group "${name}" was not created`);
    return id;
  };
  const modifierId = async (group: string, option: string): Promise<number> => {
    const row = await db
      .selectFrom('modifier')
      .select('id')
      .where('group_id', '=', groupId(group))
      .where('name', '=', option)
      .executeTakeFirst();
    if (!row) throw new Error(`menu import: "${option}" was not created in "${group}"`);
    return row.id;
  };

  for (const action of plan.actions) {
    switch (action.kind) {
      case 'create-category': {
        const created = await createCategory(db, { name: action.name, sortOrder: action.sortOrder }, actor);
        categoryIds.set(created.name, created.id);
        break;
      }
      case 'create-group': {
        const created = await createModifierGroup(db, { name: action.name, minSelect: action.minSelect, maxSelect: action.maxSelect }, actor);
        groupIds.set(created.name, created.id);
        break;
      }
      case 'create-option': {
        // Every sized item sets its own delta, so the group's own
        // default is zero: a size means nothing without an item to be a
        // size OF, and a plausible-looking default is just a wrong
        // price waiting for the one item somebody forgets to price.
        await createModifier(db, { groupId: groupId(action.group), name: action.name, priceDeltaMinor: toPaisa(0, action.name) }, actor);
        break;
      }
      case 'create-item':
        await createItem(db, { categoryId: categoryId(action.at.category), name: action.at.name }, actor);
        break;
      case 'set-price':
        await setItemPrice(db, await resolveItem(db, categoryId(action.at.category), action.at), action.toMinor, actor);
        break;
      case 'link-group':
        await linkModifierGroup(db, await resolveItem(db, categoryId(action.at.category), action.at), groupId(action.group), actor);
        break;
      case 'set-modifier-price':
        await setItemModifierPrice(
          db,
          await resolveItem(db, categoryId(action.at.category), action.at),
          await modifierId(action.group, action.option),
          action.toMinor,
          actor,
        );
        break;
    }
  }

  return { ...plan, applied: plan.actions.length };
}
