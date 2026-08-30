import type { Paisa } from '@pos/shared';
import type { Kysely, Transaction } from 'kysely';
import { recordAudit } from '../identity/audit.js';
import type { ActorContext } from '../identity/service.js';
import { OrderStateError } from '../ordering/service.js';
import type { Database } from '../platform/db/types.js';
import { computeMealCharge } from './policy.js';
import type { MealPolicy, PersonKind, SettlementType } from './tables.js';

export type { MealPolicy, PersonKind, SettlementType } from './tables.js';

// ---------------------------------------------------------------------
// Person
// ---------------------------------------------------------------------

export interface PersonSummary {
  readonly id: number;
  readonly name: string;
  readonly kind: PersonKind;
  readonly active: boolean;
  readonly mealPolicy: MealPolicy;
  readonly mealDiscountBp: number;
}

interface PersonRow {
  id: number;
  name: string;
  kind: PersonKind;
  active: number;
  meal_policy: MealPolicy;
  meal_discount_bp: number;
}

function toPersonSummary(row: PersonRow): PersonSummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    active: row.active === 1,
    mealPolicy: row.meal_policy,
    mealDiscountBp: row.meal_discount_bp,
  };
}

export interface CreatePersonInput {
  readonly name: string;
  readonly kind: PersonKind;
  readonly mealPolicy: MealPolicy;
  readonly mealDiscountBp?: number | undefined;
}

/** People config (spec screen 10) — staff and partners, with a meal
 * policy per person. Free-text names are deliberately never accepted
 * anywhere an order references a person (spec: "this must be a real
 * record so reports can total per person") — this is the only way one
 * gets created. */
export async function createPerson(db: Kysely<Database>, input: CreatePersonInput, actor: ActorContext): Promise<PersonSummary> {
  if (!input.name.trim()) throw new Error('a name is required');
  if (input.mealPolicy === 'discounted' && !(input.mealDiscountBp && input.mealDiscountBp > 0)) {
    throw new Error('a discounted meal policy requires a positive meal_discount_bp');
  }

  const row = await db
    .insertInto('person')
    .values({
      name: input.name,
      kind: input.kind,
      active: 1,
      meal_policy: input.mealPolicy,
      meal_discount_bp: input.mealDiscountBp ?? 0,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const summary = toPersonSummary(row);
  await recordAudit(db, { actorId: actor.actorId, terminalId: actor.terminalId, action: 'person.create', entity: 'person', entityId: row.id, after: summary });
  return summary;
}

export interface ListPersonsOptions {
  readonly kind?: PersonKind | undefined;
  readonly includeInactive?: boolean | undefined;
}

export async function listPersons(db: Kysely<Database>, opts: ListPersonsOptions = {}): Promise<PersonSummary[]> {
  let query = db.selectFrom('person').selectAll();
  if (!opts.includeInactive) query = query.where('active', '=', 1);
  if (opts.kind) query = query.where('kind', '=', opts.kind);
  const rows = await query.orderBy('name', 'asc').execute();
  return rows.map(toPersonSummary);
}

export async function getPerson(db: Kysely<Database>, id: number): Promise<PersonSummary | null> {
  const row = await db.selectFrom('person').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toPersonSummary(row) : null;
}

export interface UpdatePersonInput {
  readonly name?: string | undefined;
  readonly active?: boolean | undefined;
  readonly mealPolicy?: MealPolicy | undefined;
  readonly mealDiscountBp?: number | undefined;
}

/** Updates apply going forward only — like every other config table here,
 * a change never touches consumption_record's own policy_snapshot on
 * past orders (docs/decisions/009 / docs/decisions/006's same principle). */
export async function updatePerson(db: Kysely<Database>, id: number, input: UpdatePersonInput, actor: ActorContext): Promise<PersonSummary> {
  const before = await db.selectFrom('person').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw new Error(`person ${id} not found`);

  const nextPolicy = input.mealPolicy ?? before.meal_policy;
  const nextDiscountBp = input.mealDiscountBp ?? before.meal_discount_bp;
  if (nextPolicy === 'discounted' && !(nextDiscountBp > 0)) {
    throw new Error('a discounted meal policy requires a positive meal_discount_bp');
  }

  const after = await db
    .updateTable('person')
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.active !== undefined ? { active: input.active ? 1 : 0 } : {}),
      ...(input.mealPolicy !== undefined ? { meal_policy: input.mealPolicy } : {}),
      ...(input.mealDiscountBp !== undefined ? { meal_discount_bp: input.mealDiscountBp } : {}),
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAudit(db, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'person.update',
    entity: 'person',
    entityId: id,
    before: toPersonSummary(before),
    after: toPersonSummary(after),
  });
  return toPersonSummary(after);
}

