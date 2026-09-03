import { divideBy, ratio, sum, type Paisa } from '@pos/shared';
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
import type { DailySalesReport, ItemMixLine } from '../api/types.js';
import { ErrorBanner, Loading, Money } from '../components/ui.tsx';

type ReportKey = 'dashboard' | 'daily-sales' | 'partner-statement' | 'item-mix' | 'consumption' | 'service-charge' | 'void-discount';

const REPORTS: { key: ReportKey; label: string; path: string }[] = [
  // The dashboard composes two reports that already exist rather than
  // being one of its own, so its CSV is the daily-sales export.
  { key: 'dashboard', label: 'Dashboard', path: '/api/reports/daily-sales' },
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
  const [active, setActive] = useState<ReportKey>('dashboard');
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
      <div>
        <p className="page-kicker">Reporting</p>
        <h1 style={{ margin: 0 }}>Reports</h1>
      </div>

      <div className="tabs tabs-underline">
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

      {active === 'dashboard' && <Dashboard range={range} />}
      {active === 'daily-sales' && <DailySales range={range} />}
      {active === 'partner-statement' && <PartnerStatementView partnerId={partnerId === '' ? null : partnerId} range={range} />}
      {active === 'item-mix' && <ItemMix range={range} />}
      {active === 'consumption' && <Consumption range={range} />}
      {active === 'service-charge' && <ServiceCharge range={range} />}
      {active === 'void-discount' && <VoidsAndDiscounts range={range} />}
    </div>
  );
}

/**
 * The four figures a manager reads first, above whatever table they came
 * for.
 *
 * Every value here is already in the report the tab fetched — a card is
 * a second reading of one number, never a second query and never a
 * second calculation. `tone` colours the note underneath, not the
 * figure: the number itself is ink, so a red one always means the
 * amount is negative rather than merely notable.
 */
function StatCards({ cards }: { cards: readonly StatCard[] }): JSX.Element {
  return (
    <div className="stat-cards">
      {cards.map((card) => (
        <div key={card.label} className="card stat-card">
          <p className="figure-label">{card.label}</p>
          <p className="figure">{card.value}</p>
          {card.note !== undefined && <p className={`stat-note${card.tone ? ` ${card.tone}` : ''}`}>{card.note}</p>}
        </div>
      ))}
    </div>
  );
}

interface StatCard {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly note?: React.ReactNode;
  readonly tone?: 'good' | 'bad';
}

/** How busy each hour was, drawn as bars rather than a chart library:
 * one div per hour, width proportional to the busiest. */
function HourlySales({ hours }: { hours: DailySalesReport['salesByHour'] }): JSX.Element {
  if (hours.length === 0) return <p className="muted">No sales in this range.</p>;
  // Comparison over branded amounts — no arithmetic.
  const busiest = hours.reduce((best, row) => (row.totalMinor > best.totalMinor ? row : best), hours[0]!);

  return (
    <div className="hour-bars">
      {hours.map((row) => (
        <div key={row.hour} className="hour-bar">
          <span className="hour-bar-label">{hourLabel(row.hour)}</span>
          <span
            className={`hour-bar-fill${row.hour === busiest.hour ? ' peak' : ''}`}
            style={{ width: `${Math.max(2, Math.round(ratio(row.totalMinor, busiest.totalMinor) * 100))}%` }}
          />
          <span className="hour-bar-value">
            <Money minor={row.totalMinor} />
          </span>
        </div>
      ))}
    </div>
  );
}

