import { paisa, roundUpTo, sub, type Paisa } from '@pos/shared';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import { useOrder, usePaymentAccounts, usePaymentMethods, usePeople, usePrintReceipt, useRecordPayment, useSettleConsumption } from '../api/hooks.js';
import type { SettlementType } from '../api/types.js';
import { ErrorBanner, Loading, Money, MoneyInput } from '../components/ui.tsx';
import { orderTitle } from './OrderScreen.tsx';

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

/**
 * Taking money for a customer bill.
 *
 * Cash and everything else behave differently on purpose. For cash, the
 * cashier keys what the customer handed over: the bill takes what it
 * can absorb and the rest is change, which is the single most common
 * transaction in the restaurant and used to be an outright error
 * ("payment of 200000 exceeds the remaining balance of 180000"). For a
 * wallet or bank transfer there is nothing to hand back from the
 * drawer, so an overpayment stays a rejection.
 *
 * A reference number is optional throughout — a customer who paid in
 * person often has none to give — and the account the money landed in
 * is recorded when the restaurant has configured any.
 */
function CustomerPayment({ orderId }: { orderId: number }): JSX.Element {
  const navigate = useNavigate();
  const order = useOrder(orderId);
  const methods = usePaymentMethods();
  const recordPayment = useRecordPayment();
  const printReceipt = usePrintReceipt();

  const [methodId, setMethodId] = useState<number | ''>('');
  const [amountMinor, setAmountMinor] = useState<Paisa>(paisa(0));
  const [referenceNo, setReferenceNo] = useState('');
  const [accountId, setAccountId] = useState<number | ''>('');
  const [changeDue, setChangeDue] = useState<Paisa | null>(null);
  const [settledElsewhere, setSettledElsewhere] = useState<string | null>(null);

  const method = methods.data?.find((candidate) => candidate.id === methodId);
  const accounts = usePaymentAccounts(method && method.kind !== 'cash' ? method.id : undefined);

  const detail = order.data;
  if (!detail) return <Loading />;

  const isCash = method?.kind === 'cash';
  const takesReference = method?.kind === 'wallet' || method?.kind === 'bank_transfer';
  // What is still owed, straight from the server. The payment screen is
  // reachable directly by URL, so it cannot assume a cashier arrived
  // here from a floor board that already knew.
  const balanceMinor = detail.balanceMinor;

  // A local preview of what the server will do, so the cashier can read
  // the change off the screen BEFORE committing. The server does this
  // arithmetic again and its answer is the one that is recorded.
  const overpaying = isCash && amountMinor > balanceMinor;
  const changeIfCash = overpaying ? sub(amountMinor, balanceMinor) : paisa(0);
  const appliedMinor = overpaying ? balanceMinor : amountMinor;

  const submit = () => {
    if (methodId === '') return;
    recordPayment.mutate(
      {
        orderId,
        paymentMethodId: Number(methodId),
        amountMinor,
        ...(takesReference && referenceNo.trim() ? { referenceNo: referenceNo.trim() } : {}),
        ...(accountId !== '' ? { paymentAccountId: Number(accountId) } : {}),
      },
      {
        onSuccess: (result) => {
          setChangeDue(result.changeMinor);
          setReferenceNo('');
          setAmountMinor(paisa(0));
          // Settling prints the receipt and then STAYS on the
          // confirmation, rather than snapping back to the floor: the
          // cashier needs to read the invoice number and the change due,
          // and a screen that vanishes on success is a screen that never
          // told them whether it worked. A failed print never blocks it.
          if (result.orderClosed) printReceipt.mutate(orderId);
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
      <div className="card col settled-card">
        <h2 style={{ margin: 0 }}>Paid in full</h2>
        <p>
          Invoice #{detail.invoiceNo} · <Money minor={detail.totalMinor} />
        </p>
        {changeDue !== null && changeDue > 0 && (
          <p className="change-due">
            Change due: <Money minor={changeDue} />
          </p>
        )}
        <ErrorBanner error={printReceipt.error} />
        <div className="row">
          <button onClick={() => printReceipt.mutate(orderId)}>Reprint receipt</button>
          {/* Focused, so Enter takes the cashier straight back to the
              floor without reaching for the mouse. */}
          <button className="primary big" autoFocus onClick={() => navigate('/')}>
            Back to floor
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="col" style={{ maxWidth: 760 }}>
      <h1 style={{ margin: 0 }}>
        Payment — {orderTitle(detail)} <span className="muted">#{detail.id}</span>
      </h1>
      <ErrorBanner error={recordPayment.error} />

      <div className="card">
        <div className="total-line">
          <span>Bill total</span>
          <Money minor={detail.totalMinor} />
        </div>
        {detail.paidMinor > 0 && (
          <div className="total-line">
            <span>Already paid</span>
            <Money minor={detail.paidMinor} />
          </div>
        )}
        <div className="total-line grand">
          <span>Still due</span>
          <Money minor={balanceMinor} />
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
              <button
                key={candidate.id}
                className={candidate.id === methodId ? 'active' : ''}
                onClick={() => {
                  setMethodId(candidate.id);
                  setAccountId('');
                }}
              >
                {candidate.displayName}
              </button>
            ))}
          </div>
        </div>

        <div className="row">
          <div style={{ flex: 1 }}>
            <label htmlFor="amount">{isCash ? 'Cash tendered' : 'Amount'}</label>
            <MoneyInput id="amount" valueMinor={amountMinor} onChange={setAmountMinor} />
            {isCash && <p className="muted field-hint">Type what the customer handed over. Change is worked out below.</p>}
          </div>

          {takesReference && (
            <div style={{ flex: 1 }}>
              <label htmlFor="reference">Reference number (optional)</label>
              <input id="reference" value={referenceNo} onChange={(event) => setReferenceNo(event.target.value)} />
            </div>
          )}
        </div>

        {method && method.kind !== 'cash' && (accounts.data?.length ?? 0) > 0 && (
          <div>
            <label htmlFor="account">Which account received it?</label>
            <select id="account" value={accountId} onChange={(event) => setAccountId(event.target.value === '' ? '' : Number(event.target.value))}>
              <option value="">Not recorded</option>
              {accounts.data?.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label}
                  {account.accountNumber ? ` · ${account.accountNumber}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        {isCash && amountMinor > 0 && (
          <div className="cash-summary">
            <div className="total-line">
              <span>Applied to bill</span>
              <Money minor={appliedMinor} />
            </div>
            <div className="total-line grand">
              <span>Change</span>
              <Money minor={changeIfCash} />
            </div>
          </div>
        )}

        <div className="row">
          <button onClick={() => setAmountMinor(balanceMinor)}>Exact amount</button>
          {isCash && <QuickCash total={balanceMinor} onPick={setAmountMinor} />}
          <span style={{ flex: 1 }} />
          <button className="primary big" disabled={recordPayment.isPending || methodId === '' || amountMinor <= 0} onClick={submit}>
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

/**
 * The notes a customer is most likely to hand over for this bill — the
 * next round 100, 500, 1000 and 5000 above the total. Saves the cashier
 * typing the commonest amounts, and never offers one below the bill,
 * which would be a partial payment dressed up as a shortcut.
 */
function QuickCash({ total, onPick }: { total: Paisa; onPick: (amount: Paisa) => void }): JSX.Element {
  const notes = [100_00, 500_00, 1000_00, 5000_00];
  const suggestions: Paisa[] = [];
  for (const note of notes) {
    // `roundUpTo` lives in the money module, not here: every arithmetic
    // operator on a Paisa does (docs/decisions/001).
    const rounded = roundUpTo(total, note);
    if (rounded > total && !suggestions.includes(rounded)) suggestions.push(rounded);
  }

  return (
    <>
      {suggestions.slice(0, 3).map((amount) => (
        <button key={amount} onClick={() => onPick(amount)}>
          <Money minor={amount} />
        </button>
      ))}
    </>
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
  const [accountId, setAccountId] = useState<number | ''>('');

  const selectedMethod = methods.data?.find((candidate) => candidate.id === methodId);
  const accounts = usePaymentAccounts(selectedMethod && selectedMethod.kind !== 'cash' ? selectedMethod.id : undefined);

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
          <>
            <div>
              <label>Payment method (for the charged portion)</label>
              <div className="tabs">
                {methods.data?.map((candidate) => (
                  <button
                    key={candidate.id}
                    className={candidate.id === methodId ? 'active' : ''}
                    onClick={() => {
                      setMethodId(candidate.id);
                      setAccountId('');
                    }}
                  >
                    {candidate.displayName}
                  </button>
                ))}
              </div>
            </div>

            {selectedMethod && selectedMethod.kind !== 'cash' && (accounts.data?.length ?? 0) > 0 && (
              <div>
                <label htmlFor="settle-account">Which account received it?</label>
                <select
                  id="settle-account"
                  value={accountId}
                  onChange={(event) => setAccountId(event.target.value === '' ? '' : Number(event.target.value))}
                >
                  <option value="">Not recorded</option>
                  {accounts.data?.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </>
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
                ...(collectsMoney && accountId !== '' ? { paymentAccountId: Number(accountId) } : {}),
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
