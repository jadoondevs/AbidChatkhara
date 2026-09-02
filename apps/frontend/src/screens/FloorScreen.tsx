import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useDeleteEmptyOrder,
  useFloorBoard,
  useOpenShift,
  useRoster,
} from "../api/hooks.js";
import type { FloorOrder } from "../api/types.js";
import {
  ErrorBanner,
  Loading,
  Modal,
  Money,
  elapsedSince,
} from "../components/ui.tsx";
import { orderTitle } from "./OrderScreen.tsx";

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
  const deleteOrder = useDeleteEmptyOrder();
  const [deleting, setDeleting] = useState<FloorOrder | null>(null);

  return (
    <div className="col floor">
      <div className="row">
        <div style={{ flex: 1 }}>
          <p className="page-kicker">Live board · {new Date().toLocaleDateString()}</p>
          <h1 style={{ margin: 0 }}>Floor</h1>
        </div>
        {openShift.data === null && (
          <span className="pill warn">No shift open</span>
        )}
      </div>

      <ErrorBanner error={board.error ?? deleteOrder.error} />

      <div className="floor-board">
        <OrderList
          title="Open orders"
          subtitle="still being taken"
          tone="open"
          orders={board.data?.open}
          loading={board.isLoading}
          onOpen={(order) => navigate(`/orders/${order.id}`)}
          onDelete={setDeleting}
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
          // A settled bill has nothing left to take, so its row opens the
          // record of what happened — who served it, what was on it, how
          // it was paid — rather than a till screen with one line on it.
          onOpen={(order) => navigate(`/orders/${order.id}/detail`)}
        />
      </div>
      {deleting && (
        <Modal title="Delete empty order?" onClose={() => setDeleting(null)}>
          <div className="col">
            <p style={{ margin: 0 }}>
              {orderTitle(deleting)}{" "}
              <span className="muted">#{deleting.id}</span> has no items on it.
            </p>
            <p className="muted" style={{ margin: 0 }}>
              It was never billed and nothing was paid, so there is no record to
              keep. Removing it also stops it holding the shift open.
            </p>
            <div className="row">
              <button className="ghost" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <span style={{ flex: 1 }} />
              <button
                className="danger big"
                disabled={deleteOrder.isPending}
                onClick={() =>
                  deleteOrder.mutate(deleting.id, {
                    onSuccess: () => setDeleting(null),
                  })
                }
              >
                {deleteOrder.isPending ? "Deleting…" : "Delete order"}
              </button>
            </div>
          </div>
        </Modal>
      )}
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
  onDelete,
}: {
  title: string;
  subtitle: string;
  tone: "open" | "awaiting" | "done";
  orders: FloorOrder[] | undefined;
  loading: boolean;
  onOpen: (order: FloorOrder) => void;
  /** Only passed for the open list: an order with anything on it is a
   * record, and records are voided, never deleted. */
  onDelete?: ((order: FloorOrder) => void) | undefined;
}): JSX.Element {
  const roster = useRoster();
  const waiterName = (id: number | null) =>
    roster.data?.find((user) => user.id === id)?.name ?? null;

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
          <div key={order.id} className="order-row-wrap">
            {/* The delete affordance sits OUTSIDE the row button: a
                nested button is not clickable, and a stray tap on a
                real order's row must never remove anything. */}
            {onDelete && order.lineCount === 0 && (
              <button
                className="ghost order-row-delete"
                title="Delete this empty order"
                aria-label={`Delete empty order ${order.id}`}
                onClick={() => onDelete(order)}
              >
                ✕
              </button>
            )}
            <button className="order-row" onClick={() => onOpen(order)}>
              <span className="order-row-main">
                <strong>{orderTitle(order)}</strong>
                <span className="muted order-row-id">#{order.id}</span>
                {order.channel !== "customer" && (
                  <span className="pill staff">
                    {order.channel === "staff_meal" ? "Staff" : "Owner"}
                  </span>
                )}
                {order.waiterId !== null && (
                  <span className="muted">
                    {waiterName(order.waiterId) ?? `waiter ${order.waiterId}`}
                  </span>
                )}
              </span>

              <span className="order-row-money">
                {tone === "awaiting" && order.paidMinor > 0 ? (
                  // A part-paid bill must not look like an untouched one:
                  // what is still owed is the number the cashier needs.
                  <>
                    <span className="pill part-paid">Part paid</span>
                    <span>
                      <Money minor={order.balanceMinor} />{" "}
                      <span className="muted">left</span>
                    </span>
                  </>
                ) : (
                  <Money
                    minor={
                      order.status === "open"
                        ? order.subtotalMinor
                        : order.totalMinor
                    }
                  />
                )}
                {tone === "done" && order.invoiceNo !== null && (
                  <span className="muted">#{order.invoiceNo}</span>
                )}
                {tone !== "done" && (
                  <span className="muted">{elapsedSince(order.openedAt)}</span>
                )}
              </span>
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
