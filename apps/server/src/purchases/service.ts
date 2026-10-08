import { sum, type Paisa } from '@pos/shared';
import type { Kysely } from 'kysely';
import { recordAudit } from '../identity/audit.js';
import type { ActorContext } from '../identity/service.js';
import type { Database } from '../platform/db/types.js';

/** A purchase and its void write a non-null `created_by` / `voided_by`, so
 * they need a real user — not the nullable system actor the audit log
 * tolerates. Mirrors ordering's own OrderActor. */
export interface PurchaseActor {
  readonly actorId: number;
  readonly terminalId: string;
}

/**
 * The daily purchase ledger.
 *
 * The restaurant buys stock and supplies every day; this records each
 * purchase — what it was, how much it cost, which partner it was for and
 * under which (owner-configured) purchase category. It is a PURE record:
 * nothing here is netted against sales, revenue or the cash drawer. A
 * purchase is scoped by the open shift's id exactly as an order is, so a
 * shift's purchases are correct across midnight and reuse the same
 * shift/date reporting the sales reports use.
 */

// ---------------------------------------------------------------------
// Purchase categories (configured in Settings, the owner's own list)
// ---------------------------------------------------------------------

export interface PurchaseCategorySummary {
  readonly id: number;
  readonly name: string;
  readonly active: boolean;
  readonly sortOrder: number;
  readonly createdAt: string;
}

interface PurchaseCategoryRow {
  id: number;
  name: string;
  active: number;
  sort_order: number;
  created_at: string;
}

function toPurchaseCategorySummary(row: PurchaseCategoryRow): PurchaseCategorySummary {
  return { id: row.id, name: row.name, active: row.active === 1, sortOrder: row.sort_order, createdAt: row.created_at };
}

export async function createPurchaseCategory(
  db: Kysely<Database>,
  input: { name: string; sortOrder?: number | undefined },
  actor: ActorContext,
): Promise<PurchaseCategorySummary> {
  if (!input.name.trim()) throw new Error('a purchase category needs a name');
  const now = new Date().toISOString();
  const max = await db.selectFrom('purchase_category').select(db.fn.max('sort_order').as('max')).executeTakeFirst();
  const sortOrder = input.sortOrder ?? (max?.max ?? 0) + 1;
  const row = await db
    .insertInto('purchase_category')
    .values({ name: input.name.trim(), active: 1, sort_order: sortOrder, created_at: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  const summary = toPurchaseCategorySummary(row);
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'purchase_category.create',
    entity: 'purchase_category',
    entityId: row.id,
    after: summary,
  });
  return summary;
}

export async function listPurchaseCategories(
  db: Kysely<Database>,
  opts: { includeInactive?: boolean | undefined } = {},
): Promise<PurchaseCategorySummary[]> {
  let query = db.selectFrom('purchase_category').selectAll();
  if (!opts.includeInactive) query = query.where('active', '=', 1);
  const rows = await query.orderBy('sort_order', 'asc').orderBy('name', 'asc').execute();
  return rows.map(toPurchaseCategorySummary);
}

export async function renamePurchaseCategory(db: Kysely<Database>, id: number, name: string, actor: ActorContext): Promise<PurchaseCategorySummary> {
  if (!name.trim()) throw new Error('a purchase category needs a name');
  const before = await db.selectFrom('purchase_category').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw new Error(`purchase category ${id} not found`);
  const after = await db.updateTable('purchase_category').set({ name: name.trim() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'purchase_category.rename',
    entity: 'purchase_category',
    entityId: id,
    before: toPurchaseCategorySummary(before),
    after: toPurchaseCategorySummary(after),
  });
  return toPurchaseCategorySummary(after);
}

