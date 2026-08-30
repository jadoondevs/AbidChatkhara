import { proportionalAmount, sum, type Paisa } from '@pos/shared';
import type { OrderType } from '../ordering/tables.js';

export interface TaxableLine {
  readonly key: string;
  readonly categoryId: number;
  readonly netSalesMinor: Paisa;
}

export interface TaxRuleInput {
  readonly rateBp: number;
  /** null matches every category. */
  readonly appliesToCategoryId: number | null;
  /** null matches every order type. */
  readonly appliesToOrderType: OrderType | null;
  readonly inclusive: boolean;
}

export interface LineTaxResult {
  readonly key: string;
  readonly taxMinor: Paisa;
}

export interface TaxComputationResult {
  readonly lines: readonly LineTaxResult[];
  /** sum(lines[].taxMinor) — order.tax_minor, added to net_sales_minor at
   * the money pipeline's stage 7 exactly as the spec's formula says,
   * unconditionally: see docs/decisions/010 for why `inclusive` changes
   * how a rule's rate is applied, not whether it's added at stage 7. */
  readonly taxMinor: Paisa;
}

function applicableRules(line: TaxableLine, orderType: OrderType, rules: readonly TaxRuleInput[]): TaxRuleInput[] {
  return rules.filter(
    (r) =>
      (r.appliesToCategoryId === null || r.appliesToCategoryId === line.categoryId) &&
      (r.appliesToOrderType === null || r.appliesToOrderType === orderType),
  );
}

/**
 * Pure, no I/O — same shape as partners' allocateOne and consumption's
 * computeMealCharge. Money pipeline stage 5: computed from each line's
 * *already-discount-prorated* net_sales_minor, never from gross_minor —
 * a line's tax reflects what it actually sold for, not its list price.
 *
 * Multiple applicable rules on one line stack additively — each rule's
 * contribution is computed independently against the line's own
 * netSalesMinor (never against a running compound total), which is
 * exact for the ordinary case of one applicable rule and a reasonable,
 * documented simplification for the rare case of two stacked rules on
 * the same line.
 */
export function computeTax(lines: readonly TaxableLine[], orderType: OrderType, rules: readonly TaxRuleInput[]): TaxComputationResult {
  const lineResults: LineTaxResult[] = lines.map((line) => {
    const applicable = applicableRules(line, orderType, rules).filter((r) => r.rateBp > 0);
    const contributions = applicable.map((rule) =>
      proportionalAmount(line.netSalesMinor, rule.rateBp, rule.inclusive ? 10_000 + rule.rateBp : 10_000),
    );
    return { key: line.key, taxMinor: sum(contributions) };
  });

  return { lines: lineResults, taxMinor: sum(lineResults.map((l) => l.taxMinor)) };
}
