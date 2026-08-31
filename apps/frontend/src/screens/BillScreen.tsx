import { paisa, type Paisa } from '@pos/shared';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useBillOrder, useBillPreview, useOrder, usePrintBill, useSetDiscount } from '../api/hooks.js';
import type { OrderDetail } from '../api/types.js';
import { ErrorBanner, Loading, Money, MoneyInput } from '../components/ui.tsx';
import { orderTitle } from './OrderScreen.tsx';

/**
 * Screen 4: order-level discount with reason, service charge entry, the
 * rounded total, and print. Printing the bill returns to the floor view
 * (spec) rather than parking the cashier on a payment screen — payment
 * is picked up later, by whoever is at the till then, from the
 * awaiting-payment list.
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
  const [serviceChargeMinor, setServiceChargeMinor] = useState<Paisa>(paisa(0));
  const [printError, setPrintError] = useState<unknown>(null);

  if (order.isLoading) return <Loading />;
  if (order.error) return <ErrorBanner error={order.error} />;
  if (!order.data) return <p>Order not found.</p>;

  const detail = order.data;
  const alreadyBilled = detail.status === 'billed';
  const staffMeal = detail.channel !== 'customer';
  const noWaiter = detail.waiterId === null;
  // A service charge cannot be attributed without a waiter, and the
  // server refuses one — so the field is disabled rather than offered
  // and then rejected.
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
    billOrder.mutate(
      { orderId, ...(serviceChargeMinor > 0 ? { serviceChargeMinor } : {}) },
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
        <div className="card col">
          <h3 style={{ margin: 0 }}>Service charge</h3>
          {!serviceChargeAllowed ? (
            <p className="muted">
              {staffMeal
                ? 'A staff or owner meal carries no service charge.'
                : "This order has no waiter, so a service charge can't be attributed — it must stay zero."}
            </p>
          ) : (
            <div style={{ maxWidth: 240 }}>
              <label htmlFor="service-charge">Amount (optional)</label>
              <MoneyInput id="service-charge" valueMinor={serviceChargeMinor} onChange={setServiceChargeMinor} />
              <p className="muted" style={{ fontSize: 13 }}>
                Held for the waiter, never revenue.
              </p>
            </div>
          )}
        </div>
      )}

      <BillTotalsCard order={detail} serviceChargeMinor={serviceChargeAllowed ? serviceChargeMinor : paisa(0)} alreadyBilled={alreadyBilled} />

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
  serviceChargeMinor,
  alreadyBilled,
}: {
  order: OrderDetail;
  serviceChargeMinor: Paisa;
  alreadyBilled: boolean;
}): JSX.Element {
  const preview = useBillPreview(alreadyBilled ? null : order.id, serviceChargeMinor);

  // Once billed, the stored figures ARE the answer — no prediction
  // needed, and none should be shown in their place.
  const totals = alreadyBilled
    ? {
        subtotalMinor: order.subtotalMinor,
        orderDiscountMinor: order.orderDiscountMinor,
        netSalesMinor: order.netSalesMinor,
        taxMinor: order.taxMinor,
        serviceChargeMinor: order.serviceChargeMinor,
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
        <span>Service charge</span>
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
