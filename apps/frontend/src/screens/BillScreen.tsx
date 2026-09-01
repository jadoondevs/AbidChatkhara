import { paisa, type Paisa } from '@pos/shared';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useBillOrder, useBillPreview, useOrder, usePrintBill, useServiceChargeSettings, useSetDiscount } from '../api/hooks.js';
import type { OrderDetail, ServiceChargeSettings } from '../api/types.js';
import { ErrorBanner, Loading, Money, MoneyInput } from '../components/ui.tsx';
import { orderTitle } from './OrderScreen.tsx';

/**
 * Screen 4: order-level discount with reason, the service charge, the
 * rounded total, and print. Printing the bill returns to the floor view
 * (spec) rather than parking the cashier on a payment screen — payment
 * is picked up later, by whoever is at the till then, from the
 * awaiting-payment list.
 *
 * The service charge is the restaurant's configured one, worked out by
 * the server; this screen shows what it will be and offers a waiver,
 * rather than asking a cashier to type the same percentage into every
 * bill and get one of them wrong.
 */
export function BillScreen(): JSX.Element {
  const { orderId: orderIdParam } = useParams();
  const orderId = Number(orderIdParam);
  const navigate = useNavigate();

  const order = useOrder(orderId);
  const setDiscount = useSetDiscount();
  const billOrder = useBillOrder();
  const printBill = usePrintBill();

  const [discountMinor, setDiscountMinor] = useState<Paisa>(paisa(0));
  const [discountReason, setDiscountReason] = useState('');
  // null means "whatever the restaurant charges" — the normal case, and
  // the only one that records the rate on the order. A number is a
  // deliberate override for this one bill.
  const [chargeOverride, setChargeOverride] = useState<Paisa | null>(null);
  const [printError, setPrintError] = useState<unknown>(null);

  if (order.isLoading) return <Loading />;
  if (order.error) return <ErrorBanner error={order.error} />;
  if (!order.data) return <p>Order not found.</p>;

  const detail = order.data;
  const alreadyBilled = detail.status === 'billed';
  const staffMeal = detail.channel !== 'customer';
  const noWaiter = detail.waiterId === null;
  // A service charge cannot be attributed without a waiter, and the
  // server refuses one — so the card explains itself rather than
  // offering a field that would be rejected.
  const serviceChargeAllowed = !noWaiter && !staffMeal;

  const applyDiscount = () => {
    setDiscount.mutate({ orderId, discountMinor, ...(discountReason.trim() ? { reason: discountReason.trim() } : {}) });
  };

  const printAndReturn = (id: number) => {
    printBill.mutate(id, {
      onSuccess: () => navigate('/'),
      // A dead printer must never block the flow: the bill is already
      // finalised server-side, so surface the failure and let the
      // cashier carry on (see ARCHITECTURE.md on PrintError -> 502).
      onError: (error) => setPrintError(error),
    });
  };

  const finaliseAndPrint = () => {
    if (alreadyBilled) {
      printAndReturn(orderId);
      return;
    }
    // Send the override only when there is one. Sending the previewed
    // amount back would turn the restaurant's rate into a number this
    // screen typed, and the order would no longer record which rate
    // produced it.
    billOrder.mutate(
      { orderId, ...(chargeOverride === null ? {} : { serviceChargeMinor: chargeOverride }) },
      { onSuccess: (billed) => printAndReturn(billed.id) },
    );
  };

  return (
    <div className="col" style={{ maxWidth: 760 }}>
      <h1 style={{ margin: 0 }}>
        Bill — {orderTitle(detail)} <span className="muted">#{detail.id}</span>
      </h1>

      <ErrorBanner error={setDiscount.error ?? billOrder.error ?? printError} />

      {!alreadyBilled && (
        <div className="card col">
          <h3 style={{ margin: 0 }}>Order discount</h3>
          {staffMeal ? (
            <p className="muted">
              A staff/owner meal is always billed at full menu price — what the person pays comes from their own meal policy at settlement.
            </p>
          ) : (
            <>
              <div className="row">
                <div style={{ flex: 1 }}>
                  <label htmlFor="discount">Amount</label>
                  <MoneyInput id="discount" valueMinor={discountMinor} onChange={setDiscountMinor} />
                </div>
                <div style={{ flex: 2 }}>
                  <label htmlFor="discount-reason">Reason (required for a non-zero discount)</label>
                  <input id="discount-reason" value={discountReason} onChange={(event) => setDiscountReason(event.target.value)} />
                </div>
              </div>
              <button disabled={setDiscount.isPending || (discountMinor > 0 && !discountReason.trim())} onClick={applyDiscount}>
                Apply discount
              </button>
            </>
          )}
        </div>
      )}

      {!alreadyBilled && (
        <ServiceChargeCard
          allowed={serviceChargeAllowed}
          staffMeal={staffMeal}
          override={chargeOverride}
          onOverride={setChargeOverride}
        />
      )}

      <BillTotalsCard order={detail} chargeOverride={serviceChargeAllowed ? chargeOverride : paisa(0)} alreadyBilled={alreadyBilled} />

      <div className="row">
        <button className="ghost big" onClick={() => navigate(`/orders/${orderId}`)}>
          Back to order
        </button>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="primary big" disabled={billOrder.isPending || printBill.isPending} onClick={finaliseAndPrint}>
          {alreadyBilled ? 'Reprint bill' : 'Print bill'}
        </button>
      </div>

      {printError !== null && (
        <div className="card">
          <p>
            The bill is finalised — only the printer failed. Fix the printer and reprint, or carry on: payment can still be taken from the
            awaiting-payment list.
          </p>
          <button onClick={() => navigate('/')}>Back to floor</button>
        </div>
      )}
    </div>
  );
}

