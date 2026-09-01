import { paisa, roundUpTo, sub, type Paisa } from '@pos/shared';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import { useOrder, usePaymentOptions, usePeople, usePrintReceipt, useRecordPayment, useSettleConsumption } from '../api/hooks.js';
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
  const options = usePaymentOptions();
  const recordPayment = useRecordPayment();
  const printReceipt = usePrintReceipt();

  const [methodId, setMethodId] = useState<number | ''>('');
  const [amountMinor, setAmountMinor] = useState<Paisa>(paisa(0));
  const [referenceNo, setReferenceNo] = useState('');
  const [accountId, setAccountId] = useState<number | ''>('');
  const [changeDue, setChangeDue] = useState<Paisa | null>(null);
  const [settledElsewhere, setSettledElsewhere] = useState<string | null>(null);
  const [printedVia, setPrintedVia] = useState<'thermal' | 'fallback' | null>(null);

  const option = options.data?.find((candidate) => candidate.paymentMethodId === methodId);
  const detail = order.data;
  if (!detail) return <Loading />;

  const isCash = option?.kind === 'cash';
  const takesReference = option?.kind === 'wallet' || option?.kind === 'bank_transfer';

  // Which account this payment will land in. With exactly one active
  // account there is nothing to choose — the server picks it too, so
  // the screen shows it rather than asking a question with one answer.
  const accounts = option?.accounts ?? [];
  const soleAccount = option?.requiresAccount && accounts.length === 1 ? accounts[0] : undefined;
  const needsAccountChoice = (option?.requiresAccount ?? false) && accounts.length > 1;
  const blocked = option?.blockedReason ?? null;

  const balanceMinor = detail.balanceMinor;
  const overpaying = isCash && amountMinor > balanceMinor;
  const changeIfCash = overpaying ? sub(amountMinor, balanceMinor) : paisa(0);
  const appliedMinor = overpaying ? balanceMinor : amountMinor;

  const canRecord =
    !recordPayment.isPending &&
    methodId !== '' &&
    amountMinor > 0 &&
    blocked === null &&
    (!needsAccountChoice || accountId !== '');

  const selectMethod = (id: number) => {
    setMethodId(id);
    // Don't carry a choice across methods — an account belongs to
    // exactly one, and the server rejects a mismatch.
    setAccountId('');
    setReferenceNo('');
  };

  const submit = () => {
    if (methodId === '' || !canRecord) return;
    // Only send an account when the cashier actually chose one: with a
    // single account the server selects it, and sending our own copy
    // would be a second place for that choice to be made.
    const chosenAccountId = needsAccountChoice && accountId !== '' ? Number(accountId) : undefined;

    recordPayment.mutate(
      {
        orderId,
        paymentMethodId: Number(methodId),
        amountMinor,
        ...(takesReference && referenceNo.trim() ? { referenceNo: referenceNo.trim() } : {}),
        ...(chosenAccountId === undefined ? {} : { paymentAccountId: chosenAccountId }),
      },
      {
        onSuccess: (result) => {
          setChangeDue(result.changeMinor);
          setReferenceNo('');
          setAmountMinor(paisa(0));
          // Settling prints the receipt and then STAYS on the
          // confirmation: the cashier needs to read the invoice number
          // and the change due, and a screen that vanishes on success
          // never told them whether it worked. Printing cannot fail the
          // sale — see the note on the settled card below.
          if (result.orderClosed) {
            printReceipt.mutate(orderId, { onSuccess: (via) => setPrintedVia(via) });
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
      <div className="card col settled-card">
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

        {/* The sale is done. What the printer did is information, never
            a failure — a cancelled print or a missing printer does not
            un-take the money. */}
        {printReceipt.isPending && <p className="muted">Printing the receipt…</p>}
        {printedVia === 'fallback' && (
          <p className="muted">
            No POS printer is connected, so the receipt was sent to Windows printing. Use Reprint receipt if you closed the dialog.
          </p>
        )}
        <ErrorBanner error={printReceipt.error} />

        <div className="row">
          <button disabled={printReceipt.isPending} onClick={() => printReceipt.mutate(orderId, { onSuccess: (via) => setPrintedVia(via) })}>
            Reprint receipt
          </button>
          {/* The full record is one click away rather than something a
              cashier has to go back to the floor to find. */}
          <button onClick={() => navigate(`/orders/${orderId}/detail`)}>Order details</button>
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
            {options.data?.map((candidate) => (
              <button
                key={candidate.paymentMethodId}
                className={candidate.paymentMethodId === methodId ? 'active' : ''}
                onClick={() => selectMethod(candidate.paymentMethodId)}
              >
                {candidate.displayName}
                {/* Flagged on the button itself, so a cashier sees which
                    methods are unusable before choosing one. */}
                {candidate.blockedReason && <span className="method-blocked"> · not set up</span>}
              </button>
            ))}
          </div>
        </div>

        {blocked && (
          <div className="blocked-notice">
            <strong>{blocked}</strong>
            <p className="muted">
              An admin can add one under Settings → Payment accounts. Take this payment another way in the meantime.
            </p>
          </div>
        )}

        {option && !blocked && (
          <>
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

            {soleAccount && (
              <p className="account-note">
                Money goes to <strong>{soleAccount.label}</strong>
                {soleAccount.accountNumber ? ` · ${soleAccount.accountNumber}` : ''}
              </p>
            )}

            {needsAccountChoice && (
              <div>
                <label htmlFor="account">Which account received it?</label>
                <select
                  id="account"
                  value={accountId}
                  onChange={(event) => setAccountId(event.target.value === '' ? '' : Number(event.target.value))}
                >
                  <option value="">Choose an account…</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label}
                      {account.accountNumber ? ` · ${account.accountNumber}` : ''}
                    </option>
                  ))}
                </select>
                {accountId === '' && <p className="muted field-hint">Required — {accounts.length} accounts are configured.</p>}
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
              <button className="primary big" disabled={!canRecord} onClick={submit}>
                Record payment
              </button>
            </div>
          </>
        )}
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
  const options = usePaymentOptions();
  const people = usePeople();
  const settle = useSettleConsumption();

  const [settlementType, setSettlementType] = useState<SettlementType>('house_expense');
  const [methodId, setMethodId] = useState<number | ''>('');
  const [accountId, setAccountId] = useState<number | ''>('');

  const option = options.data?.find((candidate) => candidate.paymentMethodId === methodId);
  const accounts = option?.accounts ?? [];
  const soleAccount = option?.requiresAccount && accounts.length === 1 ? accounts[0] : undefined;
  const needsAccountChoice = (option?.requiresAccount ?? false) && accounts.length > 1;
  const blocked = option?.blockedReason ?? null;

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
        <div className="row">
          <button onClick={() => navigate(`/orders/${orderId}/detail`)}>Order details</button>
          <button className="primary big" onClick={() => navigate('/')}>
            Back to floor
          </button>
        </div>
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
                {options.data?.map((candidate) => (
                  <button
                    key={candidate.paymentMethodId}
                    className={candidate.paymentMethodId === methodId ? 'active' : ''}
                    onClick={() => {
                      setMethodId(candidate.paymentMethodId);
                      setAccountId('');
                    }}
                  >
                    {candidate.displayName}
                    {candidate.blockedReason && <span className="method-blocked"> · not set up</span>}
                  </button>
                ))}
              </div>
            </div>

            {blocked && (
              <div className="blocked-notice">
                <strong>{blocked}</strong>
                <p className="muted">An admin can add one under Settings → Payment accounts.</p>
              </div>
            )}

            {soleAccount && (
              <p className="account-note">
                Money goes to <strong>{soleAccount.label}</strong>
              </p>
            )}

            {needsAccountChoice && (
              <div>
                <label htmlFor="settle-account">Which account received it?</label>
                <select
                  id="settle-account"
                  value={accountId}
                  onChange={(event) => setAccountId(event.target.value === '' ? '' : Number(event.target.value))}
                >
                  <option value="">Choose an account…</option>
                  {accounts.map((account) => (
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
          disabled={settle.isPending || (collectsMoney && (methodId === '' || blocked !== null || (needsAccountChoice && accountId === '')))}
          onClick={() =>
            settle.mutate(
              {
                orderId,
                ...(leavesGap ? { settlementType } : {}),
                ...(collectsMoney && methodId !== '' ? { paymentMethodId: Number(methodId) } : {}),
                ...(collectsMoney && needsAccountChoice && accountId !== '' ? { paymentAccountId: Number(accountId) } : {}),
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
