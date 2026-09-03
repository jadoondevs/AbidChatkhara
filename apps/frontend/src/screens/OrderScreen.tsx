import { add, mulQty, paisa, type Paisa } from '@pos/shared';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import {
  useAddLine,
  useCategories,
  useItemModifierGroups,
  useItemModifierPrices,
  useMenu,
  useModifiers,
  useOrder,
  usePeople,
  useRemoveLine,
  useSetLineNote,
  useSetLineQty,
  useSetOrderCustomer,
  useVoidLine,
} from '../api/hooks.js';
import type { MenuItem, Modifier, ModifierGroup, OrderDetail, OrderLine } from '../api/types.js';
import { ErrorBanner, Loading, ManagerApproval, Modal, Money, QtyInput } from '../components/ui.tsx';
import { BillPanel } from './BillScreen.tsx';

/**
 * Screen 3: an item grid on the left, the running bill on the right.
 *
 * The core interaction is one click: tap an item and it lands on the
 * bill. Tapping it again increments the line (the server merges it —
 * see ordering's addLine), so the common case of "three of those"
 * costs three taps and no dialog at all. A dialog appears only when the
 * item genuinely needs an answer: a modifier group the kitchen requires
 * a choice from, or one the customer may want options out of.
 *
 * The previous version opened a modal for every item, with + and −
 * buttons for a quantity nobody had asked to change yet. That is a
 * dialog to confirm a decision the cashier already made by clicking.
 */
export function OrderScreen(): JSX.Element {
  const { orderId: orderIdParam } = useParams();
  const orderId = Number(orderIdParam);
  const navigate = useNavigate();

  const order = useOrder(orderId);
  const categories = useCategories();
  const allModifiers = useModifiers();
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const menu = useMenu(categoryId ?? undefined);
  const addLine = useAddLine();
  const [configuring, setConfiguring] = useState<MenuItem | null>(null);
  // The bill is a dialog over this screen, not a page of its own:
  // reviewing an order's total is a step in taking the order.
  const [billing, setBilling] = useState(false);

  if (order.isLoading) return <Loading />;
  if (order.error) return <ErrorBanner error={order.error} />;
  if (!order.data) return <p>Order not found.</p>;

  const detail = order.data;
  const staffMeal = detail.channel !== 'customer';
  const filtered = (menu.data ?? []).filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="split order-screen">
      <div className="col" style={{ minWidth: 0 }}>
        {staffMeal && <BeneficiaryBanner order={detail} />}
        {!staffMeal && detail.orderType !== 'dine_in' && <CustomerBar order={detail} />}

        <div className="row">
          <h1 style={{ margin: 0, flex: 1 }}>
            {orderTitle(detail)} <span className="muted">#{detail.id}</span>
          </h1>
          <input
            style={{ maxWidth: 280 }}
            placeholder="Search items…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <ErrorBanner error={addLine.error} />

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
              <ItemButton
                key={item.id}
                item={item}
                busy={addLine.isPending}
                onPick={(needsChoice) => {
                  if (needsChoice) {
                    setConfiguring(item);
                    return;
                  }
                  addLine.mutate({ orderId: detail.id, itemId: item.id, qty: 1 });
                }}
              />
            ))}
            {filtered.length === 0 && <p className="muted">No items match.</p>}
          </div>
        )}
      </div>

      <RunningBill order={detail} onBill={() => setBilling(true)} />

      {billing && (
        <Modal title="" wide onClose={() => setBilling(false)}>
          <BillPanel
            orderId={detail.id}
            onBackToOrder={() => setBilling(false)}
            // Straight to the till for THIS order — the cashier who
            // printed the bill is the one about to take the money for
            // it, and the floor detour in between was pure friction.
            onPrinted={(id) => navigate(`/orders/${id}/payment`)}
            onCancelled={() => navigate('/')}
          />
        </Modal>
      )}

      {configuring && (
        <ModifierPicker
          orderId={detail.id}
          item={configuring}
          allModifiers={allModifiers.data ?? []}
          onClose={() => setConfiguring(null)}
        />
      )}
    </div>
  );
}

/**
 * One item tile. It has to know whether the item has modifier groups
 * before it can decide between "add it straight away" and "ask first",
 * so it loads them itself — the answer is cached per item by the query
 * client, so a grid of thirty items is thirty cached lookups, not
 * thirty requests per render.
 */
