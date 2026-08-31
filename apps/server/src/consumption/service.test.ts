import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createCategory, createItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { addLine, billOrder, createOrder, OrderStateError } from '../ordering/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { createPerson, listConsumptionRecords, listPersons, recordConsumption, updatePerson } from './service.js';

describe('consumption/service', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setupBase() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 'till-1' };

    const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
    const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, actor);
    await setItemPrice(ctx.db, item.id, paisa(1000_00), actor);

    return { admin, actor, item };
  }

  /** Opens, adds one line, and bills a staff_meal/owner_meal order for
   * `person` — but does NOT settle it. */
  async function billedMealOrder(
    item: { id: number },
    person: { id: number },
    channel: 'staff_meal' | 'owner_meal',
    actor: { actorId: number; terminalId: string },
  ) {
    const order = await createOrder(ctx.db, { orderType: 'takeaway', channel, beneficiaryPersonId: person.id }, actor);
    await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
    return billOrder(ctx.db, order.id, {}, actor);
  }

  describe('person CRUD', () => {
    it('creates and lists a person', async () => {
      const { actor } = await setupBase();
      await createPerson(ctx.db, { name: 'Bilal', kind: 'staff', mealPolicy: 'free' }, actor);
      const people = await listPersons(ctx.db);
      expect(people).toMatchObject([{ name: 'Bilal', kind: 'staff', mealPolicy: 'free', active: true }]);
    });

    it('rejects a discounted policy with no positive meal_discount_bp', async () => {
      const { actor } = await setupBase();
      await expect(createPerson(ctx.db, { name: 'X', kind: 'staff', mealPolicy: 'discounted' }, actor)).rejects.toThrow(/meal_discount_bp/);
    });

    it('filters by kind and excludes inactive people by default', async () => {
      const { actor } = await setupBase();
      const staff = await createPerson(ctx.db, { name: 'Bilal', kind: 'staff', mealPolicy: 'free' }, actor);
      await createPerson(ctx.db, { name: 'Alice', kind: 'partner', mealPolicy: 'full_price' }, actor);
      await updatePerson(ctx.db, staff.id, { active: false }, actor);

      expect(await listPersons(ctx.db, { kind: 'partner' })).toHaveLength(1);
      expect(await listPersons(ctx.db)).toHaveLength(1); // staff, now inactive, excluded
      expect(await listPersons(ctx.db, { includeInactive: true })).toHaveLength(2);
    });

    it('updatePerson can switch policy, and re-validates discount_bp on the merged result', async () => {
      const { actor } = await setupBase();
      const person = await createPerson(ctx.db, { name: 'Bilal', kind: 'staff', mealPolicy: 'full_price' }, actor);
      await expect(updatePerson(ctx.db, person.id, { mealPolicy: 'discounted' }, actor)).rejects.toThrow(/meal_discount_bp/);
      const updated = await updatePerson(ctx.db, person.id, { mealPolicy: 'discounted', mealDiscountBp: 2_500 }, actor);
      expect(updated).toMatchObject({ mealPolicy: 'discounted', mealDiscountBp: 2_500 });
    });
  });

  describe('recordConsumption', () => {
    it('records menu value, charged, and settlement for a free staff meal', async () => {
      const { actor, item } = await setupBase();
      const person = await createPerson(ctx.db, { name: 'Bilal', kind: 'staff', mealPolicy: 'free' }, actor);
      const billed = await billedMealOrder(item, person, 'staff_meal', actor);

      const record = await recordConsumption(ctx.db, billed.id, { settlementType: 'house_expense' }, actor);
      expect(record).toMatchObject({
        personId: person.id,
        personName: 'Bilal',
        menuValueMinor: 1000_00,
        chargedMinor: 0,
        settlementMinor: 1000_00,
        settlementType: 'house_expense',
        policySnapshot: { mealPolicy: 'free', mealDiscountBp: 0 },
      });
    });

    it('defaults settlement_type to payroll_deduction for a payroll_deduction policy with none given', async () => {
      const { actor, item } = await setupBase();
      const person = await createPerson(ctx.db, { name: 'Bilal', kind: 'staff', mealPolicy: 'payroll_deduction' }, actor);
      const billed = await billedMealOrder(item, person, 'staff_meal', actor);

      const record = await recordConsumption(ctx.db, billed.id, {}, actor);
      expect(record.settlementType).toBe('payroll_deduction');
    });

    it('requires an explicit settlement type for a free meal (no sensible default)', async () => {
      const { actor, item } = await setupBase();
      const person = await createPerson(ctx.db, { name: 'Alice', kind: 'partner', mealPolicy: 'free' }, actor);
      const billed = await billedMealOrder(item, person, 'owner_meal', actor);
      await expect(recordConsumption(ctx.db, billed.id, {}, actor)).rejects.toThrow(/settlement type is required/);

      const record = await recordConsumption(ctx.db, billed.id, { settlementType: 'partner_personal' }, actor);
      expect(record.settlementType).toBe('partner_personal');
    });

    it('a full_price meal needs no settlement type, and rejects one if given', async () => {
      const { actor, item } = await setupBase();
      const person = await createPerson(ctx.db, { name: 'Alice', kind: 'partner', mealPolicy: 'full_price' }, actor);
      const billed = await billedMealOrder(item, person, 'owner_meal', actor);

      const record = await recordConsumption(ctx.db, billed.id, {}, actor);
      expect(record).toMatchObject({ chargedMinor: 1000_00, settlementMinor: 0, settlementType: null });

      const billed2 = await billedMealOrder(item, person, 'owner_meal', actor);
      await expect(recordConsumption(ctx.db, billed2.id, { settlementType: 'house_expense' }, actor)).rejects.toThrow(/nothing to settle/);
    });

    it('a discounted policy splits menu value exactly between charged and settlement', async () => {
      const { actor, item } = await setupBase();
      const person = await createPerson(ctx.db, { name: 'Bilal', kind: 'staff', mealPolicy: 'discounted', mealDiscountBp: 3_000 }, actor);
      const billed = await billedMealOrder(item, person, 'staff_meal', actor);

      const record = await recordConsumption(ctx.db, billed.id, { settlementType: 'house_expense' }, actor);
      expect(record.chargedMinor + record.settlementMinor).toBe(1000_00);
      expect(record.chargedMinor).toBe(700_00);
      expect(record.settlementMinor).toBe(300_00);
    });

    it('rejects a customer-channel order', async () => {
      const { actor, item } = await setupBase();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      const billed = await billOrder(ctx.db, order.id, {}, actor);
      await expect(recordConsumption(ctx.db, billed.id, {}, actor)).rejects.toThrow(OrderStateError);
    });

    it('snapshots the policy used at settlement — a later policy change never alters an already-written record', async () => {
      const { actor, item } = await setupBase();
      const person = await createPerson(ctx.db, { name: 'Bilal', kind: 'staff', mealPolicy: 'full_price' }, actor);
      const billed = await billedMealOrder(item, person, 'staff_meal', actor);

      const record = await recordConsumption(ctx.db, billed.id, {}, actor);
      expect(record.policySnapshot).toEqual({ mealPolicy: 'full_price', mealDiscountBp: 0 });
      expect(record.chargedMinor).toBe(1000_00);

      // Changing the person's policy afterward must never rewrite history.
      await updatePerson(ctx.db, person.id, { mealPolicy: 'free' }, actor);
      const [reloaded] = await listConsumptionRecords(ctx.db, { personId: person.id });
      expect(reloaded?.policySnapshot).toEqual({ mealPolicy: 'full_price', mealDiscountBp: 0 });
      expect(reloaded?.chargedMinor).toBe(1000_00);
    });
  });

  describe('listConsumptionRecords', () => {
    it('itemises records, filterable by person and date range', async () => {
      const { actor, item } = await setupBase();
      const bilal = await createPerson(ctx.db, { name: 'Bilal', kind: 'staff', mealPolicy: 'free' }, actor);
      const ahmed = await createPerson(ctx.db, { name: 'Ahmed', kind: 'staff', mealPolicy: 'full_price' }, actor);

      const billed1 = await billedMealOrder(item, bilal, 'staff_meal', actor);
      await recordConsumption(ctx.db, billed1.id, { settlementType: 'house_expense' }, actor);
      const billed2 = await billedMealOrder(item, ahmed, 'staff_meal', actor);
      await recordConsumption(ctx.db, billed2.id, {}, actor);

      expect(await listConsumptionRecords(ctx.db)).toHaveLength(2);
      expect(await listConsumptionRecords(ctx.db, { personId: bilal.id })).toHaveLength(1);

      const future = new Date(Date.now() + 60_000).toISOString();
      expect(await listConsumptionRecords(ctx.db, { fromInclusive: future })).toEqual([]);
    });
  });
});
