import { paisa } from '@pos/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createCategory, createItem, setItemPrice } from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { createPartner, setItemOwnership } from '../partners/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { defaultsFor } from '../settings/schema.js';
import { getSetting } from '../settings/service.js';

async function setup() {
  const ctx = createTestDb();
  const admin = await createUser(ctx.db, { name: 'Admin', username: 'admin', password: '9999', role: 'admin' }, { actorId: null, terminalId: 'seed' });
  const catalogActor = { actorId: admin.id, terminalId: 'seed' };
  const server = await createUser(ctx.db, { name: 'Server', username: 'server', password: '1234', role: 'server' }, catalogActor);
  const category = await createCategory(ctx.db, { name: 'Mains' }, catalogActor);
  const item = await createItem(ctx.db, { categoryId: category.id, name: 'Karahi' }, catalogActor);
  await setItemPrice(ctx.db, item.id, paisa(500_00), catalogActor);

  // Closing an order allocates it to its owning partner(s) — an item
  // with no ownership configured has nowhere for a non-zero sale to go,
  // so every HTTP test here that closes an order needs one, same as
  // billing/service.test.ts's fixture.
  const partner = await createPartner(ctx.db, 'Alice', catalogActor);
  await setItemOwnership(ctx.db, item.id, [{ partnerId: partner.id, shareBp: 10_000 }], catalogActor);

  const app = await buildApp({ db: ctx.db, logger: false, printer: null });
  return { ctx, app, admin, server, item, partner };
}

async function loginAs(app: FastifyInstance, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password, terminalId: 'till-1' } });
  return (res.json() as { token: string }).token;
}