function hourLabel(hour: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${suffix}`;
}

/**
 * The opening screen of Reports: the day at a glance.
 *
 * It runs no query of its own — it composes the daily-sales and item-mix
 * reports the other tabs already use, so nothing here can disagree with
 * the tab it summarises.
 */
function Dashboard({ range }: { range: DateRange }): JSX.Element {
  const sales = useDailySalesReport(range);
  const items = useItemMixReport(range);

  if (sales.isLoading || items.isLoading) return <Loading />;
  if (sales.error) return <ErrorBanner error={sales.error} />;
  if (items.error) return <ErrorBanner error={items.error} />;
  const data = sales.data;
  if (!data) return <p className="muted">No data.</p>;

  const top = [...(items.data ?? [])].sort((a, b) => b.netSalesMinor - a.netSalesMinor).slice(0, 8);
  const itemsTotalMinor = sum((items.data ?? []).map((line) => line.netSalesMinor));

  return (
    <div className="col">
      <StatCards
        cards={[
          {
            label: 'Net customer sales',
            value: <Money minor={data.customerSalesMinor} />,
            note: data.discountsMinor > 0 ? <>after <Money minor={data.discountsMinor} /> of discounts</> : 'no discounts given',
          },
          { label: 'Orders', value: data.orderCount, note: data.orderCount === 1 ? 'customer bill' : 'customer bills' },
          {
            label: 'Average bill',
            // Rounded for display only — divideBy says so, and the real
            // total is the card beside this one.
            value: data.orderCount > 0 ? <Money minor={divideBy(data.totalCollectedMinor, data.orderCount)} /> : '—',
            note: 'total collected ÷ bills',
          },
          {
            label: 'Service charge',
            value: <Money minor={data.serviceChargeMinor} />,
            note: 'held for waiters, not revenue',
          },
        ]}
      />

      <div className="grid dashboard-grid">
        <div className="card">
          <h3 style={{ margin: 0 }}>Top selling items</h3>
          {top.length === 0 ? (
            <p className="muted">Nothing sold in this range.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Category</th>
                    <th className="num">Qty</th>
                    <th className="num">Net sales</th>
                    <th className="num">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {top.map((line) => (
                    <tr key={line.itemId}>
                      <td>
                        <strong>{line.itemName}</strong>
                      </td>
                      <td className="muted">{line.categoryName ?? '—'}</td>
                      <td className="num">{line.qty}</td>
                      <td className="num">
                        <Money minor={line.netSalesMinor} />
                      </td>
                      <td className="num muted">{sharePercent(line.netSalesMinor, itemsTotalMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h3 style={{ margin: 0 }}>Sales by hour</h3>
          <HourlySales hours={data.salesByHour} />
        </div>
      </div>
    </div>
  );
}

/** A share of the total, as a percentage. `ratio` is the money module's
 * one division whose result is not money — the paisa cancel out. */
function sharePercent(amountMinor: Paisa, totalMinor: Paisa): string {
  if (totalMinor === 0) return '—';
  return `${Math.round(ratio(amountMinor, totalMinor) * 100)}%`;
}

function DailySales({ range }: { range: DateRange }): JSX.Element {
  const report = useDailySalesReport(range);
  if (report.isLoading) return <Loading />;
  if (report.error) return <ErrorBanner error={report.error} />;
  const data = report.data;
  if (!data) return <p className="muted">No data.</p>;

  return (
    <div className="col">
      <StatCards
        cards={[
          { label: 'Gross sales', value: <Money minor={data.grossSalesMinor} />, note: 'what was rung up' },
          {
            label: 'Discounts',
            value: <Money minor={data.discountsMinor} />,
            note: 'taken off the bills',
            ...(data.discountsMinor > 0 ? { tone: 'bad' as const } : {}),
          },
          { label: 'Net customer sales', value: <Money minor={data.customerSalesMinor} />, note: 'after discounts' },
          { label: 'Total collected', value: <Money minor={data.totalCollectedMinor} />, note: 'what customers handed over' },
        ]}
      />

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
      <StatCards
        cards={[
          { label: 'Credited to date', value: <Money minor={data.totalAllocatedMinor} />, note: `to ${data.partnerName}` },
          { label: 'From customer sales', value: <Money minor={data.customerSalesAllocatedMinor} />, note: 'bills settled' },
          { label: 'From consumption', value: <Money minor={data.consumptionAllocatedMinor} />, note: 'staff and owner meals' },
          {
            label: 'Variance',
            value: <Money minor={data.reconciliation.varianceMinor} />,
            note: data.reconciliation.varianceMinor === 0 ? 'balanced' : 'must be zero',
            tone: data.reconciliation.varianceMinor === 0 ? 'good' : 'bad',
          },
        ]}
      />

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
  const lines = report.data ?? [];
  // Reductions over the rows already fetched — no second query, and
  // money is summed by the money module, never by `+`.
  const unitsSold = lines.reduce((total, line) => total + line.qty, 0);
  const best = lines.reduce<ItemMixLine | null>((top, line) => (top === null || line.netSalesMinor > top.netSalesMinor ? line : top), null);

  return (
    <div className="col">
      <StatCards
        cards={[
          { label: 'Items sold', value: lines.length, note: 'distinct menu items' },
          { label: 'Units', value: unitsSold, note: 'individual portions' },
          { label: 'Net sales', value: <Money minor={sum(lines.map((line) => line.netSalesMinor))} />, note: 'across every item' },
          { label: 'Best seller', value: best?.itemName ?? '—', note: best ? <Money minor={best.netSalesMinor} /> : undefined },
        ]}
      />

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
      <StatCards
        cards={[
          { label: 'Menu value', value: <Money minor={sum(data.byPerson.map((p) => p.menuValueMinor))} />, note: 'what it would have sold for' },
          { label: 'Charged', value: <Money minor={sum(data.byPerson.map((p) => p.chargedMinor))} />, note: 'after each meal policy' },
          { label: 'Settled', value: <Money minor={sum(data.byPerson.map((p) => p.settlementMinor))} />, note: 'recovered from staff' },
          { label: 'People', value: data.byPerson.length, note: `${data.lines.length} ${data.lines.length === 1 ? 'item' : 'items'} consumed` },
        ]}
      />

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
  const lines = report.data ?? [];
  const owedMinor = sum(lines.map((line) => line.totalMinor));
  const most = lines.reduce<(typeof lines)[number] | null>((top, line) => (top === null || line.totalMinor > top.totalMinor ? line : top), null);

  return (
    <div className="col">
      <StatCards
        cards={[
          { label: 'Owed to waiters', value: <Money minor={owedMinor} />, note: 'held, not revenue' },
          { label: 'Waiters', value: lines.length, note: lines.length === 1 ? 'has a share' : 'have a share' },
          {
            label: 'Average share',
            value: lines.length > 0 ? <Money minor={divideBy(owedMinor, lines.length)} /> : '—',
            note: 'per waiter',
          },
          { label: 'Most owed', value: most?.waiterName ?? '—', note: most ? <Money minor={most.totalMinor} /> : undefined },
        ]}
      />

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
    </div>
  );
}

function VoidsAndDiscounts({ range }: { range: DateRange }): JSX.Element {
  const report = useVoidAndDiscountReport(range);
  if (report.isLoading) return <Loading />;
  if (report.error) return <ErrorBanner error={report.error} />;
  const entries = report.data ?? [];
  const count = (kind: string) => entries.filter((entry) => entry.kind === kind).length;
  // Only discounts carry an amount; a void's value is the line it
  // removed, which this report does not claim to know.
  const discountedMinor = sum(entries.map((entry) => entry.discountMinor).filter((amount): amount is Paisa => amount !== null));

  return (
    <div className="col">
      <StatCards
        cards={[
          { label: 'Voided lines', value: count('void_line'), note: 'items taken off a bill', ...(count('void_line') > 0 ? { tone: 'bad' as const } : {}) },
          { label: 'Voided orders', value: count('void_order'), note: 'whole bills cancelled', ...(count('void_order') > 0 ? { tone: 'bad' as const } : {}) },
          { label: 'Discounts', value: count('discount'), note: 'bills reduced' },
          { label: 'Discounted', value: <Money minor={discountedMinor} />, note: 'given away', ...(discountedMinor > 0 ? { tone: 'bad' as const } : {}) },
        ]}
      />

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
    </div>
  );
}
