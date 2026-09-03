import { paisa, roundUpTo, sub, type Paisa } from '@pos/shared';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import {
  useAgentStatus,
  useOrder,
  usePaymentOptions,
  usePeople,
  usePrintReceipt,
  useRecordPayment,
  useRefundOrder,
  useRoster,
  useSettleConsumption,
} from '../api/hooks.js';
import type { OrderDetail, PaymentOption, SettlementType } from '../api/types.js';
import { PrintDecision } from '../components/PrintDecision.tsx';
import { ErrorBanner, Loading, Money, MoneyInput, PrinterStatus } from '../components/ui.tsx';
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
  const refundOrder = useRefundOrder();
  const printer = useAgentStatus();
  // Only to put a name against the order's waiter id. Cached across the
  // app — the new-order dialog has already asked for it.
  const roster = useRoster();

  const [methodId, setMethodId] = useState<number | ''>('');
  const [amountMinor, setAmountMinor] = useState<Paisa>(paisa(0));
  const [referenceNo, setReferenceNo] = useState('');
  const [accountId, setAccountId] = useState<number | ''>('');
  const [changeDue, setChangeDue] = useState<Paisa | null>(null);
  const [settledElsewhere, setSettledElsewhere] = useState<string | null>(null);
  // Set when the receipt did not print. The payment is already recorded
  // and the sale is complete (decision 018), so this only offers a
  // retry — never un-takes the money, and never falls back to blank
  // Windows paper.
  const [receiptFailed, setReceiptFailed] = useState(false);

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

  // One place decides what happens after a receipt print, so the
  // automatic print on settlement and the Reprint button behave
  // identically.
  const printHandlers = {
    onSuccess: () => setReceiptFailed(false),
    onError: () => setReceiptFailed(true),
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
          if (result.orderClosed) printReceipt.mutate(orderId, printHandlers);
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
            a failure — a missing printer does not un-take the money. */}
        {printReceipt.isPending ? (
          <p className="muted">Printing the receipt…</p>
        ) : receiptFailed ? (
          <p className="warn-text">The receipt didn’t print. The sale is complete — retry below when the printer is ready.</p>
        ) : (
          <PrinterStatus connected={printer.data === true} checking={printer.isLoading} />
        )}

        <div className="row">
          <button disabled={printReceipt.isPending} onClick={() => printReceipt.mutate(orderId, printHandlers)}>
            Reprint receipt
          </button>
          {/* The full record is one click away rather than something a
              cashier has to go back to the floor to find. */}
          <button onClick={() => navigate(`/orders/${orderId}/detail`)}>Order details</button>
          <button className="primary big" autoFocus onClick={() => navigate('/')}>
            Back to floor
          </button>
        </div>

        {receiptFailed && (
          <PrintDecision
            title="The receipt didn't print"
            detail={
              printer.data === false
                ? 'The receipt printer isn’t connected. The payment is recorded and the sale is complete — check the printer and retry.'
                : 'The printer didn’t accept the receipt, so nothing came out. The payment is recorded and the sale is complete — retry when it is ready.'
            }
            continueLabel="Done"
            // Money has already changed hands, so "cancel" here means a
            // refund — a manager's decision, and the server enforces
            // that whatever this screen offers.
            cancelLabel="Cancel sale (refund)"
            busy={printReceipt.isPending || refundOrder.isPending}
            onContinue={() => setReceiptFailed(false)}
            onRetry={() => printReceipt.mutate(orderId, printHandlers)}
            onCancelSale={() =>
              refundOrder.mutate(
                { orderId, reason: 'sale cancelled at the receipt' },
                { onSuccess: () => navigate('/') },
              )
            }
          />
        )}
        <ErrorBanner error={refundOrder.error} />
      </div>
    );
  }

  const waiterName = roster.data?.find((member) => member.id === detail.waiterId)?.name ?? null;
  const chosenAccount = needsAccountChoice && accountId !== '' ? accounts.find((a) => a.id === accountId) : soleAccount;

  return (
    <div className="payment-screen">
      <div className="payment-main">
        {/* Back to the order, not to the floor: the cashier came from
            the bill and the commonest reason to leave is to add the
            drink somebody forgot. The floor is one more click from
            there. */}
        <button className="ghost payment-back" onClick={() => navigate(`/orders/${orderId}`)}>
          ← Back to order
        </button>

        <div className="payment-columns">
          <div className="col">
            <div>
              <p className="page-kicker">Step 2 of 2 — take payment</p>
              <h1 style={{ margin: 0 }}>
                Order #{detail.id} · {orderTitle(detail)}
              </h1>
            </div>

            <ErrorBanner error={recordPayment.error} />

            {/* Still `.tabs` underneath: one method is selected at a
                time and the keyboard behaviour is a tab list's, however
                the cards are drawn. */}
            <div className="tabs method-cards">
              {options.data?.map((candidate) => (
                <button
                  key={candidate.paymentMethodId}
                  className={candidate.paymentMethodId === methodId ? 'active' : ''}
                  onClick={() => selectMethod(candidate.paymentMethodId)}
                >
                  <span className="method-name">{candidate.displayName}</span>
                  {/* What choosing it will involve, said before it is
                      chosen — including the methods that cannot be
                      used yet. */}
                  <span className="method-hint">{methodHint(candidate)}</span>
                </button>
              ))}
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
              <div className="card col payment-entry">
                <div className="payment-figures">
                  <div>
                    <p className="figure-label">Amount due</p>
                    <p className="figure">
                      <Money minor={balanceMinor} />
                    </p>
                    {detail.paidMinor > 0 && (
                      <p className="muted field-hint">
                        <Money minor={detail.paidMinor} /> already paid
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="amount">{isCash ? 'Cash tendered' : 'Amount'}</label>
                    <MoneyInput id="amount" valueMinor={amountMinor} onChange={setAmountMinor} />
                  </div>

                  {isCash ? (
                    <div>
                      <p className="figure-label">Change</p>
                      <p className="figure">
                        <Money minor={changeIfCash} />
                      </p>
                      {amountMinor > 0 && (
                        <p className="muted field-hint">
                          <Money minor={appliedMinor} /> applied to the bill
                        </p>
                      )}
                    </div>
                  ) : (
                    takesReference && (
                      <div>
                        <label htmlFor="reference">Reference number (optional)</label>
                        <input id="reference" value={referenceNo} onChange={(event) => setReferenceNo(event.target.value)} />
                      </div>
                    )
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

                {/* Cash and card both get "Exact amount"; only cash gets
                    the notes a customer actually hands over. */}
                <div className="row quick-amounts">
                  <button onClick={() => setAmountMinor(balanceMinor)}>Exact amount</button>
                  {isCash && <QuickCash total={balanceMinor} onPick={setAmountMinor} />}
                </div>

                <p className="muted field-hint" style={{ marginTop: 0 }}>
                  {isCash
                    ? 'Overpaying is fine — the change due is shown above and printed on the receipt.'
                    : 'Partial payments are fine — the order stays awaiting payment until they add up to the total.'}
                </p>
              </div>
            )}
          </div>

          {/* What is being paid for. The same lines and totals the bill
              printed, from the order this screen already loaded — never
              a second calculation. */}
          <BillPreview detail={detail} />
        </div>
      </div>

      <aside className="payment-rail">
        <div>
          <p className="rail-kicker">Amount due</p>
          <p className="rail-amount">
            <Money minor={balanceMinor} />
          </p>
          <hr className="rail-rule" />
          <dl className="rail-meta">
            <RailRow label="Method" value={option?.displayName ?? '—'} />
            <RailRow
              label="Account"
              value={option === undefined ? '—' : (chosenAccount?.label ?? (option.requiresAccount ? 'Not chosen' : 'Cash drawer'))}
            />
            <RailRow label="Order type" value={orderTypeLabel(detail.orderType)} />
            <RailRow label="Waiter" value={waiterName ?? '—'} />
            {isCash && <RailRow label="Change due" value={<Money minor={changeIfCash} />} accent />}
          </dl>
        </div>

        <div className="col rail-actions">
          <button className="primary big" disabled={!canRecord} onClick={submit}>
            Record payment
          </button>
          <button className="rail-secondary" onClick={() => navigate('/')}>
            Back to floor
          </button>
        </div>
      </aside>
    </div>
  );
}

/** What choosing a method will involve, in the words the cashier needs:
 * cash needs nothing, everything else needs an account it may or may not
 * have. */
function methodHint(option: PaymentOption): string {
  if (option.blockedReason) return 'No account configured';
  if (!option.requiresAccount) return 'Drawer · always available';
  return option.accounts.length === 1 ? '1 account' : `${option.accounts.length} accounts`;
}

function orderTypeLabel(orderType: string): string {
  return orderType === 'dine_in' ? 'Dine-in' : orderType === 'takeaway' ? 'Takeaway' : 'Delivery';
}

function RailRow({ label, value, accent = false }: { label: string; value: React.ReactNode; accent?: boolean }): JSX.Element {
  return (
    <div className="rail-row">
      <dt>{label}</dt>
      <dd className={accent ? 'accent' : ''}>{value}</dd>
    </div>
  );
}

/**
 * The bill as it stands, beside the money being taken for it.
 *
 * Every figure comes from the order this screen already fetched — the
 * same snapshot the bill printed from. Voided lines are left out
 * because they are not being charged for; the totals below already
 * exclude them.
 */
function BillPreview({ detail }: { detail: OrderDetail }): JSX.Element {
  const lines = detail.lines.filter((line) => !line.voided);

  return (
    <aside className="card bill-preview">
      <p className="figure-label">Bill preview</p>

      {lines.map((line) => (
        <div key={line.id} className="bill-preview-line">
          <span>
            {line.qty} × {line.itemName}
            {line.modifiers.length > 0 && <span className="muted"> · {line.modifiers.map((m) => m.modifierName).join(', ')}</span>}
          </span>
          <Money minor={line.netSalesMinor} />
        </div>
      ))}

      <div className="total-line">
        <span>Subtotal</span>
        <Money minor={detail.subtotalMinor} />
      </div>
      {detail.orderDiscountMinor > 0 && (
        <div className="total-line muted">
          <span>Discount</span>
          <Money minor={detail.orderDiscountMinor} />
        </div>
      )}
      {detail.taxMinor > 0 && (
        <div className="total-line muted">
          <span>Tax</span>
          <Money minor={detail.taxMinor} />
        </div>
      )}
      {detail.serviceChargeMinor > 0 && (
        <div className="total-line muted">
          <span>Service charge</span>
          <Money minor={detail.serviceChargeMinor} />
        </div>
      )}
      {/* Totals are worked out when the bill is finalised, so an order
          that has not been billed has none — and the server refuses to
          take money for it. Printing "Total Rs 0.00" under a real
          subtotal would read as a bug rather than as the truth. */}
      {detail.billedAt === null ? (
        <p className="muted field-hint" style={{ marginTop: 4 }}>
          Not billed yet — the total is worked out when the bill is printed.
        </p>
      ) : (
        <>
          <div className="total-line grand">
            <span>Total</span>
            <Money minor={detail.totalMinor} />
          </div>
          {detail.paidMinor > 0 && (
            <div className="total-line muted">
              <span>Already paid</span>
              <Money minor={detail.paidMinor} />
            </div>
          )}
        </>
      )}
    </aside>
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
