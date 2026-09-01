import { format } from '@pos/shared';
import { useNavigate, useParams } from 'react-router-dom';
import { useOrderHistory, usePrintReceipt } from '../api/hooks.js';
import type { HistoricalPayment, OrderHistory } from '../api/types.js';
import { ErrorBanner, Loading, Money } from '../components/ui.tsx';
import { orderTitle } from './OrderScreen.tsx';

/**
 * The complete record of a past order.
 *
 * This is what clicking a completed order on the floor opens. It used
 * to land on the payment screen's "Paid in full" card, which told a
 * cashier the invoice number and nothing else — so anyone asking "what
 * was on table 4 an hour ago, and how did they pay?" had to find the
 * paper receipt.
 *
 * Every figure here was recorded at the time of the sale. Item names
 * and prices come from the order line's own snapshot, the service
 * charge from the rate stored on the order, the account from the
 * payment row — so this page does not change when the menu, the
 * settings or the account list do. It is also strictly read-only:
 * opening an order must never modify it.
 */
export function OrderDetailScreen(): JSX.Element {
  const { orderId: orderIdParam } = useParams();
  const orderId = Number(orderIdParam);
  const navigate = useNavigate();
  const history = useOrderHistory(orderId);
  const printReceipt = usePrintReceipt();

  if (history.isLoading) return <Loading />;
  if (history.error) return <ErrorBanner error={history.error} />;
  if (!history.data) return <p>Order not found.</p>;

  const record = history.data;
  const { order } = record;
  const settled = order.status === 'closed';

  return (
    <div className="col order-detail">
      <div className="row">
        <h1 style={{ margin: 0, flex: 1 }}>
          {orderTitle(order)} <span className="muted">#{order.id}</span>
        </h1>
        <StatusPill history={record} />
      </div>

      <div className="detail-grid">
        <section className="card col">
          <h3>Order</h3>
          <Field label="Order number" value={`#${order.id}`} />
          {order.invoiceNo !== null && <Field label="Invoice number" value={`#${order.invoiceNo}`} />}
          <Field label="Type" value={order.orderType.replace(/_/g, ' ')} />
          <Field label="Table" value={order.tableLabel ?? '—'} />
          {order.customerName && <Field label="Customer" value={order.customerName} />}
          {order.customerPhone && <Field label="Phone" value={order.customerPhone} />}
          {record.beneficiaryName && <Field label="Meal for" value={record.beneficiaryName} />}
          <Field label="Waiter" value={record.waiterName ?? '—'} />
          <Field label="Opened by" value={record.openedByName ?? '—'} />
          {settled && <Field label="Settled by" value={record.closedByName ?? '—'} />}
          <Field label="Opened" value={formatWhen(order.openedAt)} />
          <Field label="Billed" value={formatWhen(order.billedAt)} />
          <Field label="Paid" value={formatWhen(order.closedAt)} />
        </section>

        <section className="card col">
          <h3>Totals</h3>
          <div className="total-line">
            <span>Subtotal</span>
            <Money minor={order.subtotalMinor} />
          </div>
          {order.orderDiscountMinor > 0 && (
            <div className="total-line">
              <span>Discount{order.discountReason ? ` (${order.discountReason})` : ''}</span>
              <Money minor={order.orderDiscountMinor} />
            </div>
          )}
          <div className="total-line">
            <span>Net sales</span>
            <Money minor={order.netSalesMinor} />
          </div>
          <div className="total-line">
            <span>Tax</span>
            <Money minor={order.taxMinor} />
          </div>
          <div className="total-line">
            {/* The rate is the one that applied to THIS order, not
                whatever is configured today. */}
            <span>Service charge{order.serviceChargeRateBp !== null ? ` (${order.serviceChargeRateBp / 100}%)` : ''}</span>
            <Money minor={order.serviceChargeMinor} />
          </div>
          {order.roundingAdjustmentMinor !== 0 && (
            <div className="total-line">
              <span>Rounding</span>
              <Money minor={order.roundingAdjustmentMinor} />
            </div>
          )}
          <div className="total-line grand">
            <span>Total</span>
            <Money minor={order.totalMinor} />
          </div>
          <div className="total-line">
            <span>Paid</span>
            <Money minor={record.paidMinor} />
          </div>
          {record.balanceMinor !== 0 && (
            <div className="total-line grand">
              <span>{record.balanceMinor > 0 ? 'Still due' : 'Refunded'}</span>
              <Money minor={record.balanceMinor} />
            </div>
          )}
          {record.changeGivenMinor > 0 && (
            <div className="total-line">
              <span>Change given</span>
              <Money minor={record.changeGivenMinor} />
            </div>
          )}
        </section>
      </div>

      <section className="card">
        <h3>Items</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Qty</th>
                <th className="num">Unit price</th>
                <th className="num">Line total</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.id} className={line.voided ? 'muted' : ''}>
                  <td>
                    {line.itemName}
                    {line.modifiers.length > 0 && (
                      <div className="muted line-modifiers">
                        {/* One formatter for money, here as everywhere:
                            dividing by 100 in a template would be a
                            second, quieter implementation of it. */}
                        {line.modifiers
                          .map((modifier) => `${modifier.modifierName}${modifier.priceDeltaMinor !== 0 ? ` (+${format(modifier.priceDeltaMinor)})` : ''}`)
                          .join(', ')}
                      </div>
                    )}
                    {line.note && <div className="muted line-modifiers">“{line.note}”</div>}
                    {line.voided && (
                      <div className="muted line-modifiers">
                        {line.voidKind === 'correction' ? 'Removed before billing' : `Voided${line.voidReason ? ` — ${line.voidReason}` : ''}`}
                      </div>
                    )}
                  </td>
                  <td className="num">{line.qty}</td>
                  <td className="num">
                    <Money minor={line.unitPriceMinor} />
                  </td>
                  <td className="num">{line.voided ? <span className="muted">—</span> : <Money minor={line.grossMinor} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h3>Payments</h3>
        {record.payments.length === 0 && <p className="muted">Nothing has been paid yet.</p>}
        <div className="col" style={{ gap: 10 }}>
          {record.payments.map((payment) => (
            <PaymentCard key={payment.id} payment={payment} />
          ))}
        </div>
      </section>

      {record.partnerAllocations.length > 0 && (
        <section className="card">
          <h3>Partner allocation</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            At the shares that were in force when this order closed.
          </p>
          <table>
            <tbody>
              {record.partnerAllocations.map((allocation) => (
                <tr key={allocation.partnerId}>
                  <td>{allocation.partnerName}</td>
                  <td className="muted">{allocation.shareBpSnapshot / 100}%</td>
                  <td className="num">
                    <Money minor={allocation.amountMinor} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <ErrorBanner error={printReceipt.error} />
      <div className="row">
        <button className="ghost big" onClick={() => navigate('/')}>
          Back to floor
        </button>
        <span style={{ flex: 1 }} />
        {record.balanceMinor > 0 && (
          <button className="primary big" onClick={() => navigate(`/orders/${order.id}/payment`)}>
            Take payment
          </button>
        )}
        {settled && (
          <button className="primary big" disabled={printReceipt.isPending} onClick={() => printReceipt.mutate(order.id)}>
            {printReceipt.isPending ? 'Printing…' : 'Reprint receipt'}
          </button>
        )}
      </div>
    </div>
  );
}

function StatusPill({ history }: { history: OrderHistory }): JSX.Element {
  const { order, balanceMinor } = history;
  if (order.status === 'closed') return <span className="pill ok">Paid in full</span>;
  if (order.status === 'voided') return <span className="pill warn">Voided</span>;
  if (order.status === 'billed') {
    return <span className="pill part-paid">{balanceMinor < order.totalMinor ? 'Part paid' : 'Awaiting payment'}</span>;
  }
  return <span className="pill">Open</span>;
}

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="detail-field">
      <span className="muted">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function formatWhen(iso: string | null): string {
  return iso === null ? '—' : new Date(iso).toLocaleString();
}

/**
 * One payment, with everything needed to trace it: which account it
 * landed in, its reference, and — for cash — what was handed over and
 * handed back.
 */
function PaymentCard({ payment }: { payment: HistoricalPayment }): JSX.Element {
  return (
    <div className={`payment-card${payment.isRefund ? ' refund' : ''}`}>
      <div className="row">
        <strong style={{ flex: 1 }}>
          {payment.isRefund ? `${payment.methodName} refund` : payment.methodName}
        </strong>
        <Money minor={payment.amountMinor} />
      </div>
      <div className="payment-card-details muted">
        {payment.accountLabel && (
          <div>
            Account: {payment.accountLabel}
            {payment.accountBankName ? ` · ${payment.accountBankName}` : ''}
            {payment.accountNumber ? ` · ${payment.accountNumber}` : ''}
          </div>
        )}
        {payment.referenceNo && <div>Reference: {payment.referenceNo}</div>}
        {payment.tenderedMinor !== null && (
          <div>
            Received: <Money minor={payment.tenderedMinor} />
            {payment.changeMinor !== null && (
              <>
                {' · Change: '}
                <Money minor={payment.changeMinor} />
              </>
            )}
          </div>
        )}
        <div>
          {formatWhen(payment.receivedAt)}
          {payment.receivedByName ? ` · ${payment.receivedByName}` : ''}
        </div>
      </div>
    </div>
  );
}
