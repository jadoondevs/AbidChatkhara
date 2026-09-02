import { abs, paisa, type Paisa } from '@pos/shared';
import { useState } from 'react';
import { ApiError } from '../api/client.js';
import {
  useBlockingOrders,
  useCloseShiftMutation,
  useDeleteEmptyOrder,
  useOpenShift,
  useOpenShiftMutation,
  usePayoutSheet,
  useZReport,
} from '../api/hooks.js';
import type { ZReport } from '../api/types.js';
import { ErrorBanner, Loading, Money, MoneyInput } from '../components/ui.tsx';

/**
 * Screen 12: opening float, closing count, variance, Z-report and the
 * service charge payout sheet. Closing is refused while any order is
 * still open or awaiting payment — the server returns the blocking
 * orders themselves, and this screen lists them rather than just saying
 * no (spec).
 */
export function ShiftScreen(): JSX.Element {
  const openShift = useOpenShift();
  const openShiftMutation = useOpenShiftMutation();
  const closeShift = useCloseShiftMutation();

  const [openingCashMinor, setOpeningCashMinor] = useState<Paisa>(paisa(0));
  const [countedCashMinor, setCountedCashMinor] = useState<Paisa>(paisa(0));
  const deleteOrder = useDeleteEmptyOrder();

  const shift = openShift.data;
  const zReport = useZReport(shift?.id ?? null);
  const payout = usePayoutSheet(shift?.id ?? null);
  // Live server state, not a copy of a failed close: clearing a blocker
  // anywhere — here, or on the floor — updates this list and with it
  // whether the shift can close.
  const blocking = useBlockingOrders(shift?.id ?? null);

  if (openShift.isLoading) return <Loading />;

  // Closing a shift makes `openShift` null, which used to drop the
  // manager straight back to "no shift is open" — the counted cash, the
  // expected cash and the variance they had just produced gone from the
  // screen before they could read them. The mutation's own result is
  // the closed shift, so it stays up until they are done with it.
  const justClosed = closeShift.data;
  if (!shift && justClosed) {
    return (
      <div className="col" style={{ maxWidth: 520 }}>
        <div>
          <p className="page-kicker">Cash management</p>
          <h1 style={{ margin: 0 }}>Shift #{justClosed.id} closed</h1>
        </div>
        <div className="card col">
          <h3 style={{ margin: 0 }}>Cash reconciliation</h3>
          <div className="total-line">
            <span>Expected in the drawer</span>
            <Money minor={justClosed.expectedCashMinor} />
          </div>
          <div className="total-line">
            <span>Counted</span>
            <Money minor={justClosed.countedCashMinor} />
          </div>
          <div className="total-line grand" style={{ color: justClosed.varianceMinor === 0 ? 'var(--success)' : 'var(--warn)' }}>
            <span>{justClosed.varianceMinor === 0 ? 'Variance — none' : 'Variance'}</span>
            <Money minor={justClosed.varianceMinor} />
          </div>
          <button className="primary big" onClick={() => closeShift.reset()}>
            Done
          </button>
        </div>
      </div>
    );
  }

  if (!shift) {
    return (
      <div className="col" style={{ maxWidth: 520 }}>
        <div>
          <p className="page-kicker">Cash management</p>
          <h1 style={{ margin: 0 }}>Shift</h1>
        </div>
        <ErrorBanner error={openShiftMutation.error} />
        <div className="card col">
          <h3 style={{ margin: 0 }}>No shift is open</h3>
          <div>
            <label htmlFor="opening-float">Opening float</label>
            <MoneyInput id="opening-float" valueMinor={openingCashMinor} onChange={setOpeningCashMinor} />
          </div>
          <button className="primary big" disabled={openShiftMutation.isPending} onClick={() => openShiftMutation.mutate({ openingCashMinor })}>
            Open shift
          </button>
        </div>
      </div>
    );
  }

  const closed = shift.closedAt !== null;
  const blockers = blocking.data ?? [];

  return (
    <div className="col" style={{ maxWidth: 1100 }}>
      <div>
        <p className="page-kicker">Cash management</p>
        <h1 style={{ margin: 0 }}>Shift #{shift.id}</h1>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Opened {new Date(shift.openedAt).toLocaleString()} · float <Money minor={shift.openingCashMinor} />
      </p>

      <ErrorBanner error={closeShift.error instanceof ApiError && closeShift.error.isDomainError ? null : closeShift.error} />

      {blockers.length > 0 && (
        <div className="card blocking-orders">
          <h3 style={{ margin: 0, color: 'var(--warn)' }}>Can&apos;t close yet</h3>
          <p className="muted">These orders are still open or awaiting payment:</p>
          <ErrorBanner error={deleteOrder.error} />
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Type</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {blockers.map((order) => (
                <tr key={order.id}>
                  <td>{order.tableLabel ?? `#${order.id}`}</td>
                  <td>{order.orderType.replace('_', ' ')}</td>
                  <td>{order.status}</td>
                  <td className="num">
                    {/* An order with nothing on it is holding the day
                        open for no reason. Clearing it here saves the
                        manager hunting for it on the floor at
                        midnight. */}
                    {order.lineCount === 0 ? (
                      <button
                        className="ghost"
                        disabled={deleteOrder.isPending}
                        // The mutation invalidates the shift's queries,
                        // so the row leaves this list because the server
                        // no longer returns it — not because the screen
                        // hid it.
                        onClick={() => deleteOrder.mutate(order.id)}
                      >
                        Delete (empty)
                      </button>
                    ) : (
                      <span className="muted">{order.status === 'open' ? 'finish or void it' : 'take payment'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!closed && (
        <div className="card col" style={{ maxWidth: 420 }}>
          <h3 style={{ margin: 0 }}>Close shift</h3>
          <div>
            <label htmlFor="counted-cash">Counted cash</label>
            <MoneyInput id="counted-cash" valueMinor={countedCashMinor} onChange={setCountedCashMinor} />
          </div>
          {/* Disabled while the server would refuse anyway, with the
              reason on screen above rather than behind a click. */}
          <button
            className="primary big"
            disabled={closeShift.isPending || blockers.length > 0}
            onClick={() => closeShift.mutate({ shiftId: shift.id, countedCashMinor })}
          >
            {blockers.length > 0 ? `${blockers.length} order${blockers.length === 1 ? '' : 's'} to clear first` : 'Count and close'}
          </button>
        </div>
      )}

      {closed && (
        <div className="card">
          <h3 style={{ margin: 0 }}>Cash reconciliation</h3>
          <div className="total-line">
            <span>Expected</span>
            <Money minor={shift.expectedCashMinor} />
          </div>
          <div className="total-line">
            <span>Counted</span>
            <Money minor={shift.countedCashMinor} />
          </div>
          <div className="total-line grand">
            <span>Variance</span>
            <Money minor={shift.varianceMinor} />
          </div>
        </div>
      )}

      <div className="z-report">
        <ZReportCard zReport={zReport.data} loading={zReport.isLoading} />

        <div className="card">
          <h3 style={{ margin: 0 }}>Service charge payout</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Money the restaurant is <strong>holding for waiters</strong>, not revenue it earned. Hand it over with the Z-report.
          </p>
          {payout.isLoading && <Loading />}
          <table>
            <tbody>
              {payout.data?.map((line) => (
                <tr key={line.waiterId}>
                  <td>{line.waiterName}</td>
                  <td className="num">
                    <Money minor={line.totalMinor} />
                  </td>
                </tr>
              ))}
              {payout.data?.length === 0 && (
                <tr>
                  <td className="muted">Nothing owed this shift.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/**
 * The Z-report, laid out as the two questions an operator actually has
 * at close — "how much should be in the drawer?" and "how much did we
 * count?" — rather than as a list of accounting terms.
 *
 * Every figure here is the server's; nothing is re-derived in the
 * browser. Expected cash in particular is computed the same way the
 * close computes it, so what this screen shows before closing is what
 * the close will record.
 */
function ZReportCard({ zReport, loading }: { zReport: ZReport | undefined; loading: boolean }): JSX.Element {
  if (loading) return <Loading />;
  if (!zReport) return <div className="card" />;

  const counted = zReport.countedCashMinor;
  const variance = zReport.varianceMinor;

  return (
    <div className="card col">
      <h3 style={{ margin: 0 }}>Z-report</h3>

      <section>
        <h4>The drawer</h4>
        <div className="total-line">
          <span>Opening float</span>
          <Money minor={zReport.openingFloatMinor} />
        </div>
        <div className="total-line">
          <span>Cash taken (applied to bills)</span>
          <Money minor={zReport.cashPaymentsMinor} />
        </div>
        {zReport.changeGivenMinor > 0 && (
          <>
            <div className="total-line muted">
              <span>… cash handed over by customers</span>
              <Money minor={zReport.cashTenderedMinor} />
            </div>
            <div className="total-line muted">
              <span>… change handed back</span>
              <Money minor={zReport.changeGivenMinor} />
            </div>
          </>
        )}
        <div className="total-line grand">
          <span>Should be in the drawer</span>
          <Money minor={zReport.expectedCashMinor} />
        </div>
        {counted !== null ? (
          <>
            <div className="total-line">
              <span>Counted</span>
              <Money minor={counted} />
            </div>
            <div
              className="total-line grand"
              style={{ color: variance === 0 ? 'var(--success)' : 'var(--danger)' }}
            >
              <span>{variance === null || variance === 0 ? 'Balanced' : variance > 0 ? 'Over by' : 'Short by'}</span>
              <Money minor={variance === null ? null : abs(variance)} />
            </div>
          </>
        ) : (
          <p className="muted field-hint">Count the drawer below to see whether it balances.</p>
        )}
      </section>

      <section>
        <h4>Sales</h4>
        {/* What was rung up, before anything was taken off — the figure
            the discounts below are a deduction FROM. Without it the
            "taken off bills" section has no denominator. */}
        <div className="total-line">
          <span>Gross sales</span>
          <Money minor={zReport.grossSalesMinor} />
        </div>
        <div className="total-line">
          <span>Customer sales (after discounts)</span>
          <Money minor={zReport.customerSalesMinor} />
        </div>
        <div className="total-line">
          <span>Staff &amp; owner meals (menu value)</span>
          <Money minor={zReport.consumptionMinor} />
        </div>
        {zReport.consumptionUnchargedMinor > 0 && (
          <div className="total-line muted">
            <span>… of which the house absorbed</span>
            <Money minor={zReport.consumptionUnchargedMinor} />
          </div>
        )}
        <div className="total-line grand">
          <span>Combined</span>
          <Money minor={zReport.combinedSalesMinor} />
        </div>
      </section>

      <section>
        <h4>Taken off bills</h4>
        <div className="total-line">
          <span>Discounts given</span>
          <Money minor={zReport.discountsGivenMinor} />
        </div>
        <div className="total-line">
          <span>Voided</span>
          <Money minor={zReport.voidedSalesMinor} />
        </div>
        <div className="total-line">
          <span>Rounding adjustments</span>
          <Money minor={zReport.roundingAdjustmentMinor} />
        </div>
      </section>

      <section>
        <h4>Collected</h4>
        <div className="total-line">
          <span>Tax collected</span>
          <Money minor={zReport.taxCollectedMinor} />
        </div>
        <div className="total-line">
          <span>Service charge (held for waiters, not revenue)</span>
          <Money minor={zReport.serviceChargeCollectedMinor} />
        </div>
        <div className="total-line">
          <span>Cash</span>
          <Money minor={zReport.cashPaymentsMinor} />
        </div>
        <div className="total-line">
          <span>Everything else</span>
          <Money minor={zReport.nonCashPaymentsMinor} />
        </div>

        <table>
          <tbody>
            {zReport.paymentMethodBreakdown.map((line) => (
              <tr key={line.paymentMethodId}>
                <td>{line.paymentMethodName}</td>
                <td className="num">
                  <Money minor={line.totalMinor} />
                </td>
              </tr>
            ))}
            {zReport.paymentMethodBreakdown.length === 0 && (
              <tr>
                <td className="muted">No payments yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
