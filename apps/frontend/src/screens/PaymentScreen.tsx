import { paisa, type Paisa } from '@pos/shared';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import { useOrder, usePaymentMethods, usePeople, usePrintReceipt, useRecordPayment, useSettleConsumption } from '../api/hooks.js';
import type { SettlementType } from '../api/types.js';
import { ErrorBanner, Loading, Money, MoneyInput } from '../components/ui.tsx';

/**
 * Screen 5: record one or more payments by method, capture a reference
 * number where the method needs one, show change for cash, and close +
 * print the receipt. A staff/owner meal settles through a different
 * server path entirely (settle-consumption, not payments), so this
 * screen switches to that form when the order is one.
 *
 * "Already settled on another terminal" is a 422 from the server with a
 * plain sentence — shown as-is, with a way back to the floor, rather
 * than an error that looks like a crash.
 */
export function PaymentScreen(): JSX.Element {
  const { orderId: orderIdParam } = useParams();
  const orderId = Number(orderIdParam);
  const order = useOrder(orderId);

  if (order.isLoading) return <Loading />;
  if (order.error) return <ErrorBanner error={order.error} />;
  if (!order.data) return <p>Order not found.</p>;

  return order.data.channel === 'customer' ? <CustomerPayment orderId={orderId} /> : <ConsumptionSettlement orderId={orderId} />;
}