export async function setPurchaseCategoryActive(db: Kysely<Database>, id: number, active: boolean, actor: ActorContext): Promise<PurchaseCategorySummary> {
  const before = await db.selectFrom('purchase_category').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw new Error(`purchase category ${id} not found`);
  const after = await db.updateTable('purchase_category').set({ active: active ? 1 : 0 }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: active ? 'purchase_category.reactivate' : 'purchase_category.deactivate',
    entity: 'purchase_category',
    entityId: id,
    before: toPurchaseCategorySummary(before),
    after: toPurchaseCategorySummary(after),
  });
  return toPurchaseCategorySummary(after);
}

export type PurchaseCategoryRemoval = 'deleted' | 'retired';

/**
 * Remove a purchase category. Delete-or-retire, the same decision menu
 * categories use: a category NOTHING has been recorded against is deleted
 * outright (clearing away a mistake); one that already has purchases is
 * retired (`active = 0`) so it leaves the picker but stays attached to
 * the history that references it.
 */
export async function deletePurchaseCategory(db: Kysely<Database>, id: number, actor: ActorContext): Promise<PurchaseCategoryRemoval> {
  return db.transaction().execute(async (trx) => {
    const category = await trx.selectFrom('purchase_category').selectAll().where('id', '=', id).executeTakeFirst();
    if (!category) throw new Error(`purchase category ${id} not found`);

    const used = (await trx.selectFrom('purchase').select('id').where('purchase_category_id', '=', id).limit(1).executeTakeFirst()) !== undefined;
    if (used) {
      if (category.active === 0) return 'retired';
      await trx.updateTable('purchase_category').set({ active: 0 }).where('id', '=', id).execute();
      await recordAudit(trx, {
        actorId: actor.actorId,
        terminalId: actor.terminalId,
        action: 'purchase_category.retire',
        entity: 'purchase_category',
        entityId: id,
        before: toPurchaseCategorySummary(category),
        after: toPurchaseCategorySummary({ ...category, active: 0 }),
      });
      return 'retired';
    }

    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: 'purchase_category.delete',
      entity: 'purchase_category',
      entityId: id,
      before: toPurchaseCategorySummary(category),
    });
    await trx.deleteFrom('purchase_category').where('id', '=', id).execute();
    return 'deleted';
  });
}

// ---------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------

export interface PurchaseSummary {
  readonly id: number;
  readonly shiftId: number | null;
  readonly partnerId: number;
  readonly partnerName: string;
  readonly categoryId: number;
  readonly categoryName: string;
  readonly description: string | null;
  readonly amountMinor: Paisa;
  readonly note: string | null;
  readonly createdBy: number;
  readonly createdByName: string | null;
  readonly createdAt: string;
  readonly voided: boolean;
  readonly voidedBy: number | null;
  readonly voidedByName: string | null;
  readonly voidedAt: string | null;
  readonly voidReason: string | null;
}

interface PurchaseJoinedRow {
  id: number;
  shift_id: number | null;
  partner_id: number;
  partner_name: string;
  purchase_category_id: number;
  category_name: string;
  description: string | null;
  amount_minor: Paisa;
  note: string | null;
  created_by: number;
  created_by_name: string | null;
  created_at: string;
  voided: number;
  voided_by: number | null;
  voided_by_name: string | null;
  voided_at: string | null;
  void_reason: string | null;
}

function toPurchaseSummary(row: PurchaseJoinedRow): PurchaseSummary {
  return {
    id: row.id,
    shiftId: row.shift_id,
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    categoryId: row.purchase_category_id,
    categoryName: row.category_name,
    description: row.description,
    amountMinor: row.amount_minor,
    note: row.note,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    voided: row.voided === 1,
    voidedBy: row.voided_by,
    voidedByName: row.voided_by_name,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
  };
}

