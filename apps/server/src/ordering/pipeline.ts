import { add, distribute, mulQty, prorate, sub, sum, type Paisa } from '@pos/shared';

/**
 * The pure arithmetic core of the money pipeline's stages 1-4 (line
 * gross, subtotal, order-discount proration, net sales) plus stage 8
 * (allocation base = net sales). No database, no I/O — callers
 * (ordering/service.ts) supply already-looked-up unit prices and
 * modifier deltas and persist the result; this function only computes.
 *
 * Two levels of largest-remainder distribution happen here, not one:
 *
 *  1. The order-level discount is prorated across LINES, in proportion
 *     to each line's full gross (item + its modifiers combined) — this
 *     is exactly the spec's "spread order_discount_minor across lines in
 *     proportion to gross_minor".
 *  2. Each line's own discount share is then further prorated WITHIN
 *     that line, across the item's own portion and each of its
 *     modifiers' portions, so a modifier that has its own partner
 *     ownership (spec: "modifier ownership is optional") gets its own
 *     net_sales_minor / allocation_base_minor to be allocated against —
 *     separately from the base item's, so the allocation engine (a
 *     later milestone) can carve a separately-owned modifier's revenue
 *     out of the line's total without double-counting or under-counting
 *     it against the item's own owners.
 *
 * A line's own gross/net-sales/allocation-base always represents the
 * FULL line (item + all its modifiers combined, per the spec's literal
 * gross_minor formula) — order_line_modifier rows are a breakdown of a
 * slice of that total, not an addition to it. See
 * docs/decisions/004-order-line-modifier-allocation-breakdown.md.
 */

export interface ModifierInput {
  readonly key: string;
  readonly priceDeltaMinor: Paisa;
}

export interface LineInput {
  readonly key: string;
  readonly unitPriceMinor: Paisa;
  readonly qty: number;
  readonly modifiers: readonly ModifierInput[];
}

export interface ComputedModifier {
  readonly key: string;
  readonly grossMinor: Paisa;
  readonly proratedDiscountMinor: Paisa;
  readonly netSalesMinor: Paisa;
  readonly allocationBaseMinor: Paisa;
}

export interface ComputedLine {
  readonly key: string;
  readonly grossMinor: Paisa;
  readonly proratedDiscountMinor: Paisa;
  readonly netSalesMinor: Paisa;
  readonly allocationBaseMinor: Paisa;
  readonly modifiers: readonly ComputedModifier[];
}

export interface OrderPipelineResult {
  readonly subtotalMinor: Paisa;
  readonly netSalesMinor: Paisa;
  readonly lines: readonly ComputedLine[];
}

function lineGrossMinor(line: LineInput): Paisa {
  const modifiersTotal = sum(line.modifiers.map((m) => mulQty(m.priceDeltaMinor, line.qty)));
  return add(mulQty(line.unitPriceMinor, line.qty), modifiersTotal);
}

/**
 * Recompute an order's whole money pipeline (stages 1-4 and 8) from
 * scratch, given its current non-voided lines and order-level discount.
 * Always takes the full current line set, not an incremental delta —
 * there is no partial state to drift out of sync with the database.
 */
export function computeOrderPipeline(lines: readonly LineInput[], orderDiscountMinor: Paisa): OrderPipelineResult {
  const lineGrosses = lines.map(lineGrossMinor);
  const subtotalMinor = sum(lineGrosses);
  const lineDiscounts = prorate(orderDiscountMinor, lineGrosses);

  const computedLines: ComputedLine[] = lines.map((line, i) => {
    const grossMinor = lineGrosses[i] as Paisa;
    const proratedDiscountMinor = lineDiscounts[i] as Paisa;
    const netSalesMinor = sub(grossMinor, proratedDiscountMinor);

    const itemPortion = mulQty(line.unitPriceMinor, line.qty);
    const modifierGrosses = line.modifiers.map((m) => mulQty(m.priceDeltaMinor, line.qty));
    // Item's own portion goes first so remainder ties within a line
    // resolve toward the item before its modifiers, deterministically.
    const subParts = distribute(proratedDiscountMinor, [itemPortion, ...modifierGrosses]);
    const modifierDiscounts = subParts.slice(1);

    const modifiers: ComputedModifier[] = line.modifiers.map((m, j) => {
      const modGross = modifierGrosses[j] as Paisa;
      const modDiscount = modifierDiscounts[j] as Paisa;
      const modNetSales = sub(modGross, modDiscount);
      return {
        key: m.key,
        grossMinor: modGross,
        proratedDiscountMinor: modDiscount,
        netSalesMinor: modNetSales,
        allocationBaseMinor: modNetSales,
      };
    });

    return {
      key: line.key,
      grossMinor,
      proratedDiscountMinor,
      netSalesMinor,
      allocationBaseMinor: netSalesMinor,
      modifiers,
    };
  });

  const netSalesMinor = sum(computedLines.map((l) => l.netSalesMinor));

  return { subtotalMinor, netSalesMinor, lines: computedLines };
}
