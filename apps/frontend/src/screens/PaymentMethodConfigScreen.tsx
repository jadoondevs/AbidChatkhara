import { useState } from 'react';
import { useCreatePaymentMethod, usePaymentMethods, useUpdatePaymentMethod } from '../api/hooks.js';
import type { PaymentMethodKind } from '../api/types.js';
import { ErrorBanner, Loading } from '../components/ui.tsx';

/**
 * The ways this restaurant can be paid: display name, kind, and the
 * account details that print on the bill's payment-options block.
 *
 * A panel rather than a screen, and it lives in Settings beside the
 * accounts those methods receive money into. Two separate places to
 * configure payment — a top-level screen AND a Settings tab — was one
 * place too many, and the wrong one was the one that broke.
 */
export function PaymentMethodsPanel(): JSX.Element {
  const methods = usePaymentMethods(true);
  const createMethod = useCreatePaymentMethod();
  const updateMethod = useUpdatePaymentMethod();

  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [kind, setKind] = useState<PaymentMethodKind>('cash');
  const [printOnBill, setPrintOnBill] = useState(false);
  const [accountTitle, setAccountTitle] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [bankName, setBankName] = useState('');

  const submit = () => {
    createMethod.mutate(
      {
        code: code.trim(),
        displayName: displayName.trim(),
        kind,
        printOnBill,
        ...(accountTitle.trim() ? { accountTitle: accountTitle.trim() } : {}),
        ...(accountNumber.trim() ? { accountNumber: accountNumber.trim() } : {}),
        ...(bankName.trim() ? { bankName: bankName.trim() } : {}),
      },
      {
        onSuccess: () => {
          setCode('');
          setDisplayName('');
          setAccountTitle('');
          setAccountNumber('');
          setBankName('');
          setPrintOnBill(false);
        },
      },
    );
  };

  return (
    <div className="col settings-panel">
      <ErrorBanner error={createMethod.error ?? updateMethod.error} />

      <div className="card">
        {methods.isLoading && <Loading />}
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Prints on bill</th>
              <th>Account</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {methods.data?.map((method) => (
              <tr key={method.id}>
                <td>{method.displayName}</td>
                <td className="muted">{method.kind.replace('_', ' ')}</td>
                <td>
                  <button onClick={() => updateMethod.mutate({ id: method.id, printOnBill: !method.printOnBill })}>
                    {method.printOnBill ? 'Yes' : 'No'}
                  </button>
                </td>
                <td className="muted">
                  {method.accountTitle ?? '—'}
                  {method.accountNumber ? ` · ${method.accountNumber}` : ''}
                  {method.bankName ? ` · ${method.bankName}` : ''}
                </td>
                <td>
                  <button onClick={() => updateMethod.mutate({ id: method.id, active: !method.active })}>
                    {method.active ? 'Active' : 'Inactive'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card col" style={{ maxWidth: 620 }}>
        <h3 style={{ margin: 0 }}>Add a method</h3>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label htmlFor="pm-code">Code</label>
            <input id="pm-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="easypaisa" />
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor="pm-name">Display name</label>
            <input id="pm-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Easypaisa" />
          </div>
        </div>

        <div>
          <label>Kind</label>
          <div className="tabs">
            {(['cash', 'wallet', 'bank_transfer', 'card'] as const).map((option) => (
              <button key={option} className={option === kind ? 'active' : ''} onClick={() => setKind(option)}>
                {option.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>

        <div className="row">
          <button className={printOnBill ? 'active' : ''} onClick={() => setPrintOnBill((current) => !current)}>
            {printOnBill ? 'Prints on bill ✓' : 'Print on bill?'}
          </button>
        </div>

        <div className="row">
          <div style={{ flex: 1 }}>
            <label htmlFor="pm-title">Account title</label>
            <input id="pm-title" value={accountTitle} onChange={(event) => setAccountTitle(event.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor="pm-number">Account number</label>
            <input id="pm-number" value={accountNumber} onChange={(event) => setAccountNumber(event.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor="pm-bank">Bank</label>
            <input id="pm-bank" value={bankName} onChange={(event) => setBankName(event.target.value)} />
          </div>
        </div>

        {/* The code is the method's stable identifier: payments and
            reports refer to it, so it is lower-cased and checked for a
            clash on the server rather than being free text. */}
        <p className="muted field-hint" style={{ margin: 0 }}>
          The code identifies this method for good — “easypaisa”, “bank”. The display name is what the cashier sees and can change later.
        </p>
        <button className="primary" disabled={!code.trim() || !displayName.trim() || createMethod.isPending} onClick={submit}>
          Add method
        </button>
      </div>
    </div>
  );
}
