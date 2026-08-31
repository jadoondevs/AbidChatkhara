import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import { useAddLine, useCategories, useItemModifierGroups, useMenu, useModifiers, useOrder, usePeople, useVoidLine } from '../api/hooks.js';
import type { MenuItem, OrderDetail, OrderLine } from '../api/types.js';
import { ErrorBanner, Loading, ManagerApproval, Modal, Money } from '../components/ui.tsx';

/**
 * Screen 3: category tabs, item grid, search, a running bill panel, and
 * quantity/modifier selection. A line void needs manager approval — if
 * the signed-in user isn't one, the void is retried with a manager's
 * own one-shot token rather than making them sign the till over.
 */
export function OrderScreen(): JSX.Element {
  const { orderId: orderIdParam } = useParams();
  const orderId = Number(orderIdParam);
  const navigate = useNavigate();

  const order = useOrder(orderId);
  const categories = useCategories();
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const menu = useMenu(categoryId ?? undefined);
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);

  if (order.isLoading) return <Loading />;
  if (order.error) return <ErrorBanner error={order.error} />;
  if (!order.data) return <p>Order not found.</p>;

  const detail = order.data;
  const staffMeal = detail.channel !== 'customer';
  const filtered = (menu.data ?? []).filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="split">
      <div className="col" style={{ minWidth: 0 }}>
        {staffMeal && <BeneficiaryBanner order={detail} />}

        <div className="row">
          <h1 style={{ margin: 0, flex: 1 }}>
            {detail.tableLabel ?? detail.orderType.replace('_', ' ')} <span className="muted">#{detail.id}</span>
          </h1>
          <input
            style={{ maxWidth: 260 }}
            placeholder="Search items…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="tabs">
          <button className={categoryId === null ? 'active' : ''} onClick={() => setCategoryId(null)}>
            All
          </button>
          {categories.data?.map((category) => (
            <button key={category.id} className={categoryId === category.id ? 'active' : ''} onClick={() => setCategoryId(category.id)}>
              {category.name}
            </button>
          ))}
        </div>

        {menu.isLoading ? (
          <Loading />
        ) : (
          <div className="item-grid">
            {filtered.map((item) => (
              <button key={item.id} disabled={!item.available || item.priceMinor === null} onClick={() => setSelectedItem(item)}>
                <strong>{item.name}</strong>
                <span className="muted">
                  {item.priceMinor === null ? 'no price set' : <Money minor={item.priceMinor} />}
                  {!item.available && ' · unavailable'}
                </span>
              </button>
            ))}
            {filtered.length === 0 && <p className="muted">No items match.</p>}
          </div>
        )}
      </div>

      <RunningBill order={detail} onBill={() => navigate(`/orders/${detail.id}/bill`)} />

      {selectedItem && <AddLineModal orderId={detail.id} item={selectedItem} onClose={() => setSelectedItem(null)} />}
    </div>
  );
}

function BeneficiaryBanner({ order }: { order: OrderDetail }): JSX.Element {
  const people = usePeople();
  const person = people.data?.find((candidate) => candidate.id === order.beneficiaryPersonId);
  return (
    <div className="banner">
      {order.channel === 'staff_meal' ? 'Staff meal' : 'Owner meal'} — {person?.name ?? `person ${order.beneficiaryPersonId}`}
      {person && ` · ${person.mealPolicy.replace('_', ' ')}${person.mealPolicy === 'discounted' ? ` (${person.mealDiscountBp / 100}% off)` : ''}`}
    </div>
  );
}

