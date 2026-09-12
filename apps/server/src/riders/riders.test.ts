import { afterEach, describe, expect, it } from 'vitest';
import { createUser } from '../identity/service.js';
import { OrderStateError, createOrder, getOrder } from '../ordering/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { createRider, listRiders, renameRider, setRiderActive } from './service.js';

describe('riders', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setup() {
    ctx = createTestDb();
    const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
    return { admin, actor: { actorId: admin.id, terminalId: 'till-1' } };
  }

  describe('rider CRUD', () => {
    it('creates a rider and lists only the active ones by default', async () => {
      const { actor } = await setup();
      const ali = await createRider(ctx.db, 'Ali', actor);
      const bilal = await createRider(ctx.db, 'Bilal', actor);
      expect(ali).toMatchObject({ name: 'Ali', active: true });

      const active = await listRiders(ctx.db);
      expect(active.map((r) => r.name)).toEqual(['Ali', 'Bilal']);

      await setRiderActive(ctx.db, bilal.id, false, actor);
      expect((await listRiders(ctx.db)).map((r) => r.name)).toEqual(['Ali']);
      // Retired riders are still there when explicitly asked for — never deleted.
      expect((await listRiders(ctx.db, { includeInactive: true })).map((r) => r.name)).toEqual(['Ali', 'Bilal']);
    });

    it('renames a rider', async () => {
      const { actor } = await setup();
      const rider = await createRider(ctx.db, 'Ali', actor);
      const renamed = await renameRider(ctx.db, rider.id, 'Ali Khan', actor);
      expect(renamed.name).toBe('Ali Khan');
    });

    it('refuses a blank name', async () => {
      const { actor } = await setup();
      await expect(createRider(ctx.db, '   ', actor)).rejects.toThrow();
    });
  });

  describe('assigning a rider to a delivery order', () => {
    it('stores the rider on a delivery order', async () => {
      const { actor } = await setup();
      const rider = await createRider(ctx.db, 'Ali', actor);
      const order = await createOrder(ctx.db, { orderType: 'delivery', riderId: rider.id }, actor);
      expect(order.riderId).toBe(rider.id);
      // And it survives a re-read.
      expect((await getOrder(ctx.db, order.id))?.riderId).toBe(rider.id);
    });

    it('refuses a rider on a non-delivery order', async () => {
      const { actor } = await setup();
      const rider = await createRider(ctx.db, 'Ali', actor);
      await expect(createOrder(ctx.db, { orderType: 'takeaway', riderId: rider.id }, actor)).rejects.toThrow(OrderStateError);
    });

    it('refuses an unknown rider', async () => {
      const { actor } = await setup();
      await expect(createOrder(ctx.db, { orderType: 'delivery', riderId: 9999 }, actor)).rejects.toThrow();
    });

    it('a delivery order needs no rider', async () => {
      const { actor } = await setup();
      const order = await createOrder(ctx.db, { orderType: 'delivery' }, actor);
      expect(order.riderId).toBeNull();
    });
  });
});