/**
 * What the service charge will be, and the one way to change it.
 *
 * The amount itself is not shown here — it is on the totals card
 * below, computed by the server — because two places showing "the
 * service charge" is exactly how they come to disagree. This card says
 * which rule is being applied and lets the cashier waive or adjust it
 * for this bill, which is recorded as an override rather than as a
 * rate (docs/decisions: an overridden charge names no percentage,
 * because no percentage produced it).
 */
function ServiceChargeCard({
  allowed,
  staffMeal,
  override,
  onOverride,
}: {
  allowed: boolean;
  staffMeal: boolean;
  override: Paisa | null;
  onOverride: (value: Paisa | null) => void;
}): JSX.Element {
  const config = useServiceChargeSettings();
  const [editing, setEditing] = useState(false);

  return (
    <div className="card col">
      <div className="row">
        <h3 style={{ margin: 0, flex: 1 }}>{config.data?.displayName ?? 'Service charge'}</h3>
        {override !== null && <span className="pill warn">Overridden</span>}
      </div>

      {!allowed ? (
        <p className="muted">
          {staffMeal
            ? 'A staff or owner meal carries no service charge.'
            : "This order has no waiter, so a service charge can't be attributed — it stays zero."}
        </p>
      ) : (
        <ServiceChargeControls config={config.data} override={override} onOverride={onOverride} editing={editing} setEditing={setEditing} />
      )}
    </div>
  );
}

function ServiceChargeControls({
  config,
  override,
  onOverride,
  editing,
  setEditing,
}: {
  config: ServiceChargeSettings | undefined;
  override: Paisa | null;
  onOverride: (value: Paisa | null) => void;
  editing: boolean;
  setEditing: (value: boolean) => void;
}): JSX.Element {
  if (!config) return <p className="muted">Loading…</p>;

  // Switched off restaurant-wide: there is nothing to waive, and the
  // server refuses a non-zero override, so the card explains where the
  // setting lives instead of offering a field that cannot be used.
  if (!config.enabled) {
    return <p className="muted">Switched off for this restaurant. An admin can turn it on under Settings → Service charge.</p>;
  }

  return (
    <>
      <p className="muted" style={{ margin: 0 }}>
        {config.rateBp / 100}% of net sales
        {config.dineInOnly ? ', dine-in only' : ''} — held for the waiter, never revenue.
      </p>

      {editing || override !== null ? (
        <div style={{ maxWidth: 240 }}>
          <label htmlFor="service-charge">Charge for this bill</label>
          <MoneyInput id="service-charge" valueMinor={override ?? paisa(0)} onChange={(value) => onOverride(value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <button
              onClick={() => {
                onOverride(null);
                setEditing(false);
              }}
            >
              Use the standard charge
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button onClick={() => onOverride(paisa(0))}>Waive on this bill</button>
          <button onClick={() => setEditing(true)}>Change the amount</button>
        </div>
      )}
    </>
  );
}

/**
 * The bill's figures, including the rounding adjustment and the actual
 * total — before anything is printed.
 *
 * The total is fetched from the server's own bill-preview endpoint,
 * which runs the same code the bill itself will run. It used to read
 * "Total (rounded on print) —" with no amount, because rounding was
 * only applied when the bill was finalised and the screen had no way to
 * predict it. Recomputing it here in the browser would have been a
 * second implementation of the money pipeline, free to disagree with
 * the first; asking the server is the only version that cannot.
 */
function BillTotalsCard({
  order,
  chargeOverride,
  alreadyBilled,
}: {
  order: OrderDetail;
  chargeOverride: Paisa | null;
  alreadyBilled: boolean;
}): JSX.Element {
  const preview = useBillPreview(alreadyBilled ? null : order.id, chargeOverride ?? undefined);

  // Once billed, the stored figures ARE the answer — no prediction
  // needed, and none should be shown in their place.
  const totals = alreadyBilled
    ? {
        subtotalMinor: order.subtotalMinor,
        orderDiscountMinor: order.orderDiscountMinor,
        netSalesMinor: order.netSalesMinor,
        taxMinor: order.taxMinor,
        serviceChargeMinor: order.serviceChargeMinor,
        serviceChargeRateBp: order.serviceChargeRateBp,
        serviceChargeName: 'Service charge',
        roundingAdjustmentMinor: order.roundingAdjustmentMinor,
        totalMinor: order.totalMinor,
      }
    : preview.data;

  return (
    <div className="card">
      <ErrorBanner error={preview.error} />
      <div className="total-line">
        <span>Subtotal</span>
        <Money minor={totals?.subtotalMinor} />
      </div>
      <div className="total-line">
        <span>Discount</span>
        <Money minor={totals?.orderDiscountMinor} />
      </div>
      <div className="total-line">
        <span>Net sales</span>
        <Money minor={totals?.netSalesMinor} />
      </div>
      <div className="total-line">
        <span>Tax</span>
        <Money minor={totals?.taxMinor} />
      </div>
      <div className="total-line">
        {/* Named and rated as the customer will read it on the printed
            bill, so what is on screen and what is on paper are the same
            line. */}
        <span>
          {totals?.serviceChargeName ?? 'Service charge'}
          {totals?.serviceChargeRateBp ? ` (${totals.serviceChargeRateBp / 100}%)` : ''}
        </span>
        <Money minor={totals?.serviceChargeMinor} />
      </div>
      <div className="total-line">
        <span>Rounding</span>
        <Money minor={totals?.roundingAdjustmentMinor} />
      </div>
      <div className="total-line grand">
        <span>Total</span>
        <Money minor={totals?.totalMinor} />
      </div>
      {!alreadyBilled && <p className="muted field-hint">This is the amount that will be printed.</p>}
    </div>
  );
}