function RunningBill({ order, onBill }: { order: OrderDetail; onBill: () => void }): JSX.Element {
  const voidLine = useVoidLine();
  const [voiding, setVoiding] = useState<{ line: OrderLine; reason: string } | null>(null);
  const [needsApproval, setNeedsApproval] = useState<{ line: OrderLine; reason: string } | null>(null);

  const live = order.lines.filter((line) => !line.voided);

  const submitVoid = (line: OrderLine, reason: string, token?: string) => {
    voidLine.mutate(
      { orderId: order.id, lineId: line.id, reason, ...(token === undefined ? {} : { token }) },
      {
        onSuccess: () => {
          setVoiding(null);
          setNeedsApproval(null);
        },
        onError: (error) => {
          // 403 means the signed-in user isn't a manager — ask for a
          // manager's PIN and retry this one call as them.
          if (error instanceof ApiError && error.isForbidden) {
            setVoiding(null);
            setNeedsApproval({ line, reason });
          }
        },
      },
    );
  };

  return (
    <div className="card col" style={{ height: '100%', overflow: 'auto' }}>
      <h2 style={{ margin: 0 }}>Running bill</h2>
      <ErrorBanner error={voidLine.error instanceof ApiError && voidLine.error.isForbidden ? null : voidLine.error} />

      {live.length === 0 && <p className="muted">No items yet.</p>}

      <div className="col" style={{ gap: 6 }}>
        {live.map((line) => (
          <div key={line.id} className="row" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <div>
                {line.qty} × <ItemName itemId={line.itemId} />
              </div>
              {line.modifiers.length > 0 && (
                <div className="muted" style={{ fontSize: 13 }}>
                  {line.modifiers.map((modifier) => (
                    <ModifierName key={modifier.id} modifierId={modifier.modifierId} />
                  ))}
                </div>
              )}
            </div>
            <Money minor={line.grossMinor} />
            <button className="ghost" onClick={() => setVoiding({ line, reason: '' })}>
              Void
            </button>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 'auto' }}>
        <div className="total-line">
          <span>Subtotal</span>
          <Money minor={order.subtotalMinor} />
        </div>
        {order.orderDiscountMinor > 0 && (
          <div className="total-line">
            <span>Discount</span>
            <Money minor={order.orderDiscountMinor} />
          </div>
        )}
        <div className="total-line grand">
          <span>Net sales</span>
          <Money minor={order.netSalesMinor} />
        </div>
        <button className="primary big" style={{ width: '100%', marginTop: 12 }} disabled={live.length === 0} onClick={onBill}>
          Go to bill
        </button>
      </div>

      {voiding && (
        <Modal title="Void line" onClose={() => setVoiding(null)}>
          <div className="col">
            <div>
              <label htmlFor="void-reason">Reason</label>
              <input
                id="void-reason"
                autoFocus
                value={voiding.reason}
                onChange={(event) => setVoiding({ ...voiding, reason: event.target.value })}
              />
            </div>
            <p className="muted">A line void needs manager approval.</p>
            <button className="danger big" disabled={!voiding.reason.trim()} onClick={() => submitVoid(voiding.line, voiding.reason.trim())}>
              Void line
            </button>
          </div>
        </Modal>
      )}

      {needsApproval && (
        <ManagerApproval
          action="void line"
          onApproved={(token) => submitVoid(needsApproval.line, needsApproval.reason, token)}
          onCancel={() => setNeedsApproval(null)}
        />
      )}
    </div>
  );
}

function ItemName({ itemId }: { itemId: number }): JSX.Element {
  const menu = useMenu();
  return <>{menu.data?.find((item) => item.id === itemId)?.name ?? `item ${itemId}`}</>;
}

function ModifierName({ modifierId }: { modifierId: number }): JSX.Element {
  const modifiers = useModifiers();
  const modifier = modifiers.data?.find((candidate) => candidate.id === modifierId);
  return <span style={{ marginRight: 8 }}>+ {modifier?.name ?? `modifier ${modifierId}`}</span>;
}

function AddLineModal({ orderId, item, onClose }: { orderId: number; item: MenuItem; onClose: () => void }): JSX.Element {
  const addLine = useAddLine();
  const groups = useItemModifierGroups(item.id);
  const allModifiers = useModifiers();
  const [qty, setQty] = useState(1);
  const [selected, setSelected] = useState<number[]>([]);

  const toggle = (modifierId: number, group: { maxSelect: number; id: number }) => {
    setSelected((current) => {
      if (current.includes(modifierId)) return current.filter((id) => id !== modifierId);
      const inGroup = current.filter((id) => allModifiers.data?.find((m) => m.id === id)?.groupId === group.id);
      // Respect the group's own max — the server enforces it too, but a
      // cashier shouldn't have to discover that by being rejected.
      if (inGroup.length >= group.maxSelect) return [...current.filter((id) => !inGroup.includes(id)), modifierId];
      return [...current, modifierId];
    });
  };

  return (
    <Modal title={item.name} onClose={onClose}>
      <ErrorBanner error={addLine.error} />
      <div className="col">
        <div>
          <label>Quantity</label>
          <div className="row">
            <button className="big" onClick={() => setQty((current) => Math.max(1, current - 1))}>
              −
            </button>
            <span className="mono" style={{ fontSize: 28, minWidth: 60, textAlign: 'center' }}>
              {qty}
            </span>
            <button className="big" onClick={() => setQty((current) => current + 1)}>
              +
            </button>
          </div>
        </div>

        {groups.data?.map((group) => {
          const options = (allModifiers.data ?? []).filter((modifier) => modifier.groupId === group.id && modifier.active);
          return (
            <div key={group.id}>
              <label>
                {group.name} — choose {group.minSelect === group.maxSelect ? group.minSelect : `${group.minSelect}–${group.maxSelect}`}
              </label>
              <div className="tabs">
                {options.map((modifier) => (
                  <button
                    key={modifier.id}
                    className={selected.includes(modifier.id) ? 'active' : ''}
                    onClick={() => toggle(modifier.id, group)}
                  >
                    {modifier.name}
                    {modifier.priceDeltaMinor !== 0 && (
                      <>
                        {' '}
                        <Money minor={modifier.priceDeltaMinor} />
                      </>
                    )}
                  </button>
                ))}
              </div>
            </div>
          );
        })}

        <button
          className="primary big"
          disabled={addLine.isPending}
          onClick={() =>
            addLine.mutate({ orderId, itemId: item.id, qty, modifierIds: selected }, { onSuccess: onClose })
          }
        >
          Add to order
        </button>
      </div>
    </Modal>
  );
}
