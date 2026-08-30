import type { Kysely, Transaction } from 'kysely';
import { recordAudit } from '../identity/audit.js';
import type { ActorContext } from '../identity/service.js';
import type { OrderType } from '../ordering/tables.js';
import type { Database } from '../platform/db/types.js';
import { computeTax, type TaxComputationResult, type TaxRuleInput } from './engine.js';

// ---------------------------------------------------------------------
// Tax rule CRUD
// ---------------------------------------------------------------------

export interface TaxRuleSummary {
  readonly id: number;
  readonly name: string;
  readonly rateBp: number;
  readonly appliesToCategoryId: number | null;
  readonly appliesToOrderType: OrderType | null;
  readonly inclusive: boolean;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly active: boolean;
}

interface TaxRuleRow {
  id: number;
  name: string;
  rate_bp: number;
  applies_to_category_id: number | null;
  applies_to_order_type: OrderType | null;
  inclusive: number;
  valid_from: string;
  valid_to: string | null;
  active: number;
}

function toTaxRuleSummary(row: TaxRuleRow): TaxRuleSummary {
  return {
    id: row.id,
    name: row.name,
    rateBp: row.rate_bp,
    appliesToCategoryId: row.applies_to_category_id,
    appliesToOrderType: row.applies_to_order_type,
    inclusive: row.inclusive === 1,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    active: row.active === 1,
  };
}

export interface CreateTaxRuleInput {
  readonly name: string;
  readonly rateBp: number;
  readonly appliesToCategoryId?: number | undefined;
  readonly appliesToOrderType?: OrderType | undefined;
  readonly inclusive?: boolean | undefined;
  /** Defaults to now. */
  readonly validFrom?: string | undefined;
  readonly validTo?: string | undefined;
}

/**
 * Ships with nothing calling this anywhere except tests and, eventually,
 * an admin screen — creating a rule is how tax gets turned on at all
 * ("ship with no active rules... turning tax on later must be a
 * configuration change, not a code change").
 */
export async function createTaxRule(db: Kysely<Database>, input: CreateTaxRuleInput, actor: ActorContext): Promise<TaxRuleSummary> {
  if (!input.name.trim()) throw new Error('a name is required');
  if (!Number.isInteger(input.rateBp) || input.rateBp < 0) throw new Error('rateBp must be a non-negative integer');

  const row = await db
    .insertInto('tax_rule')
    .values({
      name: input.name,
      rate_bp: input.rateBp,
      applies_to_category_id: input.appliesToCategoryId ?? null,
      applies_to_order_type: input.appliesToOrderType ?? null,
      inclusive: input.inclusive ? 1 : 0,
      valid_from: input.validFrom ?? new Date().toISOString(),
      valid_to: input.validTo ?? null,
      active: 1,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const summary = toTaxRuleSummary(row);
  await recordAudit(db, { actorId: actor.actorId, terminalId: actor.terminalId, action: 'tax_rule.create', entity: 'tax_rule', entityId: row.id, after: summary });
  return summary;
}

export async function listTaxRules(db: Kysely<Database>, opts: { includeInactive?: boolean | undefined } = {}): Promise<TaxRuleSummary[]> {
  let query = db.selectFrom('tax_rule').selectAll();
  if (!opts.includeInactive) query = query.where('active', '=', 1);
  const rows = await query.orderBy('name', 'asc').execute();
  return rows.map(toTaxRuleSummary);
}

export interface UpdateTaxRuleInput {
  readonly name?: string | undefined;
  readonly active?: boolean | undefined;
  readonly validTo?: string | undefined;
}

/** Deliberately narrow: only what a manager would actually change day to
 * day (turning a rule off, renaming it, or capping when it ends) — the
 * rate, scope, and inclusive flag are set once at creation, matching how
 * ownership/price effective-dating works elsewhere: correcting a rate is
 * a new rule (a new valid_from), never an edit to the historical one. */
export async function updateTaxRule(db: Kysely<Database>, id: number, input: UpdateTaxRuleInput, actor: ActorContext): Promise<TaxRuleSummary> {
  const before = await db.selectFrom('tax_rule').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw new Error(`tax rule ${id} not found`);

  const after = await db
    .updateTable('tax_rule')
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.active !== undefined ? { active: input.active ? 1 : 0 } : {}),
      ...(input.validTo !== undefined ? { valid_to: input.validTo } : {}),
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'tax_rule.update',
    entity: 'tax_rule',
    entityId: id,
    before: toTaxRuleSummary(before),
    after: toTaxRuleSummary(after),
  });
  return toTaxRuleSummary(after);
}

// ---------------------------------------------------------------------
// Computing an order's tax
// ---------------------------------------------------------------------

/**
 * Money pipeline stage 5, DB-facing: loads the order's own non-voided
 * lines (already-discount-prorated net_sales_minor — never re-derives
 * from gross), each line's category (read directly from catalog's
 * `item` table — the same "read another module's table for a simple
 * lookup" convention ordering already uses for `person`, billing for
 * `order`/`payment_method`), and every currently-active rule whose
 * valid_from/valid_to window covers `atInstant`, then hands all of it to
 * the pure computeTax. Called from ordering's billOrder — this is the
 * one direction of dependency (ordering -> tax); tax never needs to call
 * back into ordering.
 */
export async function computeTaxForOrder(
  executor: Kysely<Database> | Transaction<Database>,
  orderId: number,
  orderType: OrderType,
  atInstant: Date,
): Promise<TaxComputationResult> {
  const lineRows = await executor
    .selectFrom('order_line')
    .select(['id', 'item_id', 'net_sales_minor'])
    .where('order_id', '=', orderId)
    .where('voided', '=', 0)
    .execute();

  const categoryByItem = new Map<number, number>();
  const lines = [];
  for (const line of lineRows) {
    let categoryId = categoryByItem.get(line.item_id);
    if (categoryId === undefined) {
      const item = await executor.selectFrom('item').select('category_id').where('id', '=', line.item_id).executeTakeFirstOrThrow();
      categoryId = item.category_id;
      categoryByItem.set(line.item_id, categoryId);
    }
    lines.push({ key: String(line.id), categoryId, netSalesMinor: line.net_sales_minor });
  }

  const iso = atInstant.toISOString();
  const ruleRows = await executor
    .selectFrom('tax_rule')
    .selectAll()
    .where('active', '=', 1)
    .where('valid_from', '<=', iso)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', iso)]))
    .execute();
  const rules: TaxRuleInput[] = ruleRows.map((r) => ({
    rateBp: r.rate_bp,
    appliesToCategoryId: r.applies_to_category_id,
    appliesToOrderType: r.applies_to_order_type,
    inclusive: r.inclusive === 1,
  }));

  return computeTax(lines, orderType, rules);
}
