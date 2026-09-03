import { paisa, type Paisa } from '@pos/shared';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  useAgentStatus,
  useBillOrder,
  useBillPreview,
  useOrder,
  usePrintBill,
  useServiceChargeSettings,
  useSetDiscount,
  useVoidOrder,
} from '../api/hooks.js';
import type { OrderDetail, ServiceChargeSettings } from '../api/types.js';
import { PrintDecision } from '../components/PrintDecision.tsx';
import { ErrorBanner, Loading, Money, MoneyInput, PrinterStatus } from '../components/ui.tsx';
import { orderTitle } from './OrderScreen.tsx';

/**
 * The bill: order-level discount with reason, the service charge, the
 * rounded total, and print.
 *
 * This is a PANEL, not a screen. The cashier meets it as a dialog over
 * the order they are taking (OrderScreen), because "review the bill" is
 * a step in taking an order, not a different place to be — leaving the
 * order screen to look at its own total was a page change that bought
 * nothing. `/orders/:id/bill` still renders the same panel as a page,
 * so a bookmarked or reloaded URL keeps working.
 *
 * Printing hands straight over to payment for THIS order (see
 * `onPrinted`): the cashier who just printed a bill is the person about
 * to take the money for it, and sending them back to the floor to find
 * the order again was the longest detour in the workflow.
 */
export function BillPanel({
  orderId,
  onBackToOrder,
  onPrinted,
  onCancelled,
}: {
  orderId: number;
  onBackToOrder: () => void;
  /** Called once the bill is finalised and the cashier is done with the
   * printer, successfully or not. */
  onPrinted: (orderId: number) => void;
  /** Called when the sale was cancelled outright from the print
   * decision. */
  onCancelled: () => void;
}): JSX.Element {
  const order = useOrder(orderId);
  const setDiscount = useSetDiscount();
  const billOrder = useBillOrder();
  const printBill = usePrintBill();
  const voidOrder = useVoidOrder();
  const printer = useAgentStatus();

  const [discountMinor, setDiscountMinor] = useState<Paisa>(paisa(0));
  const [discountReason, setDiscountReason] = useState('');
  // null means "whatever the restaurant charges" — the normal case, and
  // the only one that records the rate on the order. A number is what
  // the cashier decided this one bill carries.
  const [chargeOverride, setChargeOverride] = useState<Paisa | null>(null);
  const [printError, setPrintError] = useState<unknown>(null);
  // Set when a print did NOT happen: the agent didn't answer, or the
  // printer refused the ticket. The bill is finalised either way, so the
  // cashier is asked what to do — retry, carry on, or cancel — never
  // told the sale failed, and never silently sent to blank Windows paper.
  const [printFailedFor, setPrintFailedFor] = useState<number | null>(null);

  if (order.isLoading) return <Loading />;
  if (order.error) return <ErrorBanner error={order.error} />;
  if (!order.data) return <p>Order not found.</p>;

  const detail = order.data;
  const alreadyBilled = detail.status === 'billed';
  const staffMeal = detail.channel !== 'customer';
  const noWaiter = detail.waiterId === null;
  // A service charge is paid out to a waiter, so an order with none has
  // nobody to attribute it to and the server refuses one — the card
  // says so rather than offering a field that would be rejected.
  const serviceChargeAllowed = !noWaiter && !staffMeal;

  const applyDiscount = () => {
    setDiscount.mutate({ orderId, discountMinor, ...(discountReason.trim() ? { reason: discountReason.trim() } : {}) });
  };

  const print = (id: number) => {
    setPrintError(null);
    printBill.mutate(id, {
      // The agent printed it. Nothing to ask — the cashier goes straight
      // on to taking the money.
      onSuccess: () => {
        setPrintFailedFor(null);
        onPrinted(id);
      },
      // A dead printer must never block the flow: the bill is already
      // finalised server-side (see docs/decisions/018), so the cashier
      // is asked what they want to do, not told the sale failed — and it
      // is never sent to the Windows dialog, which prints blank paper.
      onError: (error) => {
        setPrintError(error);
        setPrintFailedFor(id);
      },
    });
  };

  const finaliseAndPrint = () => {
    if (alreadyBilled) {
      print(orderId);
      return;
    }
    // Send the charge only when the cashier set one. Sending the
    // previewed amount back would turn the restaurant's own rate into a
    // number this screen typed, and the order would no longer record
    // which rate produced it.
    billOrder.mutate(
      { orderId, ...(chargeOverride === null ? {} : { serviceChargeMinor: chargeOverride }) },
      { onSuccess: (billed) => print(billed.id) },
    );
  };

  return (
    <div className="col bill-panel">
      <h2 style={{ margin: 0 }}>
        Bill — {orderTitle(detail)} <span className="muted">#{detail.id}</span>
      </h2>
      <p className="muted" style={{ margin: 0 }}>
        {detail.orderType.replace(/_/g, ' ')}
        {detail.tableLabel ? ` · table ${detail.tableLabel}` : ''}
        {detail.customerName ? ` · ${detail.customerName}` : ''}
        {detail.invoiceNo !== null ? ` · invoice #${detail.invoiceNo}` : ''}
      </p>

      <ErrorBanner error={setDiscount.error ?? billOrder.error ?? voidOrder.error ?? printError} />

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
          orderId={orderId}
          allowed={serviceChargeAllowed}
          staffMeal={staffMeal}
          amount={chargeOverride}
          onAmount={setChargeOverride}
        />
      )}

      <BillTotalsCard order={detail} chargeOverride={serviceChargeAllowed ? chargeOverride : paisa(0)} alreadyBilled={alreadyBilled} />

      <div className="row" style={{ alignItems: 'center' }}>
        <button className="ghost big" onClick={onBackToOrder}>
          Back to order
        </button>
        <span className="spacer" style={{ flex: 1 }} />
        <PrinterStatus connected={printer.data === true} checking={printer.isLoading} />
        <button className="primary big" disabled={billOrder.isPending || printBill.isPending} onClick={finaliseAndPrint}>
          {billOrder.isPending || printBill.isPending ? 'Printing…' : alreadyBilled ? 'Reprint bill' : 'Print bill'}
        </button>
      </div>

      {printFailedFor !== null && (
        <PrintDecision
          title="The bill didn't print"
          detail={
            printer.data === false
              ? 'The receipt printer isn’t connected. Check it is on and plugged in, then retry — the bill is finalised, so you can also take payment and reprint after.'
              : 'The printer didn’t accept the bill, so nothing came out. The bill is finalised — retry, or take payment and reprint after.'
          }
          continueLabel="Take payment anyway"
          cancelLabel="Cancel sale"
          busy={printBill.isPending || voidOrder.isPending}
          onContinue={() => {
            setPrintFailedFor(null);
            onPrinted(printFailedFor);
          }}
          onRetry={() => print(printFailedFor)}
          onCancelSale={() =>
            // Nothing has been paid at this point, so cancelling is the
            // system's ordinary void: the order stays on the record as
            // voided rather than disappearing.
            voidOrder.mutate(
              { orderId: printFailedFor, reason: 'cancelled at the bill, not printed' },
              {
                onSuccess: () => {
                  setPrintFailedFor(null);
                  onCancelled();
                },
              },
            )
          }
        />
      )}
    </div>
  );
}

