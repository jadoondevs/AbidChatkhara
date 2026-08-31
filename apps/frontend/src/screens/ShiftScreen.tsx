import { paisa, type Paisa } from '@pos/shared';
import { useState } from 'react';
import { ApiError } from '../api/client.js';
import { useCloseShiftMutation, useOpenShift, useOpenShiftMutation, usePayoutSheet, useZReport } from '../api/hooks.js';
import type { BlockingOrder } from '../api/types.js';
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
  const [blocking, setBlocking] = useState<BlockingOrder[] | null>(null);

  const shift = openShift.data;
  const zReport = useZReport(shift?.id ?? null);
  const payout = usePayoutSheet(shift?.id ?? null);

  if (openShift.isLoading) return <Loading />;

  if (!shift) {
    return (
      <div className="col" style={{ maxWidth: 520 }}>
        <h1 style={{ margin: 0 }}>Shift</h1>
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

  return (
    <div className="col" style={{ maxWidth: 900 }}>
      <h1 style={{ margin: 0 }}>Shift #{shift.id}</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Opened {new Date(shift.openedAt).toLocaleString()} · float <Money minor={shift.openingCashMinor} />
      </p>

      <ErrorBanner error={closeShift.error instanceof ApiError && closeShift.error.isDomainError ? null : closeShift.error} />

      {blocking && blocking.length > 0 && (
        <div className="card">
          <h3 style={{ margin: 0, color: 'var(--warn)' }}>Can&apos;t close yet</h3>
          <p className="muted">These orders are still open or awaiting payment:</p>
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Type</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {blocking.map((order) => (
                <tr key={order.id}>
                  <td>{order.tableLabel ?? `#${order.id}`}</td>
                  <td>{order.orderType.replace('_', ' ')}</td>
                  <td>{order.status}</td>
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
          <button
            className="primary big"
            disabled={closeShift.isPending}
            onClick={() =>
              closeShift.mutate(
                { shiftId: shift.id, countedCashMinor },
                {
                  onSuccess: () => setBlocking(null),
                  onError: (error) => {
                    const body = error instanceof ApiError ? (error.body as { blockingOrders?: BlockingOrder[] }) : null;
                    setBlocking(body?.blockingOrders ?? []);
                  },
                },
              )
            }
          >
            Count and close
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

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
        <div className="card">
          <h3 style={{ margin: 0 }}>Z-report</h3>
          {zReport.isLoading && <Loading />}
          {zReport.data && (
            <>
              <div className="total-line">
                <span>Customer sales</span>
                <Money minor={zReport.data.customerSalesMinor} />
              </div>
              <div className="total-line">
                <span>Staff &amp; owner consumption</span>
                <Money minor={zReport.data.consumptionMinor} />
              </div>
              <div className="total-line">
                <span>Combined</span>
                <Money minor={zReport.data.combinedSalesMinor} />
              </div>
              <div className="total-line">
                <span>Tax collected</span>
                <Money minor={zReport.data.taxCollectedMinor} />
              </div>
              <div className="total-line">
                <span>Service charge (held, not earned)</span>
                <Money minor={zReport.data.serviceChargeCollectedMinor} />
              </div>
              <div className="total-line">
                <span>Rounding adjustments</span>
                <Money minor={zReport.data.roundingAdjustmentMinor} />
              </div>
              <h4>By payment method</h4>
              <table>
                <tbody>
                  {zReport.data.paymentMethodBreakdown.map((line) => (
                    <tr key={line.paymentMethodId}>
                      <td>{line.paymentMethodName}</td>
                      <td className="num">
                        <Money minor={line.totalMinor} />
                      </td>
                    </tr>
                  ))}
                  {zReport.data.paymentMethodBreakdown.length === 0 && (
                    <tr>
                      <td className="muted">No payments yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}
        </div>

        <div className="card">
          <h3 style={{ margin: 0 }}>Service charge payout</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Owed per waiter for this shift — hand over with the Z-report.
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