function CustomerPayment({ orderId }: { orderId: number }): JSX.Element {
  const navigate = useNavigate();
  const order = useOrder(orderId);
  const methods = usePaymentMethods();
  const recordPayment = useRecordPayment();
  const printReceipt = usePrintReceipt();

  const [methodId, setMethodId] = useState<number | ''>('');
  const [amountMinor, setAmountMinor] = useState<Paisa>(paisa(0));
  const [tenderedMinor, setTenderedMinor] = useState<Paisa>(paisa(0));
  const [referenceNo, setReferenceNo] = useState('');
  const [changeDue, setChangeDue] = useState<Paisa | null>(null);
  const [settledElsewhere, setSettledElsewhere] = useState<string | null>(null);

  const detail = order.data;
  if (!detail) return <Loading />;

  const method = methods.data?.find((candidate) => candidate.id === methodId);
  const needsReference = method?.kind === 'wallet' || method?.kind === 'bank_transfer';
  const isCash = method?.kind === 'cash';

  const submit = () => {
    if (methodId === '') return;
    recordPayment.mutate(
      {
        orderId,
        paymentMethodId: Number(methodId),
        amountMinor,
        ...(needsReference && referenceNo.trim() ? { referenceNo: referenceNo.trim() } : {}),
        ...(isCash && tenderedMinor > 0 ? { tenderedMinor } : {}),
      },
      {
        onSuccess: (result) => {
          setChangeDue(result.changeMinor);
          setReferenceNo('');
          if (result.orderClosed) {
            printReceipt.mutate(orderId, {
              onSettled: () => {
                // Give the cashier a beat to read the change due before
                // returning to the floor; a failed print never blocks it.
                if (result.changeMinor === null || result.changeMinor === 0) navigate('/');
              },
            });
          }
        },
        onError: (error) => {
          if (error instanceof ApiError && error.isDomainError && /already settled/i.test(error.message)) {
            setSettledElsewhere(error.message);
          }
        },
      },
    );
  };

  if (settledElsewhere) {
    return (
      <div className="card col" style={{ maxWidth: 560 }}>
        <h2 style={{ margin: 0 }}>Already settled</h2>
        <p>{settledElsewhere}</p>
        <p className="muted">Another terminal closed this bill first — nothing was double-charged.</p>
        <button className="primary big" onClick={() => navigate('/')}>
          Back to floor
        </button>
      </div>
    );
  }

  if (detail.status === 'closed') {
    return (
      <div className="card col" style={{ maxWidth: 560 }}>
        <h2 style={{ margin: 0 }}>Settled</h2>
        <p>
          Invoice #{detail.invoiceNo} · <Money minor={detail.totalMinor} />
        </p>
        {changeDue !== null && changeDue > 0 && (
          <p style={{ fontSize: 24 }}>
            Change due: <Money minor={changeDue} />
          </p>
        )}
        <ErrorBanner error={printReceipt.error} />
        <div className="row">
          <button onClick={() => printReceipt.mutate(orderId)}>Reprint receipt</button>
          <button className="primary big" onClick={() => navigate('/')}>
            Back to floor
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="col" style={{ maxWidth: 720 }}>
      <h1 style={{ margin: 0 }}>
        Payment — {detail.tableLabel ?? detail.orderType.replace('_', ' ')} <span className="muted">#{detail.id}</span>
      </h1>
      <ErrorBanner error={recordPayment.error} />

      <div className="card">
        <div className="total-line grand">
          <span>Total due</span>
          <Money minor={detail.totalMinor} />
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          Partial payments are fine — the order stays awaiting payment until they add up to the total.
        </p>
      </div>

      <div className="card col">
        <div>
          <label>Method</label>
          <div className="tabs">
            {methods.data?.map((candidate) => (
              <button key={candidate.id} className={candidate.id === methodId ? 'active' : ''} onClick={() => setMethodId(candidate.id)}>
                {candidate.displayName}
              </button>
            ))}
          </div>
        </div>

        <div className="row">
          <div style={{ flex: 1 }}>
            <label htmlFor="amount">Amount</label>
            <MoneyInput id="amount" valueMinor={amountMinor} onChange={setAmountMinor} />
          </div>
          {isCash && (
            <div style={{ flex: 1 }}>
              <label htmlFor="tendered">Cash tendered (for change)</label>
              <MoneyInput id="tendered" valueMinor={tenderedMinor} onChange={setTenderedMinor} />
            </div>
          )}
          {needsReference && (
            <div style={{ flex: 1 }}>
              <label htmlFor="reference">Reference number</label>
              <input id="reference" value={referenceNo} onChange={(event) => setReferenceNo(event.target.value)} />
            </div>
          )}
        </div>

        <div className="row">
          <button onClick={() => setAmountMinor(detail.totalMinor)}>Exact total</button>
          <span style={{ flex: 1 }} />
          <button
            className="primary big"
            disabled={recordPayment.isPending || methodId === '' || amountMinor <= 0 || (needsReference && !referenceNo.trim())}
            onClick={submit}
          >
            Record payment
          </button>
        </div>
      </div>

      <button className="ghost" onClick={() => navigate('/')}>
        Back to floor
      </button>
    </div>
  );
}

function ConsumptionSettlement({ orderId }: { orderId: number }): JSX.Element {
  const navigate = useNavigate();
  const order = useOrder(orderId);
  const methods = usePaymentMethods();
  const people = usePeople();
  const settle = useSettleConsumption();

  const [settlementType, setSettlementType] = useState<SettlementType>('house_expense');
  const [methodId, setMethodId] = useState<number | ''>('');

  const detail = order.data;
  if (!detail) return <Loading />;

  const person = people.data?.find((candidate) => candidate.id === detail.beneficiaryPersonId);
  const collectsMoney = person?.mealPolicy === 'full_price' || person?.mealPolicy === 'discounted';
  // A full_price meal leaves nothing unsettled, and the server rejects a
  // settlement type it has no gap to apply it to — so only send one when
  // the policy actually leaves a gap.
  const leavesGap = person !== undefined && person.mealPolicy !== 'full_price';

  if (detail.status === 'closed') {
    return (
      <div className="card col" style={{ maxWidth: 560 }}>
        <h2 style={{ margin: 0 }}>Meal settled</h2>
        <p>Invoice #{detail.invoiceNo}</p>
        <button className="primary big" onClick={() => navigate('/')}>
          Back to floor
        </button>
      </div>
    );
  }

  return (
    <div className="col" style={{ maxWidth: 720 }}>
      <div className="banner">
        {detail.channel === 'staff_meal' ? 'Staff meal' : 'Owner meal'} — {person?.name ?? `person ${detail.beneficiaryPersonId}`}
        {person && ` · ${person.mealPolicy.replace('_', ' ')}`}
      </div>

      <h1 style={{ margin: 0 }}>Settle meal</h1>
      <ErrorBanner error={settle.error} />

      <div className="card">
        <div className="total-line">
          <span>Menu value</span>
          <Money minor={detail.netSalesMinor} />
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          What {person?.name ?? 'this person'} pays comes from their meal policy — the owning partner is still credited the full menu value.
        </p>
      </div>

      <div className="card col">
        {collectsMoney && (
          <div>
            <label>Payment method (for the charged portion)</label>
            <div className="tabs">
              {methods.data?.map((candidate) => (
                <button key={candidate.id} className={candidate.id === methodId ? 'active' : ''} onClick={() => setMethodId(candidate.id)}>
                  {candidate.displayName}
                </button>
              ))}
            </div>
          </div>
        )}

        {leavesGap ? (
          <div>
            <label htmlFor="settlement-type">Settle the uncharged portion as</label>
            <select id="settlement-type" value={settlementType} onChange={(event) => setSettlementType(event.target.value as SettlementType)}>
              <option value="house_expense">House expense</option>
              <option value="payroll_deduction">Payroll deduction</option>
              <option value="partner_personal">Partner personal</option>
            </select>
          </div>
        ) : (
          <p className="muted">Charged in full — there's nothing left to settle.</p>
        )}

        <button
          className="primary big"
          disabled={settle.isPending || (collectsMoney && methodId === '')}
          onClick={() =>
            settle.mutate(
              {
                orderId,
                ...(leavesGap ? { settlementType } : {}),
                ...(collectsMoney && methodId !== '' ? { paymentMethodId: Number(methodId) } : {}),
              },
              { onSuccess: () => navigate('/') },
            )
          }
        >
          Settle and close
        </button>
      </div>

      <button className="ghost" onClick={() => navigate('/')}>
        Back to floor
      </button>
    </div>
  );
}
