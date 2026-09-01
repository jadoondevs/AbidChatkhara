import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaymentMethod, recordPayment, refundOrder } from '../billing/service.js';
import { createCategory, createItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { addLine, billOrder, createOrder } from '../ordering/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { createPartner, getPartnerRecord, listPartners, renamePartner, setItemOwnership, setPartnerActive } from './service.js';

describe('partner management', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setup() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    const actor = { actorId: admin.id, terminalId: 'till-1' };

    const category = await createCategory(ctx.db, { name: 'Mains' }, actor);
    const item = await createItem(ctx.db, { categoryId: category.id, name: 'Chicken Karahi' }, actor);
    await setItemPrice(ctx.db, item.id, paisa(1_000_00), actor);
    const cash = await createPaymentMethod(ctx.db, { code: 'cash', displayName: 'Cash', kind: 'cash' }, actor);

    return { admin, actor, item, cash };
  }

  async function soldOrder(s: Awaited<ReturnType<typeof setup>>, qty = 1) {
    const order = await createOrder(ctx.db, { orderType: 'takeaway' }, s.actor);
    await addLine(ctx.db, order.id, { itemId: s.item.id, qty }, s.actor);
    const billed = await billOrder(ctx.db, order.id, {}, s.actor);
    await recordPayment(ctx.db, order.id, { paymentMethodId: s.cash.id, amountMinor: billed.totalMinor }, s.actor);
    return order;
  }

  it('creates a partner, active by default', async () => {
    const { actor } = await setup();
    const partner = await createPartner(ctx.db, 'Alia Holdings', actor);
    expect(partner).toMatchObject({ name: 'Alia Holdings', active: true });
  });

  it('renames a partner without touching any money', async () => {
    const s = await setup();
    const partner = await createPartner(ctx.db, 'Alia Holdngs', s.actor); // typo
    await setItemOwnership(ctx.db, s.item.id, [{ partnerId: partner.id, shareBp: 10_000 }], s.actor);
    const order = await soldOrder(s);

    const renamed = await renamePartner(ctx.db, partner.id, 'Alia Holdings', s.actor);
    expect(renamed.name).toBe('Alia Holdings');

    const record = await getPartnerRecord(ctx.db, partner.id);
    expect(record?.totalAllocatedMinor).toBe(1_000_00);
    expect(record?.recentAllocations[0]?.orderId).toBe(order.id);
  });

  it('records both names in the audit log when renaming', async () => {
    const s = await setup();
    const partner = await createPartner(ctx.db, 'Old name', s.actor);
    await renamePartner(ctx.db, partner.id, 'New name', s.actor);

    const entry = await ctx.db.selectFrom('audit_log').selectAll().where('action', '=', 'partner.rename').executeTakeFirstOrThrow();
    expect(JSON.parse(entry.before_json as string)).toMatchObject({ name: 'Old name' });
    expect(JSON.parse(entry.after_json as string)).toMatchObject({ name: 'New name' });
  });

  it('rejects a blank name', async () => {
    const s = await setup();
    const partner = await createPartner(ctx.db, 'Alia Holdings', s.actor);
    await expect(renamePartner(ctx.db, partner.id, '   ', s.actor)).rejects.toThrow(/needs a name/);
  });

  it('deactivates and reactivates a partner, hiding them from the default list', async () => {
    const s = await setup();
    const partner = await createPartner(ctx.db, 'Alia Holdings', s.actor);

    await setPartnerActive(ctx.db, partner.id, false, s.actor);
    expect((await listPartners(ctx.db)).map((p) => p.id)).not.toContain(partner.id);
    expect((await listPartners(ctx.db, { includeInactive: true })).map((p) => p.id)).toContain(partner.id);

    await setPartnerActive(ctx.db, partner.id, true, s.actor);
    expect((await listPartners(ctx.db)).map((p) => p.id)).toContain(partner.id);
  });

  it('keeps a deactivated partner’s historical allocations intact', async () => {
    const s = await setup();
    const partner = await createPartner(ctx.db, 'Alia Holdings', s.actor);
    await setItemOwnership(ctx.db, s.item.id, [{ partnerId: partner.id, shareBp: 10_000 }], s.actor);
    await soldOrder(s);

    await setPartnerActive(ctx.db, partner.id, false, s.actor);

    // Deactivating says "no new business with them", never "erase what
    // they were owed".
    const record = await getPartnerRecord(ctx.db, partner.id);
    expect(record?.partner.active).toBe(false);
    expect(record?.totalAllocatedMinor).toBe(1_000_00);
    expect(record?.recentAllocations).toHaveLength(1);
  });

  it('returns null for a partner that does not exist', async () => {
    await setup();
    expect(await getPartnerRecord(ctx.db, 9999)).toBeNull();
  });

  it('lists what a partner currently owns, with their share', async () => {
    const s = await setup();
    const alia = await createPartner(ctx.db, 'Alia Holdings', s.actor);
    const bilal = await createPartner(ctx.db, 'Bilal Foods', s.actor);
    // A split always totals 100% — the engine refuses anything else.
    await setItemOwnership(
      ctx.db,
      s.item.id,
      [
        { partnerId: alia.id, shareBp: 6_000 },
        { partnerId: bilal.id, shareBp: 4_000 },
      ],
      s.actor,
    );

    const record = await getPartnerRecord(ctx.db, alia.id);
    expect(record?.ownedItems).toEqual([{ itemId: s.item.id, itemName: 'Chicken Karahi', shareBp: 6_000 }]);
  });

  it('credits each sale at the share in force when it closed, not today’s', async () => {
    const s = await setup();
    const alia = await createPartner(ctx.db, 'Alia Holdings', s.actor);
    const bilal = await createPartner(ctx.db, 'Bilal Foods', s.actor);

    await setItemOwnership(ctx.db, s.item.id, [{ partnerId: alia.id, shareBp: 10_000 }], s.actor);
    await soldOrder(s); // Alia gets the whole Rs 1,000

    // The split changes; the sale above must not move.
    await setItemOwnership(
      ctx.db,
      s.item.id,
      [
        { partnerId: alia.id, shareBp: 5_000 },
        { partnerId: bilal.id, shareBp: 5_000 },
      ],
      s.actor,
    );
    await soldOrder(s); // now Rs 500 each

    const aliaRecord = await getPartnerRecord(ctx.db, alia.id);
    expect(aliaRecord?.totalAllocatedMinor).toBe(1_500_00);
    expect(aliaRecord?.recentAllocations.map((a) => a.shareBpSnapshot).sort((a, b) => a - b)).toEqual([5_000, 10_000]);

    const bilalRecord = await getPartnerRecord(ctx.db, bilal.id);
    expect(bilalRecord?.totalAllocatedMinor).toBe(500_00);
  });

  it('names each allocation’s item as it was sold, after the menu is renamed', async () => {
    const s = await setup();
    const partner = await createPartner(ctx.db, 'Alia Holdings', s.actor);
    await setItemOwnership(ctx.db, s.item.id, [{ partnerId: partner.id, shareBp: 10_000 }], s.actor);
    await soldOrder(s);

    await ctx.db.updateTable('item').set({ name: 'Chicken Karahi (full)' }).where('id', '=', s.item.id).execute();

    const record = await getPartnerRecord(ctx.db, partner.id);
    expect(record?.recentAllocations[0]?.itemName).toBe('Chicken Karahi');
  });

  it('shows a refund as a marked reversal rather than a quietly smaller number', async () => {
    const s = await setup();
    const partner = await createPartner(ctx.db, 'Alia Holdings', s.actor);
    await setItemOwnership(ctx.db, s.item.id, [{ partnerId: partner.id, shareBp: 10_000 }], s.actor);
    const order = await soldOrder(s);

    await refundOrder(ctx.db, order.id, { reason: 'never collected' }, s.actor);

    const record = await getPartnerRecord(ctx.db, partner.id);
    expect(record?.recentAllocations).toHaveLength(2);
    expect(record?.recentAllocations.filter((a) => a.isReversal)).toHaveLength(1);
    // Sale and reversal net to nothing, and both are visible.
    expect(record?.totalAllocatedMinor).toBe(0);
  });

  it('caps how much history it returns, newest first', async () => {
    const s = await setup();
    const partner = await createPartner(ctx.db, 'Alia Holdings', s.actor);
    await setItemOwnership(ctx.db, s.item.id, [{ partnerId: partner.id, shareBp: 10_000 }], s.actor);
    for (let i = 0; i < 4; i += 1) await soldOrder(s);

    const record = await getPartnerRecord(ctx.db, partner.id, { limit: 2 });
    expect(record?.recentAllocations).toHaveLength(2);
    // The total is over everything, not just the page shown.
    expect(record?.totalAllocatedMinor).toBe(4_000_00);
  });
});
