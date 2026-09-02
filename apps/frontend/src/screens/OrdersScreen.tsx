import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOrderSearch } from '../api/hooks.js';
import type { OrderSearchResult } from '../api/types.js';
import { ErrorBanner, Loading, Money } from '../components/ui.tsx';
import { orderTitle } from './OrderScreen.tsx';

/**
 * Orders: what happened, as opposed to what is happening.
 *
 * The floor is a live board a cashier watches; this is a lookup. The
 * two are deliberately different screens because they answer different
 * questions and have different failure modes — a floor that quietly
 * grew to a thousand rows would be useless, and a history that only
 * showed today would not be a history.
 *
 * It opens on today and never loads more than the window asked for. A
 * restaurant six months in has tens of thousands of orders; a screen
 * that fetches all of them to show twenty is a screen that breaks
 * exactly when the business succeeds.
 */

/** Local calendar day as YYYY-MM-DD. `toISOString` would give the UTC
 * day, which is a different day for part of every evening here. */
function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysAgo(n: number): string {
  const date = new Date();
  date.setDate(date.getDate() - n);
  return localDay(date);
}

type Range = { from: string; to: string };

export function OrdersScreen(): JSX.Element {
  const navigate = useNavigate();
  const today = localDay(new Date());
  const [range, setRange] = useState<Range>({ from: today, to: today });
  // Typed separately from the term actually searched: a query per
  // keystroke against a joined search is a query per keystroke.
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');

  const orders = useOrderSearch({ from: range.from, to: range.to, ...(search ? { q: search } : {}) });

  const isToday = range.from === today && range.to === today;
  const isYesterday = range.from === daysAgo(1) && range.to === range.from;
  const isWeek = range.from === daysAgo(6) && range.to === today;

  const submitSearch = () => setSearch(searchDraft.trim());

  return (
    <div className="col orders-screen">
      <div className="row">
        <div style={{ flex: 1 }}>
          <p className="page-kicker">Order history</p>
          <h1 style={{ margin: 0 }}>Orders</h1>
        </div>
        <span className="muted">{orders.data ? `${orders.data.length} order${orders.data.length === 1 ? '' : 's'}` : ''}</span>
      </div>

      <div className="card col report-filter">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="tabs">
            <button className={isToday ? 'active' : ''} onClick={() => setRange({ from: today, to: today })}>
              Today
            </button>
            <button className={isYesterday ? 'active' : ''} onClick={() => setRange({ from: daysAgo(1), to: daysAgo(1) })}>
              Yesterday
            </button>
            <button className={isWeek ? 'active' : ''} onClick={() => setRange({ from: daysAgo(6), to: today })}>
              Last 7 days
            </button>
          </div>

          <span style={{ flex: 1 }} />

          <div>
            <label htmlFor="orders-from">From</label>
            <input
              id="orders-from"
              type="date"
              value={range.from}
              onChange={(event) => setRange((current) => ({ ...current, from: event.target.value }))}
            />
          </div>
          <div>
            <label htmlFor="orders-to">To</label>
            <input
              id="orders-to"
              type="date"
              value={range.to}
              onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))}
            />
            <p className="muted field-hint">Both days included. The same date in both is one day.</p>
          </div>
        </div>

        <div className="row">
          <div style={{ flex: 1 }}>
            <label htmlFor="orders-search">Search</label>
            <input
              id="orders-search"
              placeholder="Order or invoice number, customer, table, staff, payment reference…"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitSearch();
              }}
            />
          </div>
          <button onClick={submitSearch}>Search</button>
          {search !== '' && (
            <button
              className="ghost"
              onClick={() => {
                setSearchDraft('');
                setSearch('');
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <ErrorBanner error={orders.error} />
      {orders.isLoading && <Loading />}

      {orders.data && orders.data.length === 0 && (
        <p className="muted">
          {search ? `Nothing matching “${search}” in this date range.` : 'No orders in this date range.'}
        </p>
      )}

      {orders.data && orders.data.length > 0 && (
        <div className="card">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Order</th>
                  <th>Invoice</th>
                  <th>Customer</th>
                  <th>Staff</th>
                  <th>Status</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {orders.data.map((order) => (
                  <OrderRow key={order.id} order={order} onOpen={() => navigate(`/orders/${order.id}/detail`)} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function OrderRow({ order, onOpen }: { order: OrderSearchResult; onOpen: () => void }): JSX.Element {
  const when = order.closedAt ?? order.openedAt;

  return (
    <tr className="orders-row" onClick={onOpen} tabIndex={0} role="button" onKeyDown={(event) => event.key === 'Enter' && onOpen()}>
      <td>{new Date(when).toLocaleString()}</td>
      <td>
        {orderTitle(order)} <span className="muted">#{order.id}</span>
      </td>
      <td className="muted">{order.invoiceNo === null ? '—' : `#${order.invoiceNo}`}</td>
      <td>{order.customerName ?? <span className="muted">—</span>}</td>
      <td className="muted">{order.waiterName ?? order.settledByName ?? '—'}</td>
      <td>
        <StatusPill order={order} />
      </td>
      <td className="num">
        <Money minor={order.status === 'open' ? order.subtotalMinor : order.totalMinor} />
      </td>
    </tr>
  );
}

function StatusPill({ order }: { order: OrderSearchResult }): JSX.Element {
  if (order.status === 'closed') return <span className="pill ok">Paid</span>;
  if (order.status === 'voided') return <span className="pill">Voided</span>;
  if (order.status === 'billed') {
    return <span className="pill part-paid">{order.paidMinor > 0 ? 'Part paid' : 'Awaiting payment'}</span>;
  }
  return <span className="pill warn">Open</span>;
}