describe('billing routes', () => {
  let app: FastifyInstance | undefined;
  let ctx: ReturnType<typeof createTestDb> | undefined;

  afterEach(async () => {
    await app?.close();
    ctx?.sqlite.close();
  });

  it('drives a full order -> bill -> pay -> closed flow over HTTP', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const token = await loginAs(app, started.admin.username, '9999');
    const auth = { authorization: `Bearer ${token}` };

    const methodRes = await app.inject({ method: 'POST', url: '/api/payment-methods', headers: auth, payload: { code: 'cash', displayName: 'Cash', kind: 'cash' } });
    expect(methodRes.statusCode).toBe(201);
    const method = methodRes.json() as { id: number };

    const orderRes = await app.inject({ method: 'POST', url: '/api/orders', headers: auth, payload: { orderType: 'takeaway' } });
    const order = orderRes.json() as { id: number };
    await app.inject({ method: 'POST', url: `/api/orders/${order.id}/lines`, headers: auth, payload: { itemId: started.item.id, qty: 1 } });
    const billRes = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/bill`, headers: auth, payload: {} });
    const billed = billRes.json() as { totalMinor: number };

    const payRes = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/payments`,
      headers: auth,
      payload: { paymentMethodId: method.id, amountMinor: billed.totalMinor },
    });
    expect(payRes.statusCode).toBe(201);
    const paid = payRes.json() as { orderClosed: boolean; order: { status: string; invoiceNo: number } };
    expect(paid.orderClosed).toBe(true);
    expect(paid.order).toMatchObject({ status: 'closed', invoiceNo: 1 });
  });

  it('maps a double-close attempt to a clean 422, not a 500', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const token = await loginAs(app, started.admin.username, '9999');
    const auth = { authorization: `Bearer ${token}` };

    const methodRes = await app.inject({ method: 'POST', url: '/api/payment-methods', headers: auth, payload: { code: 'cash', displayName: 'Cash', kind: 'cash' } });
    const method = methodRes.json() as { id: number };
    const orderRes = await app.inject({ method: 'POST', url: '/api/orders', headers: auth, payload: { orderType: 'takeaway' } });
    const order = orderRes.json() as { id: number };
    await app.inject({ method: 'POST', url: `/api/orders/${order.id}/lines`, headers: auth, payload: { itemId: started.item.id, qty: 1 } });
    const billRes = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/bill`, headers: auth, payload: {} });
    const billed = billRes.json() as { totalMinor: number };

    const payload = { paymentMethodId: method.id, amountMinor: billed.totalMinor };
    const first = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/payments`, headers: auth, payload });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/payments`, headers: auth, payload });
    expect(second.statusCode).toBe(422);
    expect(second.json()).toMatchObject({ error: expect.stringContaining('already settled') });
  });

  it('rejects a refund from a server, allows one from a manager', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const adminToken = await loginAs(app, started.admin.username, '9999');
    const serverToken = await loginAs(app, started.server.username, '1234');
    const authAdmin = { authorization: `Bearer ${adminToken}` };

    const methodRes = await app.inject({ method: 'POST', url: '/api/payment-methods', headers: authAdmin, payload: { code: 'cash', displayName: 'Cash', kind: 'cash' } });
    const method = methodRes.json() as { id: number };
    const orderRes = await app.inject({ method: 'POST', url: '/api/orders', headers: authAdmin, payload: { orderType: 'takeaway' } });
    const order = orderRes.json() as { id: number };
    await app.inject({ method: 'POST', url: `/api/orders/${order.id}/lines`, headers: authAdmin, payload: { itemId: started.item.id, qty: 1 } });
    const billRes = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/bill`, headers: authAdmin, payload: {} });
    const billed = billRes.json() as { totalMinor: number };
    await app.inject({ method: 'POST', url: `/api/orders/${order.id}/payments`, headers: authAdmin, payload: { paymentMethodId: method.id, amountMinor: billed.totalMinor } });

    const denied = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/refund`,
      headers: { authorization: `Bearer ${serverToken}` },
      payload: { reason: 'x' },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/refund`, headers: authAdmin, payload: { reason: 'x' } });
    expect(allowed.statusCode).toBe(200);
  });

  it('falls back to printable HTML when no printer is configured, rather than failing', async () => {
    const started = await setup();
    ({ app, ctx } = started);
    const token = await loginAs(app, started.admin.username, '9999');
    const auth = { authorization: `Bearer ${token}` };
    const orderRes = await app.inject({ method: 'POST', url: '/api/orders', headers: auth, payload: { orderType: 'takeaway' } });
    const order = orderRes.json() as { id: number };

    const res = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/print-bill`, headers: auth });
    // A till with no POS printer is a supported configuration, not an
    // error — it prints through Windows instead.
    expect(res.statusCode).toBe(200);
    const outcome = res.json() as { method: string; reason: string; html: string };
    expect(outcome.method).toBe('fallback');
    expect(outcome.reason).toBe('not_configured');
    expect(outcome.html).toContain('BILL');
  });

  describe('the receipt preview', () => {
    /** The draft an admin might have typed but not yet saved. */
    const draft = (name: string) => ({
      restaurant: { ...defaultsFor('restaurant'), name, addressLine1: '00 Example Road', phone: '000-0000000' },
      receipt: { ...defaultsFor('receipt'), footerMessage: 'Shukriya' },
      serviceCharge: defaultsFor('serviceCharge'),
    });

    it('renders a sample bill from settings that have NOT been saved', async () => {
      const started = await setup();
      ({ app, ctx } = started);
      const auth = { authorization: `Bearer ${await loginAs(app, started.admin.username, '9999')}` };

      const res = await app.inject({
        method: 'POST',
        url: '/api/printer/receipt-preview',
        headers: auth,
        payload: draft('Preview Kitchen'),
      });

      expect(res.statusCode).toBe(200);
      const { html } = res.json() as { html: string };
      // The name and footer came from the body, not from the database.
      expect(html).toContain('Preview Kitchen');
      expect(html).toContain('Shukriya');
      // And it is a real bill, laid out by the real renderer.
      expect(html).toContain('BILL');
      expect(html).toContain('Sample curry');
      expect(html).toContain('TOTAL');
    });

    it('saves nothing — previewing is not a write', async () => {
      const started = await setup();
      ({ app, ctx } = started);
      const auth = { authorization: `Bearer ${await loginAs(app, started.admin.username, '9999')}` };
      const before = await getSetting(started.ctx.db, 'restaurant');

      await app.inject({ method: 'POST', url: '/api/printer/receipt-preview', headers: auth, payload: draft('Never Saved') });

      expect(await getSetting(started.ctx.db, 'restaurant')).toEqual(before);
      expect((await getSetting(started.ctx.db, 'restaurant')).name).not.toBe('Never Saved');
    });

    it('shows the service charge line only when the charge is switched on', async () => {
      const started = await setup();
      ({ app, ctx } = started);
      const auth = { authorization: `Bearer ${await loginAs(app, started.admin.username, '9999')}` };

      const off = draft('Off');
      const on = { ...draft('On'), serviceCharge: { ...defaultsFor('serviceCharge'), enabled: true, rateBp: 500 } };

      const offHtml = (
        (await app.inject({ method: 'POST', url: '/api/printer/receipt-preview', headers: auth, payload: off })).json() as { html: string }
      ).html;
      const onHtml = (
        (await app.inject({ method: 'POST', url: '/api/printer/receipt-preview', headers: auth, payload: on })).json() as { html: string }
      ).html;

      // renderBillHtml prints the charge only when it is non-zero, so
      // the preview shows the ticket THIS restaurant actually prints.
      expect(offHtml).not.toContain('Rs 147.00');
      expect(onHtml).toContain('Rs 147.00');
    });

    it('refuses a caller with no session', async () => {
      const started = await setup();
      ({ app, ctx } = started);

      const res = await app.inject({ method: 'POST', url: '/api/printer/receipt-preview', payload: draft('Nobody') });
      expect(res.statusCode).toBe(401);
    });

    it('lets any signed-in user preview — it carries no printer configuration', async () => {
      const started = await setup();
      ({ app, ctx } = started);
      const auth = { authorization: `Bearer ${await loginAs(app, started.server.username, '1234')}` };

      const res = await app.inject({ method: 'POST', url: '/api/printer/receipt-preview', headers: auth, payload: draft('Anyone') });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { html: string }).html).not.toContain('printer');
    });
  });
});
