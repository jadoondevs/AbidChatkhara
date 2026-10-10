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
// Purchase payment sources (configured in Settings) — where the money
// for a purchase came from (Cash drawer, a person who fronted it).
// ---------------------------------------------------------------------

export interface PurchaseSourceSummary {
  readonly id: number;
  readonly name: string;
  readonly active: boolean;
  readonly sortOrder: number;
  /** True on the one source that is the actual cash drawer, used by the
   * "remaining in drawer" view. */
  readonly isCashDrawer: boolean;
  readonly createdAt: string;
}

interface PurchaseSourceRow {
  id: number;
  name: string;
  active: number;
  sort_order: number;
  is_cash_drawer: number;
  created_at: string;
}

function toPurchaseSourceSummary(row: PurchaseSourceRow): PurchaseSourceSummary {
  return { id: row.id, name: row.name, active: row.active === 1, sortOrder: row.sort_order, isCashDrawer: row.is_cash_drawer === 1, createdAt: row.created_at };
}

export async function createPurchaseSource(
  db: Kysely<Database>,
  input: { name: string; sortOrder?: number | undefined },
  actor: ActorContext,
): Promise<PurchaseSourceSummary> {
  if (!input.name.trim()) throw new Error('a payment source needs a name');
  const now = new Date().toISOString();
  const max = await db.selectFrom('purchase_source').select(db.fn.max('sort_order').as('max')).executeTakeFirst();
  const sortOrder = input.sortOrder ?? (max?.max ?? 0) + 1;
  const row = await db
    .insertInto('purchase_source')
    .values({ name: input.name.trim(), active: 1, sort_order: sortOrder, is_cash_drawer: 0, created_at: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  const summary = toPurchaseSourceSummary(row);
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'purchase_source.create',
    entity: 'purchase_source',
    entityId: row.id,
    after: summary,
  });
  return summary;
}

export async function listPurchaseSources(db: Kysely<Database>, opts: { includeInactive?: boolean | undefined } = {}): Promise<PurchaseSourceSummary[]> {
  let query = db.selectFrom('purchase_source').selectAll();
  if (!opts.includeInactive) query = query.where('active', '=', 1);
  const rows = await query.orderBy('sort_order', 'asc').orderBy('name', 'asc').execute();
  return rows.map(toPurchaseSourceSummary);
}

export async function renamePurchaseSource(db: Kysely<Database>, id: number, name: string, actor: ActorContext): Promise<PurchaseSourceSummary> {
  if (!name.trim()) throw new Error('a payment source needs a name');
  const before = await db.selectFrom('purchase_source').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw new Error(`payment source ${id} not found`);
  const after = await db.updateTable('purchase_source').set({ name: name.trim() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'purchase_source.rename',
    entity: 'purchase_source',
    entityId: id,
    before: toPurchaseSourceSummary(before),
    after: toPurchaseSourceSummary(after),
  });
  return toPurchaseSourceSummary(after);
}

export async function setPurchaseSourceActive(db: Kysely<Database>, id: number, active: boolean, actor: ActorContext): Promise<PurchaseSourceSummary> {
  const before = await db.selectFrom('purchase_source').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw new Error(`payment source ${id} not found`);
  const after = await db.updateTable('purchase_source').set({ active: active ? 1 : 0 }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: active ? 'purchase_source.reactivate' : 'purchase_source.deactivate',
    entity: 'purchase_source',
    entityId: id,
    before: toPurchaseSourceSummary(before),
    after: toPurchaseSourceSummary(after),
  });
  return toPurchaseSourceSummary(after);
}

/** Mark (or unmark) a source as the cash drawer — the signal the
 * "remaining in drawer" view uses. At most one source is the drawer: on
 * setting one, any other is cleared, so the figure can never double-count.
 * A pure view flag; it moves no money. */
export async function setPurchaseSourceCashDrawer(db: Kysely<Database>, id: number, isCashDrawer: boolean, actor: ActorContext): Promise<PurchaseSourceSummary> {
  return db.transaction().execute(async (trx) => {
    const before = await trx.selectFrom('purchase_source').selectAll().where('id', '=', id).executeTakeFirst();
    if (!before) throw new Error(`payment source ${id} not found`);
    if (isCashDrawer) {
      // Single-drawer invariant: clear the flag on every other source.
      await trx.updateTable('purchase_source').set({ is_cash_drawer: 0 }).where('id', '!=', id).execute();
    }
    const after = await trx
      .updateTable('purchase_source')
      .set({ is_cash_drawer: isCashDrawer ? 1 : 0 })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: isCashDrawer ? 'purchase_source.set_cash_drawer' : 'purchase_source.clear_cash_drawer',
      entity: 'purchase_source',
      entityId: id,
      before: toPurchaseSourceSummary(before),
      after: toPurchaseSourceSummary(after),
    });
    return toPurchaseSourceSummary(after);
  });
}

