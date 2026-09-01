import { useState } from 'react';
import { query } from '../api/client.js';
import {
  useConsumptionReport,
  useDailySalesReport,
  useItemMixReport,
  usePartnerStatement,
  usePartners,
  useServiceChargeReport,
  useVoidAndDiscountReport,
  type DateRange,
} from '../api/hooks.js';
import { ErrorBanner, Loading, Money } from '../components/ui.tsx';

type ReportKey = 'daily-sales' | 'partner-statement' | 'item-mix' | 'consumption' | 'service-charge' | 'void-discount';

const REPORTS: { key: ReportKey; label: string; path: string }[] = [
  { key: 'daily-sales', label: 'Daily sales', path: '/api/reports/daily-sales' },
  { key: 'partner-statement', label: 'Partner statement', path: '/api/reports/partners' },
  { key: 'item-mix', label: 'Item mix', path: '/api/reports/item-mix' },
  { key: 'consumption', label: 'Consumption', path: '/api/reports/consumption' },
  { key: 'service-charge', label: 'Service charge', path: '/api/reports/service-charge' },
  { key: 'void-discount', label: 'Voids & discounts', path: '/api/reports/void-and-discount' },
];

/** Screen 11. Every report takes the same date range and every one is
 * CSV-exportable — the export link is the same endpoint with
 * `?format=csv`, so what's on screen and what's downloaded can't drift
 * apart. */
/** Local calendar day as YYYY-MM-DD — `toISOString` would give the UTC
 * day, which is a different day for part of every evening in Pakistan. */
function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysAgo(n: number): string {
  const date = new Date();
  date.setDate(date.getDate() - n);
  return localDay(date);
}

