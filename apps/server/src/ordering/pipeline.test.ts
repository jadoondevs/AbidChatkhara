import { add, mulQty, paisa, sum } from '@pos/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeOrderPipeline, type LineInput } from './pipeline.js';

describe('computeOrderPipeline — no discount', () => {
  it('a single line with no modifiers: gross = net = unitPrice * qty', () => {
    const result = computeOrderPipeline([{ key: 'a', unitPriceMinor: paisa(500_00), qty: 2, modifiers: [] }], paisa(0));
    expect(result.subtotalMinor).toBe(1_000_00);
    expect(result.netSalesMinor).toBe(1_000_00);
    expect(result.lines[0]).toMatchObject({ grossMinor: 1_000_00, proratedDiscountMinor: 0, netSalesMinor: 1_000_00, allocationBaseMinor: 1_000_00 });
  });

  it('a line with modifiers includes their delta * qty in the line total, and gives each its own gross', () => {
    const result = computeOrderPipeline(
      [
        {
          key: 'a',
          unitPriceMinor: paisa(500_00),
          qty: 2,
          modifiers: [
            { key: 'extra-cheese', priceDeltaMinor: paisa(50_00) },
            { key: 'extra-spicy', priceDeltaMinor: paisa(0) },
          ],
        },
      ],
      paisa(0),
    );
    // (500 + 50 + 0) * 2 = 1100
    expect(result.subtotalMinor).toBe(1_100_00);
    const [line] = result.lines;
    expect(line?.grossMinor).toBe(1_100_00);
    expect(line?.modifiers.map((m) => [m.key, m.grossMinor])).toEqual([
      ['extra-cheese', 100_00], // 50 * 2
      ['extra-spicy', 0],
    ]);
  });

  it('multiple lines sum to the subtotal', () => {
    const result = computeOrderPipeline(
      [
        { key: 'a', unitPriceMinor: paisa(300_00), qty: 1, modifiers: [] },
        { key: 'b', unitPriceMinor: paisa(200_00), qty: 3, modifiers: [] },
      ],
      paisa(0),
    );
    expect(result.subtotalMinor).toBe(900_00); // 300 + 600
  });

  it('no lines and no discount is the empty order, cleanly', () => {
    const result = computeOrderPipeline([], paisa(0));
    expect(result).toMatchObject({ subtotalMinor: 0, netSalesMinor: 0, lines: [] });
  });
});

describe('computeOrderPipeline — discount proration', () => {
  it('a 10% order discount on a two-item bill reduces each line by exactly 10% when it divides evenly', () => {
    const result = computeOrderPipeline(
      [
        { key: 'a', unitPriceMinor: paisa(500_00), qty: 1, modifiers: [] }, // Rs 500
        { key: 'b', unitPriceMinor: paisa(300_00), qty: 1, modifiers: [] }, // Rs 300
      ],
      paisa(80_00), // 10% of Rs 800 subtotal
    );
    expect(result.lines[0]).toMatchObject({ proratedDiscountMinor: 50_00, netSalesMinor: 450_00 });
    expect(result.lines[1]).toMatchObject({ proratedDiscountMinor: 30_00, netSalesMinor: 270_00 });
    expect(result.netSalesMinor).toBe(720_00);
  });

  it('a line discount is sub-prorated between the item and its modifiers, item first on ties', () => {
    // Line: item Rs 100, one modifier also Rs 100 -> equal weights, so a
    // 1-paisa remainder always breaks toward the item (index 0).
    const result = computeOrderPipeline(
      [
        {
          key: 'a',
          unitPriceMinor: paisa(100_00),
          qty: 1,
          modifiers: [{ key: 'topping', priceDeltaMinor: paisa(100_00) }],
        },
      ],
      paisa(1), // an amount that doesn't split evenly between the two Rs-100 portions
    );
    const line = result.lines[0]!;
    const modifierDiscount = line.modifiers[0]!.proratedDiscountMinor;
    const itemDiscount = line.proratedDiscountMinor - modifierDiscount;
    expect(itemDiscount).toBe(1); // item gets the odd paisa
    expect(modifierDiscount).toBe(0);
  });

  it('property: the order discount always sums exactly across lines, and net sales = subtotal - discount', () => {
    const lineArb = fc.record({
      key: fc.uuid(),
      unitPriceMinor: fc.integer({ min: 0, max: 10_000_00 }).map((v) => paisa(v)),
      qty: fc.integer({ min: 1, max: 20 }),
      modifiers: fc.array(
        fc.record({ key: fc.uuid(), priceDeltaMinor: fc.integer({ min: 0, max: 1_000_00 }).map((v) => paisa(v)) }),
        { maxLength: 5 },
      ),
    });

    // Generate the lines first, then a discount bounded by their total
    // gross — the two are dependent, so `.chain()` combines them into
    // one arbitrary rather than nesting fc.property calls (a nested
    // fc.property's return value is not itself a pass/fail signal to
    // the outer one; only fc.assert interprets it as a check to run).
    const linesAndDiscount = fc.array(lineArb, { minLength: 1, maxLength: 8 }).chain((lines: LineInput[]) => {
      const grossByLine = lines.map((l) =>
        add(mulQty(l.unitPriceMinor, l.qty), sum(l.modifiers.map((m) => mulQty(m.priceDeltaMinor, l.qty)))),
      );
      const totalGross = sum(grossByLine);
      return fc.record({ lines: fc.constant(lines), totalGross: fc.constant(totalGross), discountRaw: fc.integer({ min: 0, max: totalGross }) });
    });

    fc.assert(
      fc.property(linesAndDiscount, ({ lines, totalGross, discountRaw }) => {
        const discount = paisa(discountRaw);
        const result = computeOrderPipeline(lines, discount);

        expect(result.subtotalMinor).toBe(totalGross);
        const totalLineDiscount = sum(result.lines.map((l) => l.proratedDiscountMinor));
        expect(totalLineDiscount).toBe(discount);
        expect(result.netSalesMinor).toBe(totalGross - discount);
        expect(sum(result.lines.map((l) => l.netSalesMinor))).toBe(result.netSalesMinor);

        for (const line of result.lines) {
          expect(line.netSalesMinor + line.proratedDiscountMinor).toBe(line.grossMinor);
          for (const modifier of line.modifiers) {
            expect(modifier.netSalesMinor + modifier.proratedDiscountMinor).toBe(modifier.grossMinor);
          }
          const modifierDiscountTotal = sum(line.modifiers.map((m) => m.proratedDiscountMinor));
          expect(modifierDiscountTotal).toBeLessThanOrEqual(line.proratedDiscountMinor);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('zero-value and fully-discounted lines allocate zero without error', () => {
    const result = computeOrderPipeline(
      [
        { key: 'free', unitPriceMinor: paisa(0), qty: 1, modifiers: [] },
        { key: 'full', unitPriceMinor: paisa(100_00), qty: 1, modifiers: [] },
      ],
      paisa(100_00), // fully discounts the paid line
    );
    expect(result.lines[0]).toMatchObject({ grossMinor: 0, proratedDiscountMinor: 0, netSalesMinor: 0 });
    expect(result.lines[1]).toMatchObject({ grossMinor: 100_00, proratedDiscountMinor: 100_00, netSalesMinor: 0 });
  });
});
