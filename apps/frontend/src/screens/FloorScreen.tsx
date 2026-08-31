import { useNavigate } from 'react-router-dom';
import { useFloorBoard, useOpenShift, useRoster } from '../api/hooks.js';
import type { FloorOrder } from '../api/types.js';
import { ErrorBanner, Loading, Money, elapsedSince } from '../components/ui.tsx';
import { orderTitle } from './OrderScreen.tsx';

/**
 * Screen 2, the home screen: three live lists, in the order work moves
 * through them.
 *
 * The split is the server's (`/api/orders/board`), not this screen's.
 * That matters: a settled bill sitting in a list of things that still
 * need paying is an operationally dangerous mistake, and the fix has to
 * be one query answering "where is this order" rather than three
 * screens each filtering their own copy and one of them getting it
 * wrong.
 *
 * Nothing here is modal, and there is no "current order": every row
 * navigates by the order's own id, so a cashier can pick up any order
 * at any time and two tills never fight over one (see ARCHITECTURE.md,
 * "no current order").
 */
export function FloorScreen(): JSX.Element {
  const navigate = useNavigate();
  const board = useFloorBoard();
  const openShift = useOpenShift();

  return (
    <div className="col floor">
      <div className="row">
        <h1 style={{ margin: 0, flex: 1 }}>Floor</h1>
        {openShift.data === null && <span className="pill warn">No shift open</span>}
      </div>

      <ErrorBanner error={board.error} />

      <div className="floor-board">
        <OrderList
          title="Open orders"
          subtitle="still being taken"
          tone="open"
          orders={board.data?.open}
          loading={board.isLoading}
          onOpen={(order) => navigate(`/orders/${order.id}`)}
        />
        <OrderList
          title="Awaiting payment"
          subtitle="billed, not fully paid"
          tone="awaiting"
          orders={board.data?.awaitingPayment}
          loading={board.isLoading}
          onOpen={(order) => navigate(`/orders/${order.id}/payment`)}
        />
        <OrderList
          title="Completed"
          subtitle="paid and closed"
          tone="done"
          orders={board.data?.completed}
          loading={board.isLoading}
          onOpen={(order) => navigate(`/orders/${order.id}/payment`)}
        />
      </div>
    </div>
  );
}

function OrderList({
  title,
  subtitle,
  tone,
  orders,
  loading,
  onOpen,
}: {
  title: string;
  subtitle: string;
  tone: 'open' | 'awaiting' | 'done';
  orders: FloorOrder[] | undefined;
  loading: boolean;
  onOpen: (order: FloorOrder) => void;
}): JSX.Element {
  const roster = useRoster();
  const waiterName = (id: number | null) => roster.data?.find((user) => user.id === id)?.name ?? null;

  return (
    <section className={`card floor-list floor-list-${tone}`}>
      <header className="floor-list-header">
        <h2>{title}</h2>
        <span className="muted">{subtitle}</span>
        <span className="count">{orders?.length ?? 0}</span>
      </header>

      {loading && <Loading />}
      {orders && orders.length === 0 && <p className="muted">Nothing here.</p>}

      <div className="col" style={{ gap: 8 }}>
        {orders?.map((order) => (
          <button key={order.id} className="order-row" onClick={() => onOpen(order)}>
            <span className="order-row-main">
              <strong>{orderTitle(order)}</strong>
              <span className="muted order-row-id">#{order.id}</span>
              {order.channel !== 'customer' && <span className="pill staff">{order.channel === 'staff_meal' ? 'Staff' : 'Owner'}</span>}
              {order.waiterId !== null && <span className="muted">{waiterName(order.waiterId) ?? `waiter ${order.waiterId}`}</span>}
            </span>

            <span className="order-row-money">
              {tone === 'awaiting' && order.paidMinor > 0 ? (
                // A part-paid bill must not look like an untouched one:
                // what is still owed is the number the cashier needs.
                <>
                  <span className="pill part-paid">Part paid</span>
                  <span>
                    <Money minor={order.balanceMinor} /> <span className="muted">left</span>
                  </span>
                </>
              ) : (
                <Money minor={order.status === 'open' ? order.subtotalMinor : order.totalMinor} />
              )}
              {tone === 'done' && order.invoiceNo !== null && <span className="muted">#{order.invoiceNo}</span>}
              {tone !== 'done' && <span className="muted">{elapsedSince(order.openedAt)}</span>}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