// ---------------------------------------------------------------------
// Consumption record
// ---------------------------------------------------------------------

export interface ConsumptionActor {
  readonly actorId: number;
  readonly terminalId: string;
}

export interface ConsumptionRecordSummary {
  readonly id: number;
  readonly orderId: number;
  readonly personId: number;
  readonly personName: string;
  readonly policySnapshot: { readonly mealPolicy: MealPolicy; readonly mealDiscountBp: number };
  readonly menuValueMinor: Paisa;
  readonly chargedMinor: Paisa;
  readonly settlementMinor: Paisa;
  readonly settlementType: SettlementType | null;
  readonly createdAt: string;
}

interface ConsumptionRecordRow {
  id: number;
  order_id: number;
  person_id: number;
  policy_snapshot: string;
  menu_value_minor: Paisa;
  charged_minor: Paisa;
  settlement_minor: Paisa;
  settlement_type: SettlementType | null;
  created_at: string;
}

function toConsumptionRecordSummary(row: ConsumptionRecordRow, personName: string): ConsumptionRecordSummary {
  return {
    id: row.id,
    orderId: row.order_id,
    personId: row.person_id,
    personName,
    policySnapshot: JSON.parse(row.policy_snapshot) as { mealPolicy: MealPolicy; mealDiscountBp: number },
    menuValueMinor: row.menu_value_minor,
    chargedMinor: row.charged_minor,
    settlementMinor: row.settlement_minor,
    settlementType: row.settlement_type,
    createdAt: row.created_at,
  };
}

export interface RecordConsumptionInput {
  /** Required whenever the computed settlement is non-zero (see
   * consumption/policy.ts); ignored (and must be omitted) when the
   * person is charged in full. Defaults to 'payroll_deduction' when the
   * person's own meal_policy is 'payroll_deduction' and no explicit
   * value was given — every other case must be explicit, since e.g. a
   * 'free' meal is genuinely ambiguous between a house gift and an
   * owner's personal draw. */
  readonly settlementType?: SettlementType | undefined;
}

/**
 * Writes the consumption_record for a billed staff_meal/owner_meal
 * order, computing charged/settlement from the beneficiary's *current*
 * meal policy and snapshotting it onto the row. Composable into a
 * caller's transaction (billing's settleConsumption calls this exactly
 * where recordPayment calls gratuity's recordServiceChargeEntryInTransaction)
 * — consumption never opens its own top-level close transaction, since
 * it isn't the module that decides when an order is done closing.
 */