function ItemButton({ item, busy, onPick }: { item: MenuItem; busy: boolean; onPick: (needsChoice: boolean) => void }): JSX.Element {
  const groups = useItemModifierGroups(item.id);
  const needsChoice = (groups.data?.length ?? 0) > 0;
  const unavailable = !item.available || item.priceMinor === null;

  return (
    <button className="item-tile" disabled={unavailable || busy || groups.isLoading} onClick={() => onPick(needsChoice)}>
      <strong>{item.name}</strong>
      <span className="muted">
        {item.priceMinor === null ? 'no price set' : <Money minor={item.priceMinor} />}
        {!item.available && ' · unavailable'}
      </span>
      {needsChoice && <span className="tile-hint">options</span>}
    </button>
  );
}

/** "Table T4", or the kind of order when there is no table. A table
 * label is optional now, so a missing one must read as a normal
 * takeaway rather than as something that failed to load. */
export function orderTitle(order: { tableLabel: string | null; orderType: string }): string {
  if (order.tableLabel) return `Table ${order.tableLabel}`;
  return order.orderType === 'dine_in' ? 'Dine in' : order.orderType === 'takeaway' ? 'Takeaway' : 'Delivery';
}

/**
 * Who a takeaway or delivery order is for.
 *
 * Shown only where it is actually used: a dine-in customer at a table
 * has no name to give and asking for one would be a field every order
 * has to tab past. Saved explicitly rather than on every keystroke —
 * a phone number typed digit by digit is not eight separate edits to
 * the order.
 */
