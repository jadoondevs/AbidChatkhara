import { paisa } from '@pos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createItem,
  createModifier,
  createModifierGroup,
  linkModifierGroup,
  setItemModifierPrice,
  setItemPrice,
} from '../catalog/service.js';
import { createUser } from '../identity/service.js';
import { createTestDb } from '../platform/db/test-helpers.js';
import { addLine, createOrder, getOrder } from './service.js';

/**
 * The prices a customer is actually charged when they pick a modifier —
 * the bug this locks down is a "size" being ADDED to the base instead of
 * REPLACING it, so a Rs 200 drink at its Rs 200 size rang up Rs 400.
 *
 * A variant (size) group prices in FINAL selling prices, stored as a
 * delta from the item's base (final − base). An add-on group prices in
 * the amount it adds. Both feed the same line-total sum
 * (base×qty + Σ delta×qty), so the delta a variant stores is exactly what
 * makes the final price come out right.
 *
 * The item's base price is the price of its base (cheapest) size, so
 * every size's delta is ≥ 0 — the same convention the menu importer
 * enforces. That is not incidental: the allocation pipeline prorates a
 * line's discount across the item and its modifiers by their grosses, and
 * a negative component has no meaning there, so a size below the base
 * price is not a representable configuration.
 */
describe('ordering/modifier pricing — variants are final prices, add-ons add', () => {
  let ctx: ReturnType<typeof createTestDb>;

  afterEach(() => {
    ctx?.sqlite.close();
  });

  async function setup() {
    ctx = createTestDb();
    const admin = await createUser(
      ctx.db,
      { name: 'Admin', username: 'admin', password: '9999', role: 'admin' },
      { actorId: null, terminalId: 'seed' },
    );
    const catalogActor = { actorId: admin.id, terminalId: 'seed' };
    const server = await createUser(ctx.db, { name: 'Server', username: 'server', password: '1111', role: 'server' }, catalogActor);
    const orderActor = { actorId: server.id, terminalId: 'till-1' };
    const category = await createCategory(ctx.db, { name: 'Drinks' }, catalogActor);
    return { catalogActor, orderActor, categoryId: category.id };
  }

  const grossOf = async (orderId: number): Promise<number> => {
    const order = await getOrder(ctx.db, orderId);
    return order!.lines[0]!.grossMinor;
  };

  it('charges a chosen drink size as its FINAL price, not base + final', async () => {
    const { catalogActor, orderActor, categoryId } = await setup();

    // A soft drink sold in three bottle sizes at Rs 100 / Rs 150 / Rs 200.
    // The base price is the cheapest size (Half litre, Rs 100), so the
    // deltas are 0 / +50 / +100 — every size is the base or above it.
    const drink = await createItem(ctx.db, { categoryId, name: 'Soft Drink' }, catalogActor);
    await setItemPrice(ctx.db, drink.id, paisa(100_00), catalogActor);

    const size = await createModifierGroup(
      ctx.db,
      { name: 'Bottle size', minSelect: 1, maxSelect: 1, pricingMode: 'variant' },
      catalogActor,
    );
    const half = await createModifier(ctx.db, { groupId: size.id, name: 'Half litre', priceDeltaMinor: paisa(0) }, catalogActor);
    const litre = await createModifier(ctx.db, { groupId: size.id, name: 'Litre', priceDeltaMinor: paisa(0) }, catalogActor);
    const oneAndHalf = await createModifier(ctx.db, { groupId: size.id, name: '1.5 litre', priceDeltaMinor: paisa(0) }, catalogActor);
    await linkModifierGroup(ctx.db, drink.id, size.id, catalogActor);

    // Deltas = final − base: Half 100−100 = 0, Litre 150−100 = 50,
    // 1.5 litre 200−100 = 100.
    await setItemModifierPrice(ctx.db, drink.id, half.id, paisa(0), catalogActor);
    await setItemModifierPrice(ctx.db, drink.id, litre.id, paisa(50_00), catalogActor);
    await setItemModifierPrice(ctx.db, drink.id, oneAndHalf.id, paisa(100_00), catalogActor);

    const line = async (modifierId: number, qty: number): Promise<number> => {
      const order = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
      await addLine(ctx.db, order.id, { itemId: drink.id, qty, modifierIds: [modifierId] }, orderActor);
      return grossOf(order.id);
    };

    expect(await line(half.id, 1)).toBe(100_00); // Half litre → Rs 100
    expect(await line(litre.id, 1)).toBe(150_00); // Litre → Rs 150
    expect(await line(oneAndHalf.id, 1)).toBe(200_00); // 1.5 litre → Rs 200, NOT 400

    // Quantity multiplies the FINAL unit price, not base + final.
    expect(await line(oneAndHalf.id, 2)).toBe(400_00); // 2 × Rs 200 = Rs 400, NOT Rs 800
    expect(await line(litre.id, 2)).toBe(300_00); // 2 × Rs 150 = Rs 300
  });

  it("charges the karahi's Full size Rs 2,000, not Rs 1,300 + Rs 2,000", async () => {
    const { catalogActor, orderActor, categoryId } = await setup();

    // The user's own example: base 1300 (Half), Full 2000. Full must ring
    // up Rs 2,000 — the final price — not Rs 3,300 (base + final) and not
    // Rs 2,600 (which a "double the base" bug produced).
    const karahi = await createItem(ctx.db, { categoryId, name: 'Chicken Karahi' }, catalogActor);
    await setItemPrice(ctx.db, karahi.id, paisa(1_300_00), catalogActor);
    const size = await createModifierGroup(
      ctx.db,
      { name: 'Half / Full', minSelect: 1, maxSelect: 1, pricingMode: 'variant' },
      catalogActor,
    );
    const half = await createModifier(ctx.db, { groupId: size.id, name: 'Half', priceDeltaMinor: paisa(0) }, catalogActor);
    const full = await createModifier(ctx.db, { groupId: size.id, name: 'Full', priceDeltaMinor: paisa(0) }, catalogActor);
    await linkModifierGroup(ctx.db, karahi.id, size.id, catalogActor);
    await setItemModifierPrice(ctx.db, karahi.id, half.id, paisa(0), catalogActor); // Half 1300 − 1300 = 0
    await setItemModifierPrice(ctx.db, karahi.id, full.id, paisa(700_00), catalogActor); // Full 2000 − 1300 = 700

    const halfOrder = await createOrder(ctx.db, { orderType: 'dine_in', waiterId: orderActor.actorId }, orderActor);
    await addLine(ctx.db, halfOrder.id, { itemId: karahi.id, qty: 1, modifierIds: [half.id] }, orderActor);
    expect(await grossOf(halfOrder.id)).toBe(1_300_00);

    const fullOrder = await createOrder(ctx.db, { orderType: 'dine_in', waiterId: orderActor.actorId }, orderActor);
    await addLine(ctx.db, fullOrder.id, { itemId: karahi.id, qty: 1, modifierIds: [full.id] }, orderActor);
    expect(await grossOf(fullOrder.id)).toBe(2_000_00);
  });

  it('still charges a genuine add-on ON TOP of the item', async () => {
    const { catalogActor, orderActor, categoryId } = await setup();

    // A dish at Rs 200 with an "Extra cheese +Rs 100" add-on: picking it
    // makes the line Rs 300, and two of them Rs 600 — the add-on is added,
    // never treated as a replacement price.
    const pasta = await createItem(ctx.db, { categoryId, name: 'Pasta' }, catalogActor);
    await setItemPrice(ctx.db, pasta.id, paisa(200_00), catalogActor);

    const extras = await createModifierGroup(
      ctx.db,
      { name: 'Extras', minSelect: 0, maxSelect: 5, pricingMode: 'add_on' },
      catalogActor,
    );
    const cheese = await createModifier(ctx.db, { groupId: extras.id, name: 'Extra cheese', priceDeltaMinor: paisa(100_00) }, catalogActor);
    await linkModifierGroup(ctx.db, pasta.id, extras.id, catalogActor);

    const withCheese = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
    await addLine(ctx.db, withCheese.id, { itemId: pasta.id, qty: 1, modifierIds: [cheese.id] }, orderActor);
    expect(await grossOf(withCheese.id)).toBe(300_00); // Rs 200 + Rs 100

    const twoWithCheese = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
    await addLine(ctx.db, twoWithCheese.id, { itemId: pasta.id, qty: 2, modifierIds: [cheese.id] }, orderActor);
    expect(await grossOf(twoWithCheese.id)).toBe(600_00); // 2 × (Rs 200 + Rs 100)
  });

  it('does not rewrite a past order when the size price later changes', async () => {
    const { catalogActor, orderActor, categoryId } = await setup();

    const drink = await createItem(ctx.db, { categoryId, name: 'Soft Drink' }, catalogActor);
    await setItemPrice(ctx.db, drink.id, paisa(200_00), catalogActor);
    const size = await createModifierGroup(
      ctx.db,
      { name: 'Bottle size', minSelect: 1, maxSelect: 1, pricingMode: 'variant' },
      catalogActor,
    );
    const oneAndHalf = await createModifier(ctx.db, { groupId: size.id, name: '1.5 litre', priceDeltaMinor: paisa(0) }, catalogActor);
    await linkModifierGroup(ctx.db, drink.id, size.id, catalogActor);
    await setItemModifierPrice(ctx.db, drink.id, oneAndHalf.id, paisa(0), catalogActor);

    // Sell one at today's price (final Rs 200).
    const sold = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
    await addLine(ctx.db, sold.id, { itemId: drink.id, qty: 1, modifierIds: [oneAndHalf.id] }, orderActor);
    expect(await grossOf(sold.id)).toBe(200_00);

    // Raise the 1.5 litre size to a Rs 250 final (delta +50) afterwards.
    await setItemModifierPrice(ctx.db, drink.id, oneAndHalf.id, paisa(50_00), catalogActor);

    // The already-placed order keeps what it snapshotted: still Rs 200.
    expect(await grossOf(sold.id)).toBe(200_00);

    // A new order gets the new price: Rs 250.
    const later = await createOrder(ctx.db, { orderType: 'takeaway' }, orderActor);
    await addLine(ctx.db, later.id, { itemId: drink.id, qty: 1, modifierIds: [oneAndHalf.id] }, orderActor);
    expect(await grossOf(later.id)).toBe(250_00);
  });
});
