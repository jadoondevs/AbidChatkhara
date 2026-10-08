import { add, paisa, type Paisa } from '@pos/shared';
import type { PurchaseReport } from '../api/types.js';
import { Money } from './ui.tsx';

/**
 * A shift's (or a range's) purchases laid out as a matrix: one row per
 * category, one COLUMN PER PARTNER, each cell what that partner spent in
 * that category — with a per-partner total row and a grand total. Built
 * entirely from the report the caller already fetched, so it never
 * disagrees with the totals shown beside it.
 */
export function PurchasePartnerMatrix({ report }: { report: PurchaseReport }): JSX.Element {
  const partners = report.byPartner;
  const categories = report.byCategory;

  if (report.purchases.length === 0) return <p className="muted">No purchases recorded.</p>;

  // cell[categoryId][partnerId] — summed with the money module, never `+`.
  const cell = new Map<string, Paisa>();
  for (const purchase of report.purchases) {
    const key = `${purchase.categoryId}:${purchase.partnerId}`;
    cell.set(key, add(cell.get(key) ?? paisa(0), purchase.amountMinor));
  }

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Category</th>
            {partners.map((partner) => (
              <th key={partner.id} className="num">
                {partner.name}
              </th>
            ))}
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {categories.map((category) => (
            <tr key={category.id}>
              <td>{category.name}</td>
              {partners.map((partner) => {
                const value = cell.get(`${category.id}:${partner.id}`);
                return (
                  <td key={partner.id} className="num">
                    {value === undefined ? <span className="muted">—</span> : <Money minor={value} />}
                  </td>
                );
              })}
              <td className="num">
                <Money minor={category.totalMinor} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="grand">
            <td>
              <strong>TOTAL</strong>
            </td>
            {partners.map((partner) => (
              <td key={partner.id} className="num">
                <strong>
                  <Money minor={partner.totalMinor} />
                </strong>
              </td>
            ))}
            <td className="num">
              <strong>
                <Money minor={report.totalMinor} />
              </strong>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Where the shift's purchase money came from — Cash drawer vs. whoever
 * fronted it — with a count and amount each. A pure record, never netted
 * against the drawer or sales. */
export function PurchaseBySource({ report }: { report: PurchaseReport }): JSX.Element {
  if (report.bySource.length === 0) return <p className="muted">No purchases recorded.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Paid from</th>
          <th className="num">Count</th>
          <th className="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        {report.bySource.map((line) => (
          <tr key={line.id}>
            <td>{line.name}</td>
            <td className="num muted">{line.count}</td>
            <td className="num">
              <Money minor={line.totalMinor} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