function CustomerBar({ order }: { order: OrderDetail }): JSX.Element {
  const save = useSetOrderCustomer();
  const [name, setName] = useState(order.customerName ?? '');
  const [phone, setPhone] = useState(order.customerPhone ?? '');

  const dirty = name !== (order.customerName ?? '') || phone !== (order.customerPhone ?? '');

  return (
    <div className="card row customer-bar">
      <div style={{ flex: 2 }}>
        <label htmlFor="customer-name">Customer</label>
        <input id="customer-name" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
      </div>
      <div style={{ flex: 1 }}>
        <label htmlFor="customer-phone">Phone</label>
        <input id="customer-phone" value={phone} maxLength={40} inputMode="tel" onChange={(event) => setPhone(event.target.value)} />
      </div>
      <button
        className={dirty ? 'primary' : 'ghost'}
        disabled={!dirty || save.isPending}
        onClick={() => save.mutate({ orderId: order.id, customerName: name, customerPhone: phone })}
      >
        {save.isPending ? 'Saving…' : dirty ? 'Save' : 'Saved'}
      </button>
      <ErrorBanner error={save.error} />
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

/**
 * The modifier dialog, shown only for items that have groups.
 *
 * Every mandatory group is PRE-SELECTED with its first option. That is
 * the actual fix for the spice-level bug: the dialog used to open with
 * nothing chosen, so a cashier who clicked "Add to order" — the obvious
 * thing to do — got a server rejection reading `"Spice level" requires
 * between 1 and 1 selection(s); got 0`. A required choice with a
 * sensible default is a choice the cashier can confirm or change, not
 * a trap. The submit button additionally stays disabled, with the
 * reason spelled out, if a group is somehow still unsatisfied.
 */
function ModifierPicker({
  orderId,
  item,
  allModifiers,
  onClose,
}: {
  orderId: number;
  item: MenuItem;
  allModifiers: Modifier[];
  onClose: () => void;
}): JSX.Element {
  const addLine = useAddLine();
  const groups = useItemModifierGroups(item.id);
  // What each option costs ON THIS ITEM. A size group is shared by
  // sixteen dishes that all price Full differently, so the group's own
  // delta is zero and the real number lives here (migration 0020). The
  // server already charges the override; showing the group default
  // instead would put a price on screen that is not the price charged.
  const overrides = useItemModifierPrices(item.id);
  const [qty, setQty] = useState(1);
  const [selected, setSelected] = useState<number[] | null>(null);

  const optionsFor = (group: ModifierGroup) => allModifiers.filter((modifier) => modifier.groupId === group.id);
  const deltaFor = (modifier: Modifier): Paisa =>
    overrides.data?.find((override) => override.modifierId === modifier.id)?.priceDeltaMinor ?? modifier.priceDeltaMinor;

  // Defaults, computed once the groups and modifiers have both arrived.
  if (selected === null && groups.data && allModifiers.length > 0) {
    const defaults: number[] = [];
    for (const group of groups.data) {
      const options = optionsFor(group);
      for (let i = 0; i < group.minSelect && i < options.length; i += 1) {
        defaults.push((options[i] as Modifier).id);
      }
    }
    setSelected(defaults);
  }

  const chosen = selected ?? [];

  // The item's own price, and the line's price once the chosen options
  // are applied — the same sum the server does in addLine, shown to the
  // cashier before they commit rather than only appearing on the bill.
  const base = item.priceMinor ?? paisa(0);
  const unitMinor = chosen.reduce<Paisa>((total, id) => {
    const modifier = allModifiers.find((m) => m.id === id);
    return modifier ? add(total, deltaFor(modifier)) : total;
  }, base);

  const toggle = (modifierId: number, group: ModifierGroup) => {
    setSelected((current) => {
      const list = current ?? [];
      const inGroup = list.filter((id) => allModifiers.find((m) => m.id === id)?.groupId === group.id);

      if (list.includes(modifierId)) {
        // Never let the cashier deselect their way below a group's
        // minimum — that is exactly the state the server rejects.
        if (inGroup.length <= group.minSelect) return list;
        return list.filter((id) => id !== modifierId);
      }
      if (inGroup.length >= group.maxSelect) {
        // At the group's maximum, a new pick REPLACES the old one, which
        // is what "choose one" means to anyone using it.
        return [...list.filter((id) => !inGroup.includes(id)), modifierId];
      }
      return [...list, modifierId];
    });
  };

  const unsatisfied = (groups.data ?? []).filter((group) => {
    const count = chosen.filter((id) => allModifiers.find((m) => m.id === id)?.groupId === group.id).length;
    return count < group.minSelect || count > group.maxSelect;
  });

  return (
    <Modal title={item.name} onClose={onClose}>
      <ErrorBanner error={addLine.error} />
      <div className="col">
        {groups.isLoading && <Loading />}

        {groups.data?.map((group) => {
          const options = optionsFor(group);
          const required = group.minSelect > 0;
          // A required, choose-one group is a size, so each option shows
          // the item's FINAL price at that size (Half Rs 1,100, Full
          // Rs 2,100) — the price that actually goes on the bill. An
          // optional group is an add-on, so it shows what it adds.
          const isSize = group.minSelect === 1 && group.maxSelect === 1;
          return (
            <div key={group.id}>
              <label>
                {group.name}{' '}
                <span className="muted">
                  {required ? 'required — ' : 'optional — '}
                  {group.minSelect === group.maxSelect ? `choose ${group.minSelect}` : `choose ${group.minSelect}–${group.maxSelect}`}
                </span>
              </label>
              <div className="tabs">
                {options.map((modifier) => (
                  <button key={modifier.id} className={chosen.includes(modifier.id) ? 'active' : ''} onClick={() => toggle(modifier.id, group)}>
                    {modifier.name}{' '}
                    {isSize ? (
                      <Money minor={add(base, deltaFor(modifier))} />
                    ) : (
                      deltaFor(modifier) !== 0 && (
                        <>
                          +<Money minor={deltaFor(modifier)} />
                        </>
                      )
                    )}
                  </button>
                ))}
                {options.length === 0 && <span className="muted">No options configured.</span>}
              </div>
            </div>
          );
        })}

        <div>
          <label>Quantity</label>
          <QtyInput value={qty} onCommit={setQty} />
        </div>

        {unsatisfied.length > 0 && (
          <p className="muted">
            Choose an option for {unsatisfied.map((group) => group.name).join(', ')} before adding this item.
          </p>
        )}

        {/* The price that will land on the bill, worked out for the
            cashier rather than left for them to add up. */}
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span className="muted">Line price</span>
          <strong>
            <Money minor={unitMinor} />
            {qty > 1 && (
              <>
                {' '}
                × {qty} = <Money minor={mulQty(unitMinor, qty)} />
              </>
            )}
          </strong>
        </div>

        <button
          className="primary big"
          disabled={addLine.isPending || unsatisfied.length > 0}
          onClick={() => addLine.mutate({ orderId, itemId: item.id, qty, modifierIds: chosen }, { onSuccess: onClose })}
        >
          Add to order
        </button>
      </div>
    </Modal>
  );
}

function RunningBill({ order, onBill }: { order: OrderDetail; onBill: () => void }): JSX.Element {
  const setLineQty = useSetLineQty();
  const removeLine = useRemoveLine();
  const voidLine = useVoidLine();
  const setLineNote = useSetLineNote();

  const [voiding, setVoiding] = useState<{ line: OrderLine; reason: string } | null>(null);
  const [needsApproval, setNeedsApproval] = useState<{ line: OrderLine; reason: string } | null>(null);
  const [noting, setNoting] = useState<{ line: OrderLine; note: string } | null>(null);

  const live = order.lines.filter((line) => !line.voided);
  // Once a bill has been printed, taking a line off it is a void, with a
  // manager and a reason — before that it is just a mis-tap (see
  // ordering's lineRemovalRequiresApproval).
  const printed = order.firstBilledAt !== null;

  // The line carries the name it was sold under; there is no reason to
  // ask the live menu what that item is called today.
  const itemName = (line: OrderLine) => line.itemName;

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
          // manager's credentials and retry this one call as them.
          if (error instanceof ApiError && error.isForbidden) {
            setVoiding(null);
            setNeedsApproval({ line, reason });
          }
        },
      },
    );
  };

  const forbidden = (error: unknown) => error instanceof ApiError && error.isForbidden;

  return (
    <div className="card col running-bill">
      <h2 style={{ margin: 0 }}>Running bill</h2>
      <ErrorBanner error={forbidden(voidLine.error) ? null : (setLineQty.error ?? removeLine.error ?? voidLine.error ?? setLineNote.error)} />

      {live.length === 0 && <p className="muted">No items yet. Click an item to add it.</p>}

      <div className="col bill-lines">
        {live.map((line) => (
          <div key={line.id} className="bill-line">
            <div className="bill-line-name">
              <div>{itemName(line)}</div>
              {line.modifiers.length > 0 && (
                <div className="muted bill-line-modifiers">{line.modifiers.map((modifier) => modifier.modifierName).join(', ')}</div>
              )}
              {line.note && <div className="muted bill-line-note">“{line.note}”</div>}
            </div>

            <QtyInput
              value={line.qty}
              disabled={setLineQty.isPending}
              label={`Quantity of ${itemName(line)}`}
              onCommit={(qty) => setLineQty.mutate({ orderId: order.id, lineId: line.id, qty })}
            />

            <span className="bill-line-money">
              <Money minor={line.grossMinor} />
            </span>

            {/* A kitchen instruction belongs to the line, so it is
                edited where the line is — not in a dialog attached to
                the order as a whole. */}
            <button
              className="ghost bill-line-note-button"
              title={line.note ? 'Change this line’s note' : 'Add a note for the kitchen'}
              disabled={printed || setLineNote.isPending}
              onClick={() => setNoting({ line, note: line.note ?? '' })}
            >
              {line.note ? 'Note ✎' : 'Note'}
            </button>

            <button
              className="ghost bill-line-remove"
              title={printed ? 'Void this line (needs a manager)' : 'Remove this line'}
              disabled={removeLine.isPending || voidLine.isPending}
              onClick={() => {
                if (printed) {
                  setVoiding({ line, reason: '' });
                  return;
                }
                removeLine.mutate({ orderId: order.id, lineId: line.id });
              }}
            >
              {printed ? 'Void' : 'Remove'}
            </button>
          </div>
        ))}
      </div>

      <div className="bill-totals">
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
            <p className="muted">
              This bill has already been printed, so removing {itemName(voiding.line)} is a void — it needs a manager and a reason,
              and stays on the record.
            </p>
            <div>
              <label htmlFor="void-reason">Reason</label>
              <input
                id="void-reason"
                autoFocus
                value={voiding.reason}
                onChange={(event) => setVoiding({ ...voiding, reason: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && voiding.reason.trim()) submitVoid(voiding.line, voiding.reason.trim());
                }}
              />
            </div>
            <button className="danger big" disabled={!voiding.reason.trim()} onClick={() => submitVoid(voiding.line, voiding.reason.trim())}>
              Void line
            </button>
          </div>
        </Modal>
      )}

      {noting && (
        <Modal title={`Note for ${itemName(noting.line)}`} onClose={() => setNoting(null)}>
          <div className="col">
            <p className="muted" style={{ margin: 0 }}>
              Goes to the kitchen and onto the printed bill. Clear it to remove it.
            </p>
            <input
              autoFocus
              maxLength={200}
              placeholder="no onions, well done…"
              value={noting.note}
              onChange={(event) => setNoting({ ...noting, note: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  setLineNote.mutate({ orderId: order.id, lineId: noting.line.id, note: noting.note }, { onSuccess: () => setNoting(null) });
                }
              }}
            />
            <button
              className="primary big"
              disabled={setLineNote.isPending}
              onClick={() => setLineNote.mutate({ orderId: order.id, lineId: noting.line.id, note: noting.note }, { onSuccess: () => setNoting(null) })}
            >
              Save note
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
