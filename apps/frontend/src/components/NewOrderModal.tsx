import { useEffect, useState } from 'react';
import { useCreateOrder, useRiders, useRoster } from '../api/hooks.js';
import type { OrderType } from '../api/types.js';
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
  const ridersQuery = useRiders();

  const [orderType, setOrderType] = useState<OrderType>('dine_in');
  const [tableLabel, setTableLabel] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [riderId, setRiderId] = useState<number | ''>('');
  // Left empty by default — never pre-filled with whoever is signed in.
  // The person taking the order at the till is usually not the waiter
  // serving the table, so defaulting to the logged-in user (an admin,
  // most nights) just meant re-picking every time.
  const [waiterId, setWaiterId] = useState<number | ''>('');

  // Only actual waiters belong in the picker — the roster carries every
  // active user (cashiers, the admin), and attributing a table to the
  // admin who happened to be logged in is exactly the bug this avoids.
  // "Waiter" is the `server` role in this system.
  const waiters = (roster.data ?? []).filter((user) => user.role === 'server');

  // With a single waiter there is no choice to make, so make it for them:
  // the dialog opens with that waiter already selected. Only fills an
  // empty field, so it never fights a deliberate pick when there are
  // several.
  useEffect(() => {
    if (waiterId === '' && waiters.length === 1) setWaiterId(waiters[0]!.id);
  }, [waiters, waiterId]);

  // The rider picker is the delivery twin of the waiter picker: it lists
  // the riders on the books, and auto-selects the only one when there is
  // just one, so a single-rider shop never picks a name.
  const riders = ridersQuery.data ?? [];
  useEffect(() => {
    if (riderId === '' && riders.length === 1) setRiderId(riders[0]!.id);
  }, [riders, riderId]);

  const dineIn = orderType === 'dine_in';
  const delivery = orderType === 'delivery';
  // A dine-in needs a waiter and a delivery needs a rider: each order is
  // attributed to the person who ran it, and the payout sheets are keyed
  // to them. Neither can be started without that person.
  const canCreate = (!dineIn || waiterId !== '') && (!delivery || riderId !== '');

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
        ...(delivery && riderId !== '' ? { riderId: Number(riderId) } : {}),
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
                {waiters.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
              {roster.isError && <p className="muted">Couldn’t load the staff list. Check the connection and try again.</p>}
              {!roster.isLoading && !roster.isError && waiters.length === 0 && (
                <p className="muted">No waiters yet — add a staff member with the “server” role under Settings.</p>
              )}
            </div>
          )}

          {/* The rider carries the order and is who any delivery charge is
              owed to — required on every delivery, the same way a waiter is
              required on every dine-in. */}
          {delivery && (
            <div>
              <label htmlFor="rider">Rider</label>
              <select id="rider" value={riderId} onChange={(event) => setRiderId(event.target.value === '' ? '' : Number(event.target.value))}>
                <option value="">Select a rider…</option>
                {riders.map((rider) => (
                  <option key={rider.id} value={rider.id}>
                    {rider.name}
                  </option>
                ))}
              </select>
              {!ridersQuery.isLoading && !ridersQuery.isError && riders.length === 0 && (
                <p className="muted">No riders yet — add them under Riders.</p>
              )}
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