export function ReportsScreen(): JSX.Element {
  const [active, setActive] = useState<ReportKey>('daily-sales');
  // Day-granular and INCLUSIVE at both ends, which is what an operator
  // means by "From 31 August, To 31 August". The old fields were an
  // exact instant range with an exclusive upper bound, so that entry
  // returned nothing at all.
  const [from, setFrom] = useState(localDay(new Date()));
  const [to, setTo] = useState(localDay(new Date()));
  const [partnerId, setPartnerId] = useState<number | ''>('');
  const partners = usePartners();

  const range: DateRange = { ...(from ? { from } : {}), ...(to ? { to } : {}) };

  const setDay = (day: string) => {
    setFrom(day);
    setTo(day);
  };

  const isToday = from === localDay(new Date()) && to === from;
  const isYesterday = from === daysAgo(1) && to === from;
  const isThisMonth = from === localDay(new Date(new Date().getFullYear(), new Date().getMonth(), 1)) && to === localDay(new Date());

  const report = REPORTS.find((candidate) => candidate.key === active);
  const csvHref =
    active === 'partner-statement'
      ? partnerId === ''
        ? null
        : `/api/reports/partners/${partnerId}/statement${query({ ...range, format: 'csv' })}`
      : `${report?.path ?? ''}${query({ ...range, format: 'csv' })}`;

  return (
    <div className="col">
      <h1 style={{ margin: 0 }}>Reports</h1>

      <div className="tabs">
        {REPORTS.map((candidate) => (
          <button key={candidate.key} className={candidate.key === active ? 'active' : ''} onClick={() => setActive(candidate.key)}>
            {candidate.label}
          </button>
        ))}
      </div>

      <div className="card col report-filter">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="tabs">
            <button className={isToday ? 'active' : ''} onClick={() => setDay(localDay(new Date()))}>
              Today
            </button>
            <button className={isYesterday ? 'active' : ''} onClick={() => setDay(daysAgo(1))}>
              Yesterday
            </button>
            <button
              className={!isToday && !isYesterday && !isThisMonth ? 'active' : ''}
              onClick={() => {
                setFrom(daysAgo(6));
                setTo(localDay(new Date()));
              }}
            >
              Last 7 days
            </button>
            <button
              className={isThisMonth ? 'active' : ''}
              onClick={() => {
                setFrom(localDay(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
                setTo(localDay(new Date()));
              }}
            >
              This month
            </button>
          </div>
        </div>

        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div>
            <label htmlFor="from">From</label>
            <input id="from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div>
            <label htmlFor="to">To</label>
            <input id="to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            <p className="muted field-hint">Both days are included. The same date in both gives one day.</p>
          </div>

          {active === 'partner-statement' && (
            <div style={{ minWidth: 220 }}>
              <label htmlFor="partner">Partner</label>
              <select id="partner" value={partnerId} onChange={(event) => setPartnerId(event.target.value === '' ? '' : Number(event.target.value))}>
                <option value="">Select a partner…</option>
                {partners.data?.map((partner) => (
                  <option key={partner.id} value={partner.id}>
                    {partner.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <span style={{ flex: 1 }} />
          {csvHref && (
            <a href={csvHref} download>
              <button>Export CSV</button>
            </a>
          )}
        </div>
      </div>

      {active === 'daily-sales' && <DailySales range={range} />}
      {active === 'partner-statement' && <PartnerStatementView partnerId={partnerId === '' ? null : partnerId} range={range} />}
      {active === 'item-mix' && <ItemMix range={range} />}
      {active === 'consumption' && <Consumption range={range} />}
      {active === 'service-charge' && <ServiceCharge range={range} />}
      {active === 'void-discount' && <VoidsAndDiscounts range={range} />}
    </div>
  );
}

function DailySales({ range }: { range: DateRange }): JSX.Element {
  const report = useDailySalesReport(range);
  if (report.isLoading) return <Loading />;
  if (report.error) return <ErrorBanner error={report.error} />;
  const data = report.data;
  if (!data) return <p className="muted">No data.</p>;

  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
      {/* The whole chain, in the order it happens: what was rung up,
          what was taken off, what that leaves, what was added on top,
          and what customers actually handed over. A single "sales"
          figure cannot be reconciled against a cash drawer; this can. */}
      <div className="card">
        <h3 style={{ margin: 0 }}>Sales</h3>
        <div className="total-line">
          <span>Gross sales</span>
          <Money minor={data.grossSalesMinor} />
        </div>
        <div className="total-line">
          <span>Discounts</span>
          <Money minor={data.discountsMinor} />
        </div>
        <div className="total-line grand">
          <span>Net customer sales</span>
          <Money minor={data.customerSalesMinor} />
        </div>
        <div className="total-line">
          <span>Staff &amp; owner consumption</span>
          <Money minor={data.consumptionMinor} />
        </div>
        <div className="total-line">
          <span>Combined net sales</span>
          <Money minor={data.combinedSalesMinor} />
        </div>
        <div className="total-line">
          <span>Tax collected</span>
          <Money minor={data.taxCollectedMinor} />
        </div>
        {/* Held for the waiters, never revenue (docs/decisions/008) —
            so it is on its own line here and on its own line in the
            payout breakdown, never folded into sales. */}
        <div className="total-line">
          <span>Service charge (owed to waiters)</span>
          <Money minor={data.serviceChargeMinor} />
        </div>
        <div className="total-line">
          <span>Rounding adjustments</span>
          <Money minor={data.roundingAdjustmentMinor} />
        </div>
        <div className="total-line grand">
          <span>Total collected</span>
          <Money minor={data.totalCollectedMinor} />
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: 0 }}>Payment methods</h3>
        <table>
          <tbody>
            {data.paymentMethodBreakdown.map((line) => (
              <tr key={line.paymentMethodId}>
                <td>{line.paymentMethodName}</td>
                <td className="num">
                  <Money minor={line.totalMinor} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Service charge per waiter</h3>
        <table>
          <tbody>
            {data.serviceChargeByWaiter.map((line) => (
              <tr key={line.waiterId}>
                <td>{line.waiterName}</td>
                <td className="num">
                  <Money minor={line.totalMinor} />
                </td>
              </tr>
            ))}
            {data.serviceChargeByWaiter.length === 0 && (
              <tr>
                <td className="muted">None.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PartnerStatementView({ partnerId, range }: { partnerId: number | null; range: DateRange }): JSX.Element {
  const statement = usePartnerStatement(partnerId, range);
  if (partnerId === null) return <p className="muted">Pick a partner.</p>;
  if (statement.isLoading) return <Loading />;
  if (statement.error) return <ErrorBanner error={statement.error} />;
  const data = statement.data;
  if (!data) return <p className="muted">No data.</p>;

  return (
    <div className="col">
      <div className="card">
        <h3 style={{ margin: 0 }}>{data.partnerName}</h3>
        <div className="total-line grand">
          <span>Total allocated</span>
          <Money minor={data.totalAllocatedMinor} />
        </div>
        <div className="total-line">
          <span>From customer sales</span>
          <Money minor={data.customerSalesAllocatedMinor} />
        </div>
        <div className="total-line">
          <span>From staff &amp; owner consumption</span>
          <Money minor={data.consumptionAllocatedMinor} />
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: 0 }}>Reconciliation</h3>
        <div className="total-line">
          <span>Total allocation base</span>
          <Money minor={data.reconciliation.allocationBaseMinor} />
        </div>
        <div className="total-line">
          <span>Total allocated</span>
          <Money minor={data.reconciliation.totalAllocatedMinor} />
        </div>
        <div className="total-line grand" style={{ color: data.reconciliation.varianceMinor === 0 ? 'var(--success)' : 'var(--danger)' }}>
          <span>Variance {data.reconciliation.varianceMinor === 0 ? '(must be zero — it is)' : '(must be zero!)'}</span>
          <Money minor={data.reconciliation.varianceMinor} />
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: 0 }}>By item</h3>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Qty</th>
              <th className="num">Allocated</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.itemId}>
                <td>{item.itemName}</td>
                <td className="num">{item.qty}</td>
                <td className="num">
                  <Money minor={item.allocatedMinor} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ItemMix({ range }: { range: DateRange }): JSX.Element {
  const report = useItemMixReport(range);
  if (report.isLoading) return <Loading />;
  if (report.error) return <ErrorBanner error={report.error} />;

  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Qty</th>
            <th className="num">Value</th>
            <th>Owners</th>
          </tr>
        </thead>
        <tbody>
          {report.data?.map((line) => (
            <tr key={line.itemId}>
              <td>{line.itemName}</td>
              <td className="num">{line.qty}</td>
              <td className="num">
                <Money minor={line.netSalesMinor} />
              </td>
              <td>
                {line.owners.map((owner) => `${owner.partnerName} ${owner.shareBp / 100}%`).join(', ') || <span className="muted">unowned</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Consumption({ range }: { range: DateRange }): JSX.Element {
  const report = useConsumptionReport(range);
  if (report.isLoading) return <Loading />;
  if (report.error) return <ErrorBanner error={report.error} />;
  const data = report.data;
  if (!data) return <p className="muted">No data.</p>;

  return (
    <div className="col">
      <div className="card">
        <h3 style={{ margin: 0 }}>Per person</h3>
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th className="num">Menu value</th>
              <th className="num">Charged</th>
              <th className="num">Settled</th>
            </tr>
          </thead>
          <tbody>
            {data.byPerson.map((person) => (
              <tr key={person.personId}>
                <td>{person.personName}</td>
                <td className="num">
                  <Money minor={person.menuValueMinor} />
                </td>
                <td className="num">
                  <Money minor={person.chargedMinor} />
                </td>
                <td className="num">
                  <Money minor={person.settlementMinor} />
                </td>
              </tr>
            ))}
            {data.byPerson.length === 0 && (
              <tr>
                <td className="muted">Nothing consumed in this period.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* The point of this report: what was actually eaten, not just a
          column of totals. One row per item, with the person's share of
          what they were charged for it. */}
      <div className="card">
        <h3 style={{ margin: 0 }}>Every item consumed</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          The CSV export contains exactly these rows.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Person</th>
                <th>Item</th>
                <th className="num">Qty</th>
                <th className="num">Menu value</th>
                <th className="num">Charged</th>
                <th>Policy</th>
                <th>Settlement</th>
                <th className="num">Order</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line) => (
                <tr key={`${line.consumptionRecordId}-${line.itemName}-${line.qty}-${line.menuValueMinor}`}>
                  <td>{new Date(line.consumedAt).toLocaleString()}</td>
                  <td>{line.personName}</td>
                  <td>
                    {line.itemName}
                    {line.modifierNames && <div className="muted line-modifiers">{line.modifierNames}</div>}
                  </td>
                  <td className="num">{line.qty}</td>
                  <td className="num">
                    <Money minor={line.menuValueMinor} />
                  </td>
                  <td className="num">
                    <Money minor={line.chargedMinor} />
                  </td>
                  <td>{line.mealPolicy.replace(/_/g, ' ')}</td>
                  <td>{line.settlementType?.replace(/_/g, ' ') ?? '—'}</td>
                  <td className="num">{line.invoiceNo !== null ? `#${line.invoiceNo}` : `order ${line.orderId}`}</td>
                </tr>
              ))}
              {data.lines.length === 0 && (
                <tr>
                  <td className="muted">No items consumed in this period.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ServiceCharge({ range }: { range: DateRange }): JSX.Element {
  const report = useServiceChargeReport(range);
  if (report.isLoading) return <Loading />;
  if (report.error) return <ErrorBanner error={report.error} />;

  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>Waiter</th>
            <th className="num">Owed</th>
          </tr>
        </thead>
        <tbody>
          {report.data?.map((line) => (
            <tr key={line.waiterId}>
              <td>{line.waiterName}</td>
              <td className="num">
                <Money minor={line.totalMinor} />
              </td>
            </tr>
          ))}
          {report.data?.length === 0 && (
            <tr>
              <td className="muted">Nothing in this range.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function VoidsAndDiscounts({ range }: { range: DateRange }): JSX.Element {
  const report = useVoidAndDiscountReport(range);
  if (report.isLoading) return <Loading />;
  if (report.error) return <ErrorBanner error={report.error} />;

  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>What</th>
            <th>Order</th>
            <th>Reason</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {report.data?.map((entry) => (
            <tr key={entry.id}>
              <td>{new Date(entry.createdAt).toLocaleString()}</td>
              <td>{entry.actorName ?? '—'}</td>
              <td>{entry.kind.replace('_', ' ')}</td>
              <td>{entry.orderId ?? '—'}</td>
              <td>{entry.reason ?? '—'}</td>
              <td className="num">{entry.discountMinor === null ? '—' : <Money minor={entry.discountMinor} />}</td>
            </tr>
          ))}
          {report.data?.length === 0 && (
            <tr>
              <td className="muted">Nothing in this range.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