function purchaseSelect(db: Kysely<Database>) {
  return db
    .selectFrom('purchase')
    .innerJoin('partner', 'partner.id', 'purchase.partner_id')
    .innerJoin('purchase_category', 'purchase_category.id', 'purchase.purchase_category_id')
    .innerJoin('user as creator', 'creator.id', 'purchase.created_by')
    .leftJoin('user as voider', 'voider.id', 'purchase.voided_by')
    .select([
      'purchase.id as id',
      'purchase.shift_id as shift_id',
      'purchase.partner_id as partner_id',
      'partner.name as partner_name',
      'purchase.purchase_category_id as purchase_category_id',
      'purchase_category.name as category_name',
      'purchase.description as description',
      'purchase.amount_minor as amount_minor',
      'purchase.note as note',
      'purchase.created_by as created_by',
      'creator.name as created_by_name',
      'purchase.created_at as created_at',
      'purchase.voided as voided',
      'purchase.voided_by as voided_by',
      'voider.name as voided_by_name',
      'purchase.voided_at as voided_at',
      'purchase.void_reason as void_reason',
    ]);
}

export interface CreatePurchaseInput {
  readonly partnerId: number;
  readonly categoryId: number;
  readonly amountMinor: Paisa;
  readonly description?: string | undefined;
  readonly note?: string | undefined;
}

export async function createPurchase(db: Kysely<Database>, input: CreatePurchaseInput, actor: PurchaseActor): Promise<PurchaseSummary> {
  if (!(input.amountMinor > 0)) throw new Error('a purchase needs an amount greater than zero');

  const partner = await db.selectFrom('partner').select(['id', 'active']).where('id', '=', input.partnerId).executeTakeFirst();
  if (!partner) throw new Error(`partner ${input.partnerId} not found`);
  if (partner.active === 0) throw new Error('that partner is no longer active');

  const category = await db.selectFrom('purchase_category').select(['id', 'active']).where('id', '=', input.categoryId).executeTakeFirst();
  if (!category) throw new Error(`purchase category ${input.categoryId} not found`);
  if (category.active === 0) throw new Error('that purchase category is no longer active');

  // Tag the purchase with whichever shift is open — the same shape order
  // creation uses. No open shift is fine: the purchase carries shift_id
  // null and still falls under its date.
  const openShift = await db.selectFrom('shift').select('id').where('closed_at', 'is', null).executeTakeFirst();

  const description = input.description?.trim() ? input.description.trim() : null;
  const note = input.note?.trim() ? input.note.trim() : null;
  const now = new Date().toISOString();

  const inserted = await db
    .insertInto('purchase')
    .values({
      shift_id: openShift?.id ?? null,
      partner_id: input.partnerId,
      purchase_category_id: input.categoryId,
      description,
      amount_minor: input.amountMinor,
      note,
      created_by: actor.actorId,
      created_at: now,
      voided: 0,
      voided_by: null,
      voided_at: null,
      void_reason: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const summary = await getPurchase(db, inserted.id);
  if (!summary) throw new Error('purchase vanished immediately after insert');
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'purchase.create',
    entity: 'purchase',
    entityId: inserted.id,
    after: summary,
  });
  return summary;
}

export async function getPurchase(db: Kysely<Database>, id: number): Promise<PurchaseSummary | null> {
  const row = await purchaseSelect(db).where('purchase.id', '=', id).executeTakeFirst();
  return row ? toPurchaseSummary(row as PurchaseJoinedRow) : null;
}

/** Void a purchase — the only correction. Keeps the row (and its audit),
 * so the ledger is append-only; a mistake is voided and re-entered. */
export async function voidPurchase(db: Kysely<Database>, id: number, input: { reason: string }, actor: PurchaseActor): Promise<PurchaseSummary> {
  if (!input.reason.trim()) throw new Error('voiding a purchase needs a reason');
  const before = await getPurchase(db, id);
  if (!before) throw new Error(`purchase ${id} not found`);
  if (before.voided) throw new Error('that purchase is already voided');

  await db
    .updateTable('purchase')
    .set({ voided: 1, voided_by: actor.actorId, voided_at: new Date().toISOString(), void_reason: input.reason.trim() })
    .where('id', '=', id)
    .execute();

  const after = await getPurchase(db, id);
  if (!after) throw new Error('purchase vanished during void');
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'purchase.void',
    entity: 'purchase',
    entityId: id,
    before,
    after,
  });
  return after;
}

