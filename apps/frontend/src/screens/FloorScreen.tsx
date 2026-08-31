import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCreateOrder, useOpenShift, useOrders, useUsers } from '../api/hooks.js';
import type { OrderSummary, OrderType } from '../api/types.js';
import { useAuth } from '../auth/AuthContext.tsx';
import { ErrorBanner, Loading, Modal, Money, elapsedSince } from '../components/ui.tsx';

/**
 * Screen 2, the home screen: two live lists side by side — open orders
 * still being taken, and billed orders awaiting payment. Nothing here is
 * modal, and there is no "current order": every row navigates by the
 * order's own id, so a cashier can jump into any order at any time and
 * two tills never fight over one (see ARCHITECTURE.md, "no current
 * order").
 */
export function FloorScreen(): JSX.Element {
  const navigate = useNavigate();
  const openOrders = useOrders(['open']);
  const billedOrders = useOrders(['billed']);
  const openShift = useOpenShift();
  const [newOrderOpen, setNewOrderOpen] = useState(false);

  return (
    <div className="col" style={{ height: '100%' }}>
      <div className="row">
        <h1 style={{ margin: 0, flex: 1 }}>Floor</h1>
        {openShift.data === null && <span className="pill warn">No shift open</span>}
        <button className="primary big" onClick={() => setNewOrderOpen(true)}>
          + New order
        </button>
      </div>

      <ErrorBanner error={openOrders.error ?? billedOrders.error} />

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
        <OrderList
          title="Open orders"
          subtitle="still being taken"
          orders={openOrders.data}
          loading={openOrders.isLoading}
          onOpen={(order) => navigate(`/orders/${order.id}`)}
        />
        <OrderList
          title="Awaiting payment"
          subtitle="billed, unpaid"
          orders={billedOrders.data}
          loading={billedOrders.isLoading}
          onOpen={(order) =>
            navigate(order.channel === 'customer' ? `/orders/${order.id}/payment` : `/orders/${order.id}/payment`)
          }
        />
      </div>

      {newOrderOpen && <NewOrderModal onClose={() => setNewOrderOpen(false)} />}
    </div>
  );
}

function OrderList({
  title,
  subtitle,
  orders,
  loading,
  onOpen,
}: {
  title: string;
  subtitle: string;
  orders: OrderSummary[] | undefined;
  loading: boolean;
  onOpen: (order: OrderSummary) => void;
}): JSX.Element {
  const users = useUsers();
  const waiterName = (id: number | null) => users.data?.find((user) => user.id === id)?.name ?? null;

  return (
    <div className="card">
      <h2 style={{ marginBottom: 2 }}>{title}</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {subtitle}
      </p>
      {loading && <Loading />}
      {orders && orders.length === 0 && <p className="muted">Nothing here.</p>}
      <div className="col">
        {orders?.map((order) => (
          <button key={order.id} className="big" style={{ justifyContent: 'space-between', display: 'flex' }} onClick={() => onOpen(order)}>
            <span className="row" style={{ gap: 10 }}>
              <strong>{order.tableLabel ?? order.orderType.replace('_', ' ')}</strong>
              {order.channel !== 'customer' && <span className="pill staff">{order.channel === 'staff_meal' ? 'Staff' : 'Owner'}</span>}
              {order.waiterId !== null && <span className="muted">{waiterName(order.waiterId) ?? `waiter ${order.waiterId}`}</span>}
            </span>
            <span className="row" style={{ gap: 14 }}>
              <Money minor={order.status === 'open' ? order.subtotalMinor : order.totalMinor} />
              <span className="muted">{elapsedSince(order.openedAt)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function NewOrderModal({ onClose }: { onClose: () => void }): JSX.Element {
  const navigate = useNavigate();
  const createOrder = useCreateOrder();
  const users = useUsers();
  const { session } = useAuth();
  const [orderType, setOrderType] = useState<OrderType>('dine_in');
  const [tableLabel, setTableLabel] = useState('');
  const [waiterId, setWaiterId] = useState<number | ''>(session?.userId ?? '');

  const dineIn = orderType === 'dine_in';
  const canCreate = !dineIn || (tableLabel.trim() !== '' && waiterId !== '');

  const submit = () => {
    createOrder.mutate(
      {
        orderType,
        ...(dineIn ? { tableLabel: tableLabel.trim(), waiterId: Number(waiterId) } : {}),
      },
      { onSuccess: (order) => navigate(`/orders/${order.id}`) },
    );
  };

  return (
    <Modal title="New order" onClose={onClose}>
      <ErrorBanner error={createOrder.error} />
      <div className="col">
        <div>
          <label>Order type</label>
          <div className="tabs">
            {(['dine_in', 'takeaway', 'delivery'] as const).map((type) => (
              <button key={type} className={type === orderType ? 'active' : ''} onClick={() => setOrderType(type)}>
                {type.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>

        {dineIn && (
          <>
            <div>
              <label htmlFor="table-label">Table</label>
              <input id="table-label" value={tableLabel} onChange={(event) => setTableLabel(event.target.value)} placeholder="T1" />
            </div>
            <div>
              <label htmlFor="waiter">Waiter</label>
              <select id="waiter" value={waiterId} onChange={(event) => setWaiterId(event.target.value === '' ? '' : Number(event.target.value))}>
                <option value="">Select a waiter…</option>
                {users.data?.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
              {users.isError && <p className="muted">Waiter list needs manager access — enter the order as takeaway, or sign in as a manager.</p>}
            </div>
          </>
        )}

        <button className="primary big" disabled={!canCreate || createOrder.isPending} onClick={submit}>
          Start order
        </button>
      </div>
    </Modal>
  );
}
