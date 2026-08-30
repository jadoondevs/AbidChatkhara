import { paisa } from '@pos/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeTax, type TaxRuleInput, type TaxableLine } from './engine.js';

describe('tax/engine', () => {
  const mains: TaxableLine = { key: 'l1', categoryId: 1, netSalesMinor: paisa(1000_00) };
  const drinks: TaxableLine = { key: 'l2', categoryId: 2, netSalesMinor: paisa(200_00) };

  it('with no active rules, every line taxes zero', () => {
    const result = computeTax([mains, drinks], 'dine_in', []);
    expect(result.taxMinor).toBe(0);
    expect(result.lines.every((l) => l.taxMinor === 0)).toBe(true);
  });

  it('an exclusive rate applying to every category and order type', () => {
    const rule: TaxRuleInput = { rateBp: 1_600, appliesToCategoryId: null, appliesToOrderType: null, inclusive: false };
    const result = computeTax([mains, drinks], 'dine_in', [rule]);
    expect(result.lines).toEqual([
      { key: 'l1', taxMinor: 160_00 },
      { key: 'l2', taxMinor: 32_00 },
    ]);
    expect(result.taxMinor).toBe(192_00);
  });

  it('a rule scoped to one category only taxes lines in that category', () => {
    const rule: TaxRuleInput = { rateBp: 1_600, appliesToCategoryId: 2, appliesToOrderType: null, inclusive: false };
    const result = computeTax([mains, drinks], 'dine_in', [rule]);
    expect(result.lines).toEqual([
      { key: 'l1', taxMinor: 0 },
      { key: 'l2', taxMinor: 32_00 },
    ]);
  });

  it('a rule scoped to one order type does not apply to a different order type', () => {
    const rule: TaxRuleInput = { rateBp: 1_600, appliesToCategoryId: null, appliesToOrderType: 'delivery', inclusive: false };
    expect(computeTax([mains], 'dine_in', [rule]).taxMinor).toBe(0);
    expect(computeTax([mains], 'delivery', [rule]).taxMinor).toBe(160_00);
  });

  it('an inclusive rate extracts, rather than adds on top of, the rate applied to the line', () => {
    // 16% inclusive of Rs 1000 extracts Rs 137.93..., i.e. 13793 paisa rounded.
    const rule: TaxRuleInput = { rateBp: 1_600, appliesToCategoryId: null, appliesToOrderType: null, inclusive: true };
    const result = computeTax([mains], 'dine_in', [rule]);
    expect(result.lines[0]?.taxMinor).toBe(137_93);
    // Less than the exclusive rate would have produced on the same base.
    expect(result.lines[0]?.taxMinor).toBeLessThan(160_00);
  });

  it('two applicable rules stack additively on the same line', () => {
    const gst: TaxRuleInput = { rateBp: 1_600, appliesToCategoryId: null, appliesToOrderType: null, inclusive: false };
    const serviceTax: TaxRuleInput = { rateBp: 500, appliesToCategoryId: null, appliesToOrderType: null, inclusive: false };
    const result = computeTax([mains], 'dine_in', [gst, serviceTax]);
    expect(result.lines[0]?.taxMinor).toBe(160_00 + 50_00);
  });

  it('a zero-value line (e.g. every line voided before billing) taxes zero without error', () => {
    const rule: TaxRuleInput = { rateBp: 1_600, appliesToCategoryId: null, appliesToOrderType: null, inclusive: false };
    const result = computeTax([{ key: 'l1', categoryId: 1, netSalesMinor: paisa(0) }], 'dine_in', [rule]);
    expect(result.taxMinor).toBe(0);
  });

  describe('property: enabling tax never changes what a line would have been worth pre-tax', () => {
    it('computeTax never mutates or depends on anything but netSalesMinor + the given rules', () => {
      fc.assert(
        fc.property(
          fc.record({
            netSalesMinor: fc.integer({ min: 0, max: 10_000_000 }),
            rateBp: fc.integer({ min: 0, max: 5_000 }),
            inclusive: fc.boolean(),
          }),
          ({ netSalesMinor, rateBp, inclusive }) => {
            const line: TaxableLine = { key: 'x', categoryId: 1, netSalesMinor: paisa(netSalesMinor) };
            const rule: TaxRuleInput = { rateBp, appliesToCategoryId: null, appliesToOrderType: null, inclusive };
            const before = computeTax([line], 'dine_in', []);
            const after = computeTax([line], 'dine_in', [rule]);
            expect(before.taxMinor).toBe(0); // baseline: no rules, no tax
            expect(after.taxMinor).toBeGreaterThanOrEqual(0);
            expect(line.netSalesMinor).toBe(netSalesMinor); // the input line itself is never touched
          },
        ),
      );
    });
  });
});