export interface PurchaseQueryOptions {
  readonly fromInclusive?: string | undefined;
  readonly toExclusive?: string | undefined;
  /** Scope to one shift (by the purchase's own `shift_id`) instead of the
   * date range. When set, the range is ignored — the shift-wins rule the
   * sales reports use. */
  readonly shiftId?: number | undefined;
  readonly partnerId?: number | undefined;
  readonly categoryId?: number | undefined;
  /** Voided purchases are left out by default; the ledger total is of
   * live purchases only. */
  readonly includeVoided?: boolean | undefined;
}

export async function listPurchases(db: Kysely<Database>, opts: PurchaseQueryOptions = {}): Promise<PurchaseSummary[]> {
  let query = purchaseSelect(db);
  if (opts.shiftId !== undefined) {
    query = query.where('purchase.shift_id', '=', opts.shiftId);
  } else {
    if (opts.fromInclusive) query = query.where('purchase.created_at', '>=', opts.fromInclusive);
    if (opts.toExclusive) query = query.where('purchase.created_at', '<', opts.toExclusive);
  }
  if (opts.partnerId !== undefined) query = query.where('purchase.partner_id', '=', opts.partnerId);
  if (opts.categoryId !== undefined) query = query.where('purchase.purchase_category_id', '=', opts.categoryId);
  if (!opts.includeVoided) query = query.where('purchase.voided', '=', 0);
  const rows = await query.orderBy('purchase.created_at', 'desc').orderBy('purchase.id', 'desc').execute();
  return rows.map((row) => toPurchaseSummary(row as PurchaseJoinedRow));
}

// ---------------------------------------------------------------------
// Purchase report
// ---------------------------------------------------------------------

export interface PurchaseGroupLine {
  readonly id: number;
  readonly name: string;
  readonly count: number;
  readonly totalMinor: Paisa;
}

export interface PurchaseReport {
  readonly totalMinor: Paisa;
  readonly count: number;
  readonly byCategory: PurchaseGroupLine[];
  readonly byPartner: PurchaseGroupLine[];
  readonly purchases: PurchaseSummary[];
}

function groupBy(purchases: readonly PurchaseSummary[], key: (p: PurchaseSummary) => { id: number; name: string }): PurchaseGroupLine[] {
  const by = new Map<number, { name: string; amounts: Paisa[] }>();
  for (const purchase of purchases) {
    const k = key(purchase);
    const entry = by.get(k.id) ?? { name: k.name, amounts: [] };
    entry.amounts.push(purchase.amountMinor);
    by.set(k.id, entry);
  }
  return [...by.entries()]
    .map(([id, { name, amounts }]) => ({ id, name, count: amounts.length, totalMinor: sum(amounts) }))
    .sort((a, b) => b.totalMinor - a.totalMinor || a.name.localeCompare(b.name));
}

/**
 * The purchases over a shift or a date range: the grand total, the same
 * money split by category and by partner, and the underlying rows.
 * Voided purchases are excluded — this is the real spend.
 */
export async function purchaseReport(
  db: Kysely<Database>,
  opts: Pick<PurchaseQueryOptions, 'fromInclusive' | 'toExclusive' | 'shiftId' | 'partnerId' | 'categoryId'> = {},
): Promise<PurchaseReport> {
  const purchases = await listPurchases(db, { ...opts, includeVoided: false });
  return {
    totalMinor: sum(purchases.map((p) => p.amountMinor)),
    count: purchases.length,
    byCategory: groupBy(purchases, (p) => ({ id: p.categoryId, name: p.categoryName })),
    byPartner: groupBy(purchases, (p) => ({ id: p.partnerId, name: p.partnerName })),
    purchases,
  };
}
