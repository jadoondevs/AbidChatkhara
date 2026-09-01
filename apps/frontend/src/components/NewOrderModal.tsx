import { useState } from 'react';
import { useCreateOrder, useRoster } from '../api/hooks.js';
import type { OrderType } from '../api/types.js';
import { useAuth } from '../auth/AuthContext.tsx';
import { ErrorBanner, Modal } from './ui.tsx';

const ORDER_TYPES: { value: OrderType; label: string }[] = [
  { value: 'dine_in', label: 'Dine in' },
  { value: 'takeaway', label: 'Takeaway' },
  { value: 'delivery', label: 'Delivery' },
];

/**
 * The one place an order is created, used from the header on every
 * screen. Lives in components/ rather than on the floor screen because
 * "start an order" is not a floor-screen action — it is what the till
 * is for, and duplicating this form per screen is how two subtly
 * different order-creation paths appear.
 *
 * A table label is OPTIONAL, including for dine-in: a counter sale, a
 * garden table nobody numbered, or a customer standing at the till are
 * all real dine-in orders. The server agrees — this is not a field the
 * UI merely stopped marking required.
 */
export function NewOrderModal({ onClose, onCreated }: { onClose: () => void; onCreated: (orderId: number) => void }): JSX.Element {
  const createOrder = useCreateOrder();
  const roster = useRoster();
  const { session } = useAuth();

  const [orderType, setOrderType] = useState<OrderType>('dine_in');
  const [tableLabel, setTableLabel] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [waiterId, setWaiterId] = useState<number | ''>(session?.userId ?? '');

  const dineIn = orderType === 'dine_in';
  // The waiter is still required for dine-in: service charge and the
  // payout sheet are attributed to a person, and there is nobody to
  // attribute them to without one.
  const canCreate = !dineIn || waiterId !== '';

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canCreate || createOrder.isPending) return;
    createOrder.mutate(
      {
        orderType,
        ...(tableLabel.trim() ? { tableLabel: tableLabel.trim() } : {}),
        ...(customerName.trim() ? { customerName: customerName.trim() } : {}),
        ...(customerPhone.trim() ? { customerPhone: customerPhone.trim() } : {}),
        ...(dineIn && waiterId !== '' ? { waiterId: Number(waiterId) } : {}),
      },
      { onSuccess: (order) => onCreated(order.id) },
    );
  };

  return (
    <Modal title="New order" onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBanner error={createOrder.error} />
        <div className="col">
          <div>
            <label>Order type</label>
            <div className="tabs">
              {ORDER_TYPES.map((type) => (
                <button
                  key={type.value}
                  type="button"
                  className={type.value === orderType ? 'active' : ''}
                  onClick={() => setOrderType(type.value)}
                >
                  {type.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="table-label">Table (optional)</label>
            <input
              id="table-label"
              autoFocus
              value={tableLabel}
              onChange={(event) => setTableLabel(event.target.value)}
              placeholder={dineIn ? 'T1 — or leave blank' : 'Usually blank'}
            />
          </div>

          {/* Only where it is used. A delivery needs a name and a
              number to arrive at all; a dine-in table does not, and a
              field nobody fills is a field everyone tabs past. Both
              stay optional and both can be added later from the order
              screen. */}
          {!dineIn && (
            <div className="row">
              <div style={{ flex: 2 }}>
                <label htmlFor="customer-name-new">Customer (optional)</label>
                <input id="customer-name-new" maxLength={120} value={customerName} onChange={(event) => setCustomerName(event.target.value)} />
              </div>
              <div style={{ flex: 1 }}>
                <label htmlFor="customer-phone-new">Phone</label>
                <input
                  id="customer-phone-new"
                  maxLength={40}
                  inputMode="tel"
                  value={customerPhone}
                  onChange={(event) => setCustomerPhone(event.target.value)}
                />
              </div>
            </div>
          )}

          {dineIn && (
            <div>
              <label htmlFor="waiter">Waiter</label>
              <select id="waiter" value={waiterId} onChange={(event) => setWaiterId(event.target.value === '' ? '' : Number(event.target.value))}>
                <option value="">Select a waiter…</option>
                {roster.data?.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
              {roster.isError && <p className="muted">Couldn’t load the staff list. Check the connection and try again.</p>}
            </div>
          )}

          <button className="primary big" type="submit" disabled={!canCreate || createOrder.isPending}>
            {createOrder.isPending ? 'Starting…' : 'Start order'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