export async function recordConsumptionInTransaction(
  trx: Transaction<Database>,
  orderId: number,
  input: RecordConsumptionInput,
  actor: ConsumptionActor,
): Promise<ConsumptionRecordSummary> {
  const order = await trx.selectFrom('order').select(['channel', 'net_sales_minor', 'beneficiary_person_id']).where('id', '=', orderId).executeTakeFirstOrThrow();
  if (order.channel !== 'staff_meal' && order.channel !== 'owner_meal') {
    throw new OrderStateError(`order ${orderId} has channel '${order.channel}' — not a staff/owner meal order`);
  }
  if (order.beneficiary_person_id === null) {
    // ordering's own createOrder already refuses a staff_meal/owner_meal
    // order with no beneficiary — defensive re-check, should be unreachable.
    throw new Error(`order ${orderId} is a ${order.channel} order with no beneficiary person`);
  }

  const person = await trx.selectFrom('person').selectAll().where('id', '=', order.beneficiary_person_id).executeTakeFirstOrThrow();
  const menuValueMinor = order.net_sales_minor;
  const { chargedMinor, settlementMinor } = computeMealCharge(menuValueMinor, person.meal_policy, person.meal_discount_bp);

  let settlementType: SettlementType | null = null;
  if (settlementMinor > 0) {
    settlementType = input.settlementType ?? (person.meal_policy === 'payroll_deduction' ? 'payroll_deduction' : null);
    if (settlementType === null) {
      throw new OrderStateError(`a settlement type is required — ${person.name}'s meal was not charged in full`);
    }
  } else if (input.settlementType !== undefined) {
    throw new OrderStateError(`${person.name}'s meal was charged in full — there is nothing to settle`);
  }

  const now = new Date().toISOString();
  const row = await trx
    .insertInto('consumption_record')
    .values({
      order_id: orderId,
      person_id: person.id,
      policy_snapshot: JSON.stringify({ mealPolicy: person.meal_policy, mealDiscountBp: person.meal_discount_bp }),
      menu_value_minor: menuValueMinor,
      charged_minor: chargedMinor,
      settlement_minor: settlementMinor,
      settlement_type: settlementType,
      created_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAudit(trx, {
    actorId: actor.actorId,
    terminalId: actor.terminalId,
    action: 'consumption.record',
    entity: 'order',
    entityId: orderId,
    after: { personId: person.id, menuValueMinor, chargedMinor, settlementMinor, settlementType },
  });

  return toConsumptionRecordSummary(row, person.name);
}

export async function recordConsumption(
  db: Kysely<Database>,
  orderId: number,
  input: RecordConsumptionInput,
  actor: ConsumptionActor,
): Promise<ConsumptionRecordSummary> {
  return db.transaction().execute((trx) => recordConsumptionInTransaction(trx, orderId, input, actor));
}

// ---------------------------------------------------------------------
// Reporting seam — per-person totals for any date range (spec: "provide
// a per-person consumption report for any date range, itemised, showing
// menu value, amount charged, and amount settled"). The itemised list
// this returns is exactly that; a CSV export and cross-report rollups
// (daily sales' "combined total" line, a partner statement's customer-
// vs-consumption split) are the reporting milestone's job, built on top
// of this and gratuity's waiterPayoutTotals the same way.
// ---------------------------------------------------------------------

export interface ConsumptionRecordQueryOptions {
  readonly personId?: number | undefined;
  readonly fromInclusive?: string | undefined;
  readonly toExclusive?: string | undefined;
}

export async function listConsumptionRecords(db: Kysely<Database>, opts: ConsumptionRecordQueryOptions = {}): Promise<ConsumptionRecordSummary[]> {
  let query = db
    .selectFrom('consumption_record')
    .innerJoin('person', 'person.id', 'consumption_record.person_id')
    .select([
      'consumption_record.id',
      'consumption_record.order_id',
      'consumption_record.person_id',
      'consumption_record.policy_snapshot',
      'consumption_record.menu_value_minor',
      'consumption_record.charged_minor',
      'consumption_record.settlement_minor',
      'consumption_record.settlement_type',
      'consumption_record.created_at',
      'person.name as person_name',
    ]);
  if (opts.personId !== undefined) query = query.where('consumption_record.person_id', '=', opts.personId);
  if (opts.fromInclusive) query = query.where('consumption_record.created_at', '>=', opts.fromInclusive);
  if (opts.toExclusive) query = query.where('consumption_record.created_at', '<', opts.toExclusive);

  const rows = await query.orderBy('consumption_record.created_at', 'asc').execute();
  return rows.map((row) =>
    toConsumptionRecordSummary(
      {
        id: row.id,
        order_id: row.order_id,
        person_id: row.person_id,
        policy_snapshot: row.policy_snapshot,
        menu_value_minor: row.menu_value_minor,
        charged_minor: row.charged_minor,
        settlement_minor: row.settlement_minor,
        settlement_type: row.settlement_type,
        created_at: row.created_at,
      },
      row.person_name,
    ),
  );
}
