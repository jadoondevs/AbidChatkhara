import { paisa, sum } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaymentMethod, recordPayment } from '../billing/service.js';
import { createCategory, createItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { addLine, billOrder, createOrder } from '../ordering/service.js';
import { createPartner, setItemOwnership } from '../partners/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { createTaxRule, listTaxRules, updateTaxRule } from './service.js';

describe('tax/service', () => {
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

    const partner = await createPartner(ctx.db, 'Alice', actor);
    await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], actor);
    const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, actor);

    return { admin, actor, category, item, partner, cash };
  }

  describe('tax_rule CRUD', () => {
    it('creates, lists (active by default), and updates a rule', async () => {
      const { actor, category } = await setupBase();
      const rule = await createTaxRule(ctx.db, { name: 'GST', rateBp: 1_600, appliesToCategoryId: category.id }, actor);
      expect(rule).toMatchObject({ name: 'GST', rateBp: 1_600, appliesToCategoryId: category.id, active: true, inclusive: false });

      expect(await listTaxRules(ctx.db)).toHaveLength(1);
      const disabled = await updateTaxRule(ctx.db, rule.id, { active: false }, actor);
      expect(disabled.active).toBe(false);
      expect(await listTaxRules(ctx.db)).toHaveLength(0);
      expect(await listTaxRules(ctx.db, { includeInactive: true })).toHaveLength(1);
    });
  });

  describe('billOrder wires computeTaxForOrder into the pipeline', () => {
    it('with no active rules, tax stays zero exactly as before this milestone', async () => {
      const { actor, item } = await setupBase();
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      const billed = await billOrder(ctx.db, order.id, {}, actor);
      expect(billed).toMatchObject({ taxMinor: 0, totalMinor: 1000_00 });
    });

    it('enabling a tax rule changes tax_minor and total_minor, but not partner allocations (spec, definition of done)', async () => {
      const { actor, item, category, partner, cash } = await setupBase();
      await createTaxRule(ctx.db, { name: 'GST', rateBp: 1_600, appliesToCategoryId: category.id }, actor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      const billed = await billOrder(ctx.db, order.id, {}, actor);

      // 16% of Rs 1000 = Rs 160.
      expect(billed.taxMinor).toBe(160_00);
      expect(billed.totalMinor).toBe(1160_00);

      const { order: closed } = await recordPayment(ctx.db, order.id, { paymentMethodId: cash.id, amountMinor: billed.totalMinor }, actor);
      expect(closed.status).toBe('closed');

      const allocations = await ctx.db.selectFrom('line_allocation').selectAll().where('partner_id', '=', partner.id).execute();
      // Exactly net sales (Rs 1000) — the same as it would be with no tax at all.
      expect(sum(allocations.map((a) => a.amount_minor))).toBe(1000_00);
    });

    it('a rule scoped to a different order type does not apply', async () => {
      const { actor, item, category } = await setupBase();
      await createTaxRule(ctx.db, { name: 'Delivery levy', rateBp: 500, appliesToCategoryId: category.id, appliesToOrderType: 'delivery' }, actor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      const billed = await billOrder(ctx.db, order.id, {}, actor);
      expect(billed.taxMinor).toBe(0);
    });

    it('a valid_to in the past means the rule no longer applies, even though it is still marked active', async () => {
      const { actor, item, category } = await setupBase();
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      await createTaxRule(ctx.db, { name: 'Expired', rateBp: 1_600, appliesToCategoryId: category.id, validTo: past }, actor);

      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, actor);
      await addLine(ctx.db, order.id, { itemId: item.id, qty: 1 }, actor);
      const billed = await billOrder(ctx.db, order.id, {}, actor);
      expect(billed.taxMinor).toBe(0);
    });
  });
});
