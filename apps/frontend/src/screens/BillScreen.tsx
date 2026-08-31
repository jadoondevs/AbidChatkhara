import { paisa, type Paisa } from '@pos/shared';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useBillOrder, useOrder, usePrintBill, useSetDiscount } from '../api/hooks.js';
import { ErrorBanner, Loading, Money, MoneyInput } from '../components/ui.tsx';

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
        Bill — {detail.tableLabel ?? detail.orderType.replace('_', ' ')} <span className="muted">#{detail.id}</span>
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
          {noWaiter ? (
            <p className="muted">This order has no waiter, so a service charge can't be attributed — it must stay zero.</p>
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

      <div className="card">
        <div className="total-line">
          <span>Subtotal</span>
          <Money minor={detail.subtotalMinor} />
        </div>
        <div className="total-line">
          <span>Discount</span>
          <Money minor={detail.orderDiscountMinor} />
        </div>
        <div className="total-line">
          <span>Net sales</span>
          <Money minor={detail.netSalesMinor} />
        </div>
        <div className="total-line">
          <span>Tax</span>
          <Money minor={detail.taxMinor} />
        </div>
        <div className="total-line">
          <span>Service charge {alreadyBilled ? '' : '(on print)'}</span>
          <Money minor={alreadyBilled ? detail.serviceChargeMinor : serviceChargeMinor} />
        </div>
        {alreadyBilled && (
          <div className="total-line">
            <span>Rounding</span>
            <Money minor={detail.roundingAdjustmentMinor} />
          </div>
        )}
        <div className="total-line grand">
          <span>Total{alreadyBilled ? '' : ' (rounded on print)'}</span>
          <Money minor={alreadyBilled ? detail.totalMinor : null} />
        </div>
      </div>

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