/**
 * `/orders/:id/bill` as a page. The normal workflow opens the same
 * panel as a dialog over the order screen; this exists so a reload, a
 * bookmark or a direct link still lands somewhere sensible.
 */
export function BillScreen(): JSX.Element {
  const { orderId: orderIdParam } = useParams();
  const orderId = Number(orderIdParam);
  const navigate = useNavigate();

  return (
    <div style={{ maxWidth: 760 }}>
      <BillPanel
        orderId={orderId}
        onBackToOrder={() => navigate(`/orders/${orderId}`)}
        onPrinted={(id) => navigate(`/orders/${id}/payment`)}
        onCancelled={() => navigate('/')}
      />
    </div>
  );
}

/**
 * The service charge on this bill, in rupees.
 *
 * The cashier types an amount, not a percentage: "add 200 for the
 * staff" is what a customer says, and asking a busy till to work out 5%
 * of 4,150 is how a bill gets the wrong number on it. The restaurant's
 * configured rate does that arithmetic instead — the field is seeded
 * with what the rate produces, and the cashier is free to change it,
 * zero it, or leave it alone.
 *
 * Leaving it alone is not the same as typing the same number: an
 * untouched charge records the rate that produced it on the order, and
 * a typed one records no rate, because no rate produced it
 * (docs/decisions/019).
 */
function ServiceChargeCard({
  orderId,
  allowed,
  staffMeal,
  amount,
  onAmount,
}: {
  orderId: number;
  allowed: boolean;
  staffMeal: boolean;
  amount: Paisa | null;
  onAmount: (value: Paisa | null) => void;
}): JSX.Element {
  const config = useServiceChargeSettings();
  // What the configured rule would charge, straight from the server's
  // own calculation — the seed for the field below, and never a second
  // implementation of the rate.
  const suggested = useBillPreview(orderId).data?.serviceChargeMinor ?? paisa(0);

  return (
    <div className="card col">
      <div className="row">
        <h3 style={{ margin: 0, flex: 1 }}>{config.data?.displayName ?? 'Service charge'}</h3>
        {amount !== null && <span className="pill warn">Set by hand</span>}
      </div>

      {!allowed ? (
        <p className="muted">
          {staffMeal
            ? 'A staff or owner meal carries no service charge.'
            : "This order has no waiter, so a service charge can't be attributed — it stays zero."}
        </p>
      ) : (
        <ServiceChargeAmount config={config.data} amount={amount} suggested={suggested} onAmount={onAmount} />
      )}
    </div>
  );
}

function ServiceChargeAmount({
  config,
  amount,
  suggested,
  onAmount,
}: {
  config: ServiceChargeSettings | undefined;
  amount: Paisa | null;
  suggested: Paisa;
  onAmount: (value: Paisa | null) => void;
}): JSX.Element {
  const configured = config?.enabled === true && config.rateBp > 0;

  return (
    <>
      <div style={{ maxWidth: 240 }}>
        <label htmlFor="service-charge">Amount (optional)</label>
        <MoneyInput id="service-charge" valueMinor={amount ?? suggested} onChange={(value) => onAmount(value)} />
      </div>

      <p className="muted field-hint" style={{ margin: 0 }}>
        {configured
          ? `${(config?.rateBp ?? 0) / 100}% of net sales${config?.dineInOnly ? ', dine-in only' : ''} — held for the waiter, never revenue. Change it or set it to zero on any bill.`
          : 'Optional on every bill — held for the waiter, never revenue. Leave it at zero to charge none. An admin can set a standard rate under Settings → Service charge.'}
      </p>

      <div className="row">
        <button disabled={amount === null && suggested === 0} onClick={() => onAmount(paisa(0))}>
          No service charge
        </button>
        {configured && (
          <button disabled={amount === null} onClick={() => onAmount(null)}>
            Use the standard {(config?.rateBp ?? 0) / 100}%
          </button>
        )}
      </div>
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
      {/* Net sales is what the restaurant earned; the total is what the
          customer hands over. The service charge is the difference that
          belongs to neither — see docs/decisions/008. */}
      {!alreadyBilled && <p className="muted field-hint">This is the amount that will be printed.</p>}
    </div>
  );
}
