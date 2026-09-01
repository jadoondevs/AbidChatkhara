import { useState } from 'react';
import { useCreatePaymentMethod, usePaymentMethods, useUpdatePaymentMethod } from '../api/hooks.js';
import type { PaymentMethod, PaymentMethodKind } from '../api/types.js';
import { ErrorBanner, Loading, Modal } from '../components/ui.tsx';

const KINDS: { value: PaymentMethodKind; label: string; hint: string }[] = [
  { value: 'cash', label: 'Cash', hint: 'Handed over at the till. Needs no account.' },
  { value: 'wallet', label: 'Wallet', hint: 'Easypaisa, JazzCash and the like. Needs at least one account.' },
  { value: 'bank_transfer', label: 'Bank transfer', hint: 'Needs at least one account.' },
  { value: 'card', label: 'Card', hint: 'Needs at least one account.' },
];

const kindLabel = (kind: PaymentMethodKind): string => KINDS.find((option) => option.value === kind)?.label ?? kind;

/**
 * The ways this restaurant can be paid — the TYPES of payment, and
 * nothing else.
 *
 * "What did the customer pay with" and "where did the money go" are two
 * questions, and this screen answers only the first. An account title,
 * an account number, a bank: those belong to a payment ACCOUNT, of
 * which one method can have several (a restaurant with two Easypaisa
 * wallets has one method here and two accounts next door). They used to
 * be asked for here as well, which made a method look like an account
 * that could only ever exist once.
 */
export function PaymentMethodsPanel(): JSX.Element {
  const methods = usePaymentMethods(true);
  const updateMethod = useUpdatePaymentMethod();
  const [dialog, setDialog] = useState<{ method?: PaymentMethod } | null>(null);

  if (methods.isLoading) return <Loading />;

  return (
    <div className="col settings-panel">
      <ErrorBanner error={updateMethod.error} />
      <p className="muted" style={{ margin: 0 }}>
        What a customer can pay with. Where the money lands is configured under <strong>Payment accounts</strong>.
      </p>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {methods.data?.map((method) => (
              <tr key={method.id} className={method.active ? '' : 'muted'}>
                <td>
                  {method.displayName} <span className="muted">({method.code})</span>
                </td>
                <td>{kindLabel(method.kind)}</td>
                <td>{method.active ? 'Active' : 'Inactive'}</td>
                <td className="num">
                  <button className="ghost" onClick={() => setDialog({ method })}>
                    Edit
                  </button>
                  {/* Deactivated, never deleted: historical payments
                      name the method they were taken with. */}
                  <button
                    className="ghost"
                    disabled={updateMethod.isPending}
                    onClick={() => updateMethod.mutate({ id: method.id, active: !method.active })}
                  >
                    {method.active ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row">
        <button className="primary" onClick={() => setDialog({})}>
          Add payment method
        </button>
      </div>

      {dialog && <MethodDialog method={dialog.method} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** One dialog for adding and editing — the fields are the same, and a
 * second copy would be a second place for them to drift. */
function MethodDialog({ method, onClose }: { method?: PaymentMethod | undefined; onClose: () => void }): JSX.Element {
  const create = useCreatePaymentMethod();
  const update = useUpdatePaymentMethod();

  const [code, setCode] = useState(method?.code ?? '');
  const [displayName, setDisplayName] = useState(method?.displayName ?? '');
  const [kind, setKind] = useState<PaymentMethodKind>(method?.kind ?? 'wallet');
  const [active, setActive] = useState(method?.active ?? true);

  const editing = method !== undefined;
  const pending = create.isPending || update.isPending;
  const valid = displayName.trim() !== '' && (editing || code.trim() !== '');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || pending) return;

    if (editing) {
      update.mutate({ id: method.id, displayName: displayName.trim(), kind, active }, { onSuccess: onClose });
      return;
    }
    create.mutate({ code: code.trim(), displayName: displayName.trim(), kind }, { onSuccess: onClose });
  };

  return (
    <Modal title={editing ? `Edit ${method.displayName}` : 'Add payment method'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="col">
          <ErrorBanner error={create.error ?? update.error} />

          <div>
            <label htmlFor="pm-name">Display name</label>
            <input id="pm-name" autoFocus value={displayName} maxLength={60} onChange={(event) => setDisplayName(event.target.value)} />
            <p className="muted field-hint">What the cashier sees on the payment screen.</p>
          </div>

          <div>
            <label htmlFor="pm-code">Code</label>
            <input
              id="pm-code"
              value={code}
              maxLength={40}
              disabled={editing}
              placeholder="easypaisa"
              onChange={(event) => setCode(event.target.value)}
            />
            {/* The code is what payments and reports refer to for good,
                so it is set once and never edited — the display name is
                the part that can change. */}
            <p className="muted field-hint">
              {editing ? 'Fixed once created — historical payments refer to it.' : 'A short identifier, lower-cased. Cannot be changed later.'}
            </p>
          </div>

          <div>
            <label>Type</label>
            <div className="tabs">
              {KINDS.map((option) => (
                <button key={option.value} type="button" className={option.value === kind ? 'active' : ''} onClick={() => setKind(option.value)}>
                  {option.label}
                </button>
              ))}
            </div>
            <p className="muted field-hint">{KINDS.find((option) => option.value === kind)?.hint}</p>
          </div>

          {editing && (
            <label className="checkbox-row">
              <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
              Active — cashiers can take payments with it
            </label>
          )}

          <button className="primary big" type="submit" disabled={!valid || pending}>
            {pending ? 'Saving…' : editing ? 'Save method' : 'Add method'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