/** Delete-or-retire a payment source, the same rule the category list
 * uses: deleted if nothing references it, retired otherwise. */
export async function deletePurchaseSource(db: Kysely<Database>, id: number, actor: ActorContext): Promise<PurchaseCategoryRemoval> {
  return db.transaction().execute(async (trx) => {
    const source = await trx.selectFrom('purchase_source').selectAll().where('id', '=', id).executeTakeFirst();
    if (!source) throw new Error(`payment source ${id} not found`);

    const used = (await trx.selectFrom('purchase').select('id').where('payment_source_id', '=', id).limit(1).executeTakeFirst()) !== undefined;
    if (used) {
      if (source.active === 0) return 'retired';
      await trx.updateTable('purchase_source').set({ active: 0 }).where('id', '=', id).execute();
      await recordAudit(trx, {
        actorId: actor.actorId,
        terminalId: actor.terminalId,
        action: 'purchase_source.retire',
        entity: 'purchase_source',
        entityId: id,
        before: toPurchaseSourceSummary(source),
        after: toPurchaseSourceSummary({ ...source, active: 0 }),
      });
      return 'retired';
    }

    await recordAudit(trx, {
      actorId: actor.actorId,
      terminalId: actor.terminalId,
      action: 'purchase_source.delete',
      entity: 'purchase_source',
      entityId: id,
      before: toPurchaseSourceSummary(source),
    });
    await trx.deleteFrom('purchase_source').where('id', '=', id).execute();
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
  readonly sourceId: number | null;
  readonly sourceName: string | null;
  /** True when this purchase's source is the cash drawer — used to total
   * drawer spend for the "remaining in drawer" view. */
  readonly sourceIsCashDrawer: boolean;
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
  payment_source_id: number | null;
  source_name: string | null;
  source_is_cash_drawer: number | null;
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
    sourceId: row.payment_source_id,
    sourceName: row.source_name,
    sourceIsCashDrawer: row.source_is_cash_drawer === 1,
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
    .leftJoin('purchase_source', 'purchase_source.id', 'purchase.payment_source_id')
    .select([
      'purchase.id as id',
      'purchase.shift_id as shift_id',
      'purchase.partner_id as partner_id',
      'partner.name as partner_name',
      'purchase.purchase_category_id as purchase_category_id',
      'purchase_category.name as category_name',
      'purchase.description as description',
      'purchase.amount_minor as amount_minor',
      'purchase.payment_source_id as payment_source_id',
      'purchase_source.name as source_name',
      'purchase_source.is_cash_drawer as source_is_cash_drawer',
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
  /** Where the money came from (Cash drawer, a person). Optional — a
   * purchase can be saved without one — but the till always sends it. */
  readonly sourceId?: number | undefined;
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

  if (input.sourceId !== undefined) {
    const source = await db.selectFrom('purchase_source').select(['id', 'active']).where('id', '=', input.sourceId).executeTakeFirst();
    if (!source) throw new Error(`payment source ${input.sourceId} not found`);
    if (source.active === 0) throw new Error('that payment source is no longer active');
  }

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
      payment_source_id: input.sourceId ?? null,
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
  readonly sourceId?: number | undefined;
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
  if (opts.sourceId !== undefined) query = query.where('purchase.payment_source_id', '=', opts.sourceId);
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
  /** Total of purchases paid from the cash drawer (the source flagged as
   * the drawer). Zero until a source is flagged. Drives the view-only
   * "remaining in drawer" figure — still nets against no real balance. */
  readonly drawerTotalMinor: Paisa;
  readonly byCategory: PurchaseGroupLine[];
  readonly byPartner: PurchaseGroupLine[];
  /** By where the money came from (Cash drawer, a person). A purchase
   * recorded before payment sources existed, or without one, groups under
   * a "—" line with id 0. */
  readonly bySource: PurchaseGroupLine[];
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
  opts: Pick<PurchaseQueryOptions, 'fromInclusive' | 'toExclusive' | 'shiftId' | 'partnerId' | 'categoryId' | 'sourceId'> = {},
): Promise<PurchaseReport> {
  const purchases = await listPurchases(db, { ...opts, includeVoided: false });
  return {
    totalMinor: sum(purchases.map((p) => p.amountMinor)),
    count: purchases.length,
    drawerTotalMinor: sum(purchases.filter((p) => p.sourceIsCashDrawer).map((p) => p.amountMinor)),
    byCategory: groupBy(purchases, (p) => ({ id: p.categoryId, name: p.categoryName })),
    byPartner: groupBy(purchases, (p) => ({ id: p.partnerId, name: p.partnerName })),
    bySource: groupBy(purchases, (p) => ({ id: p.sourceId ?? 0, name: p.sourceName ?? '—' })),
    purchases,
  };
}
