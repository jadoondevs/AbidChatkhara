import type { PurchaseReport } from '../api/types.js';
import { Money } from './ui.tsx';

/**
 * A compact summary of a shift's (or range's) purchases: each partner's
 * total (with the collective total), and each category's total. Built
 * entirely from the report the caller already fetched, so it never
 * disagrees with the totals shown beside it.
 */
export function PurchaseTotals({ report }: { report: PurchaseReport }): JSX.Element {
  if (report.purchases.length === 0) return <p className="muted">No purchases recorded.</p>;
  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
      <div>
        <h4 style={{ margin: '0 0 4px' }}>By partner</h4>
        <table>
          <tbody>
            {report.byPartner.map((line) => (
              <tr key={line.id}>
                <td>{line.name}</td>
                <td className="num muted">{line.count}</td>
                <td className="num">
                  <Money minor={line.totalMinor} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="grand">
              <td>
                <strong>Total</strong>
              </td>
              <td />
              <td className="num">
                <strong>
                  <Money minor={report.totalMinor} />
                </strong>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div>
        <h4 style={{ margin: '0 0 4px' }}>By category</h4>
        <table>
          <tbody>
            {report.byCategory.map((line) => (
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
      </div>
    </div>
  );
}

/** The purchase list split into one column per partner — each partner's
 * own itemised purchases with a subtotal, side by side. Read-only (no
 * void); the Purchases screen has its own interactive version. */
export function PurchaseListByPartner({ report }: { report: PurchaseReport }): JSX.Element {
  if (report.purchases.length === 0) return <p className="muted">No purchases in this range.</p>;
  return (
    <div className="grid" style={{ gridTemplateColumns: `repeat(${Math.max(1, report.byPartner.length)}, minmax(300px, 1fr))`, alignItems: 'start' }}>
      {report.byPartner.map((partner) => (
        <div key={partner.id} className="col">
          <div className="row" style={{ alignItems: 'baseline' }}>
            <h4 style={{ margin: 0, flex: 1 }}>{partner.name}</h4>
            <strong>
              <Money minor={partner.totalMinor} />
            </strong>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Category</th>
                  <th>What</th>
                  <th>Paid from</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {report.purchases
                  .filter((purchase) => purchase.partnerId === partner.id)
                  .map((purchase) => (
                    <tr key={purchase.id}>
                      <td>{new Date(purchase.createdAt).toLocaleString()}</td>
                      <td>{purchase.categoryName}</td>
                      <td>
                        {purchase.description ?? <span className="muted">—</span>}
                        {purchase.note && <div className="muted line-modifiers">{purchase.note}</div>}
                      </td>
                      <td>{purchase.sourceName ?? <span className="muted">—</span>}</td>
                      <td className="num">
                        <Money minor={purchase.amountMinor} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
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
