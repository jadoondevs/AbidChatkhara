import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useCreatePaymentAccount,
  useCreateUser,
  usePaymentAccounts,
  usePaymentMethods,
  usePrinterSettings,
  usePrintTest,
  useSaveReceiptSettings,
  useSavePrinterSettings,
  useSaveRestaurantSettings,
  useSaveServiceChargeSettings,
  useSetUserPassword,
  useServiceChargeSettings,
  useSettings,
  useUpdatePaymentAccount,
  useUpdateUser,
  useUsers,
} from '../api/hooks.js';
import type { PaymentAccount, PrinterSettings, ReceiptSettings, RestaurantSettings, Role, ServiceChargeSettings, User } from '../api/types.js';
import { ErrorBanner, Loading, Modal, PasswordInput } from '../components/ui.tsx';
import { PaymentMethodsPanel } from './PaymentMethodConfigScreen.tsx';

type Tab = 'restaurant' | 'receipt' | 'service-charge' | 'methods' | 'accounts' | 'printer' | 'users';

const TABS: { key: Tab; label: string }[] = [
  { key: 'restaurant', label: 'Restaurant' },
  { key: 'receipt', label: 'Receipt' },
  { key: 'service-charge', label: 'Service charge' },
  { key: 'methods', label: 'Payment methods' },
  { key: 'accounts', label: 'Payment accounts' },
  { key: 'printer', label: 'Printer' },
  { key: 'users', label: 'Users' },
];

/**
 * The admin-only configuration screen: everything about THIS restaurant
 * that used to be hard-coded into a print template, fixed in the
 * server's environment, or simply not editable at all.
 *
 * The whole screen is behind an admin role gate in App.tsx, and every
 * call it makes is separately admin-checked on the server — the gate
 * exists so a manager isn't shown a screen where every button 403s, not
 * as the security boundary.
 */
export function SettingsScreen(): JSX.Element {
  const [tab, setTab] = useState<Tab>('restaurant');

  return (
    <div className="col settings">
      <div>
        <p className="page-kicker">Administration</p>
        <h1 style={{ margin: 0 }}>Settings</h1>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Everything here is specific to this restaurant. Nothing is built into the software.
      </p>

      <div className="tabs tabs-underline">
        {TABS.map((candidate) => (
          <button key={candidate.key} className={candidate.key === tab ? 'active' : ''} onClick={() => setTab(candidate.key)}>
            {candidate.label}
          </button>
        ))}
      </div>

      {/* The rest of the configuration lives on screens of its own,
          because a manager needs it and this screen is admin-only. An
          admin who came here looking for it should not have to guess
          that. */}
      <p className="muted elsewhere-note">
        Also configurable: <Link to="/config/menu">menu and prices</Link>, <Link to="/config/partners">partners and ownership</Link>, and{' '}
        <Link to="/config/people">people for staff meals</Link>.
      </p>

      {tab === 'restaurant' && <RestaurantPanel />}
      {tab === 'receipt' && <ReceiptPanel />}
      {tab === 'service-charge' && <ServiceChargePanel />}
      {tab === 'methods' && <PaymentMethodsPanel />}
      {tab === 'accounts' && <AccountsPanel />}
      {tab === 'printer' && <PrinterPanel />}
      {tab === 'users' && <UsersPanel />}
    </div>
  );
}

/** A small "Saved" acknowledgement — an admin who presses Save and sees
 * nothing happen presses it again. */
function SavedNote({ saved }: { saved: boolean }): JSX.Element | null {
  return saved ? <span className="pill ok">Saved</span> : null;
}

function RestaurantPanel(): JSX.Element {
  const settings = useSettings(true);
  const save = useSaveRestaurantSettings();
  const [draft, setDraft] = useState<RestaurantSettings | null>(null);
  const [saved, setSaved] = useState(false);

  if (settings.isLoading) return <Loading />;
  if (settings.error) return <ErrorBanner error={settings.error} />;
  const current = draft ?? settings.data?.restaurant;
  if (!current) return <Loading />;

  const field = (key: keyof RestaurantSettings, label: string, hint?: string) => (
    <div>
      <label htmlFor={`restaurant-${key}`}>{label}</label>
      <input
        id={`restaurant-${key}`}
        value={current[key]}
        onChange={(event) => {
          setSaved(false);
          setDraft({ ...current, [key]: event.target.value });
        }}
      />
      {hint && <p className="muted field-hint">{hint}</p>}
    </div>
  );

  return (
    <div className="card col settings-panel">
      <ErrorBanner error={save.error} />
      {field('name', 'Restaurant name', 'Shown at the top of every bill and receipt, and in this app’s header.')}
      {field('addressLine1', 'Address line 1')}
      {field('addressLine2', 'Address line 2')}
      {field('phone', 'Phone number')}
      {field('registrationLine', 'Registration line', 'An NTN, STRN or licence number, if your receipts must show one.')}

      <div className="row">
        <button className="primary" disabled={save.isPending} onClick={() => save.mutate(current, { onSuccess: () => setSaved(true) })}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <SavedNote saved={saved} />
      </div>
    </div>
  );
}

function ReceiptPanel(): JSX.Element {
  const settings = useSettings(true);
  const save = useSaveReceiptSettings();
  const [draft, setDraft] = useState<ReceiptSettings | null>(null);
  const [saved, setSaved] = useState(false);

  if (settings.isLoading) return <Loading />;
  if (settings.error) return <ErrorBanner error={settings.error} />;
  const current = draft ?? settings.data?.receipt;
  if (!current) return <Loading />;

  const update = (patch: Partial<ReceiptSettings>) => {
    setSaved(false);
    setDraft({ ...current, ...patch });
  };

  const toggle = (key: keyof ReceiptSettings, label: string) => (
    <label key={key} className="checkbox-row">
      <input type="checkbox" checked={current[key] as boolean} onChange={(event) => update({ [key]: event.target.checked })} />
      {label}
    </label>
  );

  return (
    <div className="card col settings-panel">
      <ErrorBanner error={save.error} />

      <h3 style={{ margin: 0 }}>Header</h3>
      <div>
        <label htmlFor="receipt-headerName">Name on the receipt</label>
        <input id="receipt-headerName" value={current.headerName} onChange={(event) => update({ headerName: event.target.value })} />
        <p className="muted field-hint">Leave blank to use the restaurant name.</p>
      </div>
      <div>
        <label htmlFor="receipt-headerNote">Extra header line</label>
        <input id="receipt-headerNote" value={current.headerNote} onChange={(event) => update({ headerNote: event.target.value })} />
      </div>

      <h3 style={{ margin: 0 }}>What to print</h3>
      <div className="checkbox-grid">
        {toggle('showAddress', 'Address')}
        {toggle('showPhone', 'Phone number')}
        {toggle('showOrderNumber', 'Order number')}
        {toggle('showTable', 'Table')}
        {toggle('showWaiter', 'Waiter')}
        {toggle('showPaymentAccounts', 'Payment accounts on the bill')}
      </div>

      <h3 style={{ margin: 0 }}>Footer</h3>
      <div>
        <label htmlFor="receipt-footerMessage">Footer message</label>
        <input id="receipt-footerMessage" value={current.footerMessage} onChange={(event) => update({ footerMessage: event.target.value })} />
      </div>
      <div>
        <label htmlFor="receipt-footerNote">Extra footer line</label>
        <input id="receipt-footerNote" value={current.footerNote} onChange={(event) => update({ footerNote: event.target.value })} />
      </div>
      <div style={{ maxWidth: 200 }}>
        <label htmlFor="receipt-feedLines">Blank lines before the cut</label>
        <input
          id="receipt-feedLines"
          inputMode="numeric"
          value={String(current.feedLines)}
          onChange={(event) => update({ feedLines: Math.min(10, Math.max(0, Number(event.target.value.replace(/[^0-9]/g, '') || 0))) })}
        />
        <p className="muted field-hint">Raise this if the tear bar cuts through the last line.</p>
      </div>

      <div className="row">
        <button className="primary" disabled={save.isPending} onClick={() => save.mutate(current, { onSuccess: () => setSaved(true) })}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <SavedNote saved={saved} />
      </div>
    </div>
  );
}

/**
 * Service charge, in one place.
 *
 * The rate set here is what the bill screen previews, what the receipt
 * prints, what the reports total and what the waiter payout sheet
 * divides — there is one calculation on the server and this panel is
 * its only input (see `computeServiceCharge`). Switching it off makes
 * it zero everywhere at once rather than leaving it applied on some
 * screens.
 *
 * Changing the rate does NOT rewrite history: every order records the
 * rate that produced its own charge, so a bill taken while the rate was
 * 5% still reads 5% after this panel is set to 10%.
 */
function ServiceChargePanel(): JSX.Element {
  const current = useServiceChargeSettings();
  const save = useSaveServiceChargeSettings();
  const [draft, setDraft] = useState<ServiceChargeSettings | null>(null);
  const [saved, setSaved] = useState(false);

  if (current.isLoading) return <Loading />;
  if (current.error) return <ErrorBanner error={current.error} />;
  const config = draft ?? current.data;
  if (!config) return <Loading />;

  const update = (patch: Partial<ServiceChargeSettings>) => {
    setSaved(false);
    setDraft({ ...config, ...patch });
  };

  // Basis points on the wire, percent in the box: an admin thinks in
  // "5%", and the server stores 500 so a half-percent is expressible
  // without a float ever touching money.
  const percentText = (config.rateBp / 100).toString();

  return (
    <div className="card col settings-panel">
      <ErrorBanner error={save.error} />

      <label className="checkbox-row">
        <input type="checkbox" checked={config.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
        Charge a service charge
      </label>
      <p className="muted field-hint" style={{ marginTop: 0 }}>
        Switched off, no bill carries one and the figure is zero on every report. Orders already billed keep the charge they were billed with.
      </p>

      <div style={{ maxWidth: 200 }}>
        <label htmlFor="sc-rate">Rate (%)</label>
        <input
          id="sc-rate"
          inputMode="decimal"
          disabled={!config.enabled}
          value={percentText}
          onChange={(event) => {
            // Only digits and one dot, then to basis points — 5.5%
            // becomes 550, and anything above 50% is refused by the
            // server anyway.
            const cleaned = event.target.value.replace(/[^0-9.]/g, '');
            const percent = Number(cleaned === '' || cleaned === '.' ? 0 : cleaned);
            if (!Number.isFinite(percent)) return;
            update({ rateBp: Math.min(5000, Math.max(0, Math.round(percent * 100))) });
          }}
        />
        <p className="muted field-hint">Applied to net sales, after any discount.</p>
      </div>

      <div>
        <label htmlFor="sc-name">Name on the bill</label>
        <input
          id="sc-name"
          maxLength={40}
          disabled={!config.enabled}
          value={config.displayName}
          onChange={(event) => update({ displayName: event.target.value })}
        />
        <p className="muted field-hint">What the customer reads — “Service charge”, “Service fee”, or your own wording.</p>
      </div>

      <label className="checkbox-row">
        <input
          type="checkbox"
          disabled={!config.enabled}
          checked={config.dineInOnly}
          onChange={(event) => update({ dineInOnly: event.target.checked })}
        />
        Dine-in only
      </label>
      <p className="muted field-hint" style={{ marginTop: 0 }}>
        A takeaway or delivery order has no table to serve, so it carries no charge. Staff and owner meals never do either way.
      </p>

      <div className="row">
        <button
          className="primary"
          disabled={save.isPending || (config.enabled && config.displayName.trim() === '')}
          onClick={() => save.mutate({ ...config, displayName: config.displayName.trim() }, { onSuccess: () => setSaved(true) })}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <SavedNote saved={saved} />
      </div>
    </div>
  );
}

function PrinterPanel(): JSX.Element {
  const printer = usePrinterSettings(true);
  const save = useSavePrinterSettings();
  const testPrint = usePrintTest();
  const [draft, setDraft] = useState<PrinterSettings | null>(null);
  const [saved, setSaved] = useState(false);

  if (printer.isLoading) return <Loading />;
  if (printer.error) return <ErrorBanner error={printer.error} />;
  const current = draft ?? printer.data;
  if (!current) return <Loading />;

  const update = (patch: Partial<PrinterSettings>) => {
    setSaved(false);
    setDraft({ ...current, ...patch });
  };

  return (
    <div className="card col settings-panel">
      <ErrorBanner error={save.error} />

      {/* Configuring a printer is optional, and a till with none is a
          supported setup — not a broken one. Saying so here is what
          stops an operator hunting for a fault that isn't there. */}
      <div className={current.host.trim() === '' ? 'blocked-notice info' : 'blocked-notice ok'}>
        <strong>
          {current.host.trim() === ''
            ? 'No POS printer configured — receipts use Windows printing.'
            : `Receipts print directly to ${current.host.trim()}:${current.port}.`}
        </strong>
        <p className="muted">
          {current.host.trim() === ''
            ? 'Printing opens the normal Windows print dialog, where you can choose any installed printer or Microsoft Print to PDF. Set an address below to print straight to a thermal POS printer instead.'
            : 'If that printer cannot be reached, printing falls back to the Windows print dialog rather than failing.'}
        </p>
      </div>

      <div>
        <label htmlFor="printer-host">Printer address (optional)</label>
        <input id="printer-host" value={current.host} onChange={(event) => update({ host: event.target.value })} placeholder="e.g. 192.168.1.50" />
        <p className="muted field-hint">
          The receipt printer’s address on the restaurant’s own network. Leave blank to use whatever the server was started with
          (POS_PRINTER_HOST), or to print through Windows.
        </p>
      </div>

      <div style={{ maxWidth: 200 }}>
        <label htmlFor="printer-port">Port</label>
        <input
          id="printer-port"
          inputMode="numeric"
          value={String(current.port)}
          onChange={(event) => update({ port: Math.min(65535, Math.max(1, Number(event.target.value.replace(/[^0-9]/g, '') || 1))) })}
        />
        <p className="muted field-hint">9100 unless your printer’s manual says otherwise.</p>
      </div>

      {/* Darkness is a property of the printer, not of the text. This
          is the only way to make ORDINARY receipt lines dark without
          emphasising every one of them, which would leave a receipt
          with no difference between a total and the line above it. */}
      <div style={{ maxWidth: 320 }}>
        <label htmlFor="printer-density">Print darkness</label>
        <select
          id="printer-density"
          value={current.densityLevel}
          onChange={(event) => update({ densityLevel: Number(event.target.value) })}
        >
          <option value={0}>Use the printer’s own setting</option>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((level) => (
            <option key={level} value={level}>
              Level {level}
              {level === 5 ? ' (default)' : ''}
              {level === 8 ? ' (darkest)' : ''}
            </option>
          ))}
        </select>
        <p className="muted field-hint">
          Raise this if ordinary receipt text prints grey. Print the test strip below, look at the paper, and adjust — the printer is the
          only thing that can answer this. Some printers ignore the command entirely; if the test strip does not change between levels,
          set the darkness in the printer’s own configuration utility instead.
        </p>
      </div>

      <div className="row">
        <button disabled={testPrint.isPending} onClick={() => testPrint.mutate()}>
          {testPrint.isPending ? 'Printing…' : 'Print test strip'}
        </button>
        {testPrint.data === 'thermal' && <span className="pill ok">Sent to the printer</span>}
        {testPrint.data === 'fallback' && <span className="muted">No POS printer — sent to Windows printing</span>}
      </div>
      <ErrorBanner error={testPrint.error} />
      <p className="muted field-hint" style={{ marginTop: 0 }}>
        The strip prints one block of ordinary text and one emphasised block. Ordinary text must be readable; the emphasised block must be
        visibly heavier. Save any change above before printing it.
      </p>

      <label className="checkbox-row">
        <input type="checkbox" checked={current.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
        Printing enabled
      </label>
      <p className="muted field-hint">
        Turn this off while the printer is away for repair: printing then goes straight to the Windows dialog instead of every receipt
        waiting on a connection that will never answer.
      </p>

      <div className="row">
        <button className="primary" disabled={save.isPending} onClick={() => save.mutate(current, { onSuccess: () => setSaved(true) })}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <SavedNote saved={saved} />
      </div>
    </div>
  );
}

/**
 * Easypaisa wallets and bank accounts money can actually arrive in. A
 * payment records which one it landed in, so an account is deactivated
 * rather than deleted — deleting one would orphan that answer on every
 * historical payment.
 */
/**
 * The Easypaisa wallets and bank accounts money can actually arrive in.
 *
 * A non-cash payment cannot be taken at all until at least one active
 * account exists for its method, so this screen is the difference
 * between a cashier being able to accept a transfer and not. It says so
 * where an account list is empty, rather than leaving them to discover
 * it at the till.
 *
 * Accounts are deactivated, never deleted: a `payment` references the
 * one it landed in, and deleting it would orphan that answer on every
 * historical payment.
 */
function AccountsPanel(): JSX.Element {
  const methods = usePaymentMethods();
  const accounts = usePaymentAccounts(undefined, true);
  const update = useUpdatePaymentAccount();

  const [adding, setAdding] = useState<number | null>(null);
  const [editing, setEditing] = useState<PaymentAccount | null>(null);

  // Cash is handed over at the till — there is no account for it to
  // arrive in, so it gets no section here.
  const eligible = (methods.data ?? []).filter((method) => method.kind !== 'cash');

  if (methods.isLoading || accounts.isLoading) return <Loading />;

  return (
    <div className="card col settings-panel accounts-panel">
      <ErrorBanner error={update.error} />
      <p className="muted" style={{ marginTop: 0 }}>
        Where the money actually goes. Easypaisa and bank payments must say which account received them, so each method below needs at
        least one active account before a cashier can accept it.
      </p>

      {eligible.map((method) => {
        const forMethod = (accounts.data ?? []).filter((account) => account.paymentMethodId === method.id);
        const active = forMethod.filter((account) => account.active);
        return (
          <section key={method.id} className="account-group">
            <div className="row">
              <h3 style={{ margin: 0, flex: 1 }}>{method.displayName}</h3>
              <button className="primary" onClick={() => setAdding(method.id)}>
                Add account
              </button>
            </div>

            {active.length === 0 && (
              <div className="blocked-notice">
                <strong>No active {method.displayName} account.</strong>
                <p className="muted">Cashiers cannot accept {method.displayName} payments until one is added here.</p>
              </div>
            )}

            {forMethod.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Account</th>
                    <th>Status</th>
                    <th>Prints on receipt</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {forMethod.map((account) => (
                    <tr key={account.id} className={account.active ? '' : 'muted'}>
                      <td>{account.label}</td>
                      <td>
                        {account.accountNumber ?? '—'}
                        {account.bankName && <span className="muted"> · {account.bankName}</span>}
                      </td>
                      <td>{account.active ? 'Active' : 'Inactive'}</td>
                      <td>
                        {/* Independent of Active: an account can take
                            money without being advertised on a ticket,
                            and hiding it must not stop the till using
                            it. */}
                        <button
                          className="ghost"
                          disabled={update.isPending}
                          onClick={() => update.mutate({ id: account.id, printOnReceipt: !account.printOnReceipt })}
                        >
                          {account.printOnReceipt ? 'Yes' : 'No'}
                        </button>
                      </td>
                      <td className="num">
                        <button className="ghost" onClick={() => setEditing(account)}>
                          Edit
                        </button>
                        <button
                          className="ghost"
                          disabled={update.isPending}
                          onClick={() => update.mutate({ id: account.id, active: !account.active })}
                        >
                          {account.active ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}

      {eligible.length === 0 && <p className="muted">No payment methods need an account — only cash is configured.</p>}

      {adding !== null && (
        <AccountDialog
          methodId={adding}
          methodName={eligible.find((method) => method.id === adding)?.displayName ?? 'account'}
          isBank={eligible.find((method) => method.id === adding)?.kind === 'bank_transfer'}
          onClose={() => setAdding(null)}
        />
      )}
      {editing && (
        <AccountDialog
          account={editing}
          methodId={editing.paymentMethodId}
          methodName={eligible.find((method) => method.id === editing.paymentMethodId)?.displayName ?? 'account'}
          isBank={editing.accountType === 'bank'}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** One dialog for adding and editing — the fields are identical, and a
 * second copy would be a second place for them to drift. */
function AccountDialog({
  account,
  methodId,
  methodName,
  isBank,
  onClose,
}: {
  account?: PaymentAccount;
  methodId: number;
  methodName: string;
  isBank: boolean;
  onClose: () => void;
}): JSX.Element {
  const create = useCreatePaymentAccount();
  const update = useUpdatePaymentAccount();

  const [label, setLabel] = useState(account?.label ?? '');
  const [accountTitle, setAccountTitle] = useState(account?.accountTitle ?? '');
  const [accountNumber, setAccountNumber] = useState(account?.accountNumber ?? '');
  const [bankName, setBankName] = useState(account?.bankName ?? '');
  const [printOnReceipt, setPrintOnReceipt] = useState(account?.printOnReceipt ?? true);

  const pending = create.isPending || update.isPending;
  const valid = label.trim() !== '';

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || pending) return;
    const fields = {
      label: label.trim(),
      accountTitle: accountTitle.trim(),
      accountNumber: accountNumber.trim(),
      ...(isBank ? { bankName: bankName.trim() } : {}),
      printOnReceipt,
    };
    if (account) update.mutate({ id: account.id, ...fields }, { onSuccess: onClose });
    else create.mutate({ paymentMethodId: methodId, ...fields }, { onSuccess: onClose });
  };

  return (
    <Modal title={account ? `Edit ${account.label}` : `Add ${methodName} account`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="col">
          <ErrorBanner error={create.error ?? update.error} />
          <div>
            <label htmlFor="account-label">Name</label>
            <input
              id="account-label"
              autoFocus
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={isBank ? 'HBL current' : 'Counter wallet'}
            />
            <p className="muted field-hint">What a cashier picks from a list — keep it short and unambiguous.</p>
          </div>
          <div>
            <label htmlFor="account-title">Account title</label>
            <input id="account-title" value={accountTitle} onChange={(event) => setAccountTitle(event.target.value)} />
          </div>
          <div>
            <label htmlFor="account-number">{isBank ? 'Account number / IBAN' : 'Mobile number'}</label>
            <input id="account-number" value={accountNumber} onChange={(event) => setAccountNumber(event.target.value)} />
            <p className="muted field-hint">Only the last four digits are printed on a receipt.</p>
          </div>
          {isBank && (
            <div>
              <label htmlFor="account-bank">Bank name</label>
              <input id="account-bank" value={bankName} onChange={(event) => setBankName(event.target.value)} />
            </div>
          )}

          {/* Separate from whether the account is active: a live
              account the restaurant would rather not advertise is a
              real case, and it had no way to be expressed before. */}
          <label className="checkbox-row">
            <input type="checkbox" checked={printOnReceipt} onChange={(event) => setPrintOnReceipt(event.target.checked)} />
            Print these details on bills, so customers can pay into it
          </label>

          <button className="primary big" type="submit" disabled={!valid || pending}>
            {pending ? 'Saving…' : account ? 'Save' : 'Add account'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const ROLES: Role[] = ['server', 'cashier', 'manager', 'admin'];

/**
 * Application login accounts — deliberately NOT the same thing as the
 * People screen.
 *
 * A `person` is someone whose meals the restaurant tracks: a cook who
 * never touches the till, a partner who eats here. A `user` is someone
 * who signs in. Merging them would give every cook a password and every
 * terminal user a meal policy, and neither is true. They are kept
 * separate, as they always have been.
 */
function UsersPanel(): JSX.Element {
  const users = useUsers(true);
  const create = useCreateUser();
  const update = useUpdateUser();
  const setPassword = useSetUserPassword();

  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const [editing, setEditing] = useState<User | null>(null);

  return (
    <div className="card col settings-panel">
      <p className="muted" style={{ margin: 0 }}>
        Accounts that sign in to this till. Not the same as <Link to="/config/people">People</Link> (whose meals are tracked) or{' '}
        <Link to="/config/partners">Partners</Link> (who own menu items) — a cook can be a person without ever having a login.
      </p>
      <ErrorBanner error={update.error} />

      <div className="row">
        <h3 style={{ margin: 0, flex: 1 }}>Login accounts</h3>
        <button className="primary" onClick={() => setAdding(true)}>
          Add user
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        These are the accounts that sign in to this POS. Staff whose meals you track live on the People screen — the two are separate on
        purpose.
      </p>

      {users.isLoading && <Loading />}

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Username</th>
            <th>Role</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.data?.map((user) => (
            <tr key={user.id} className={user.active ? '' : 'muted'}>
              <td>{user.name}</td>
              <td className="mono">{user.username}</td>
              <td>{user.role}</td>
              <td>{user.active ? 'Active' : 'Inactive'}</td>
              <td className="num">
                <button className="ghost" onClick={() => setEditing(user)}>
                  Edit
                </button>
                <button className="ghost" onClick={() => setResetting(user)}>
                  Reset password
                </button>
                <button className="ghost" onClick={() => update.mutate({ id: user.id, active: !user.active })}>
                  {user.active ? 'Deactivate' : 'Reactivate'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {adding && <AddUserDialog onClose={() => setAdding(false)} />}
      {editing && <EditUserDialog user={editing} onClose={() => setEditing(null)} />}
      {resetting && (
        <ResetPasswordDialog
          user={resetting}
          pending={setPassword.isPending}
          error={setPassword.error}
          onSubmit={(password) => setPassword.mutate({ id: resetting.id, password }, { onSuccess: () => setResetting(null) })}
          onClose={() => setResetting(null)}
        />
      )}
      <ErrorBanner error={create.error} />
    </div>
  );
}

function AddUserDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const create = useCreateUser();
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('server');

  const valid = name.trim() !== '' && username.trim().length >= 3 && password.length >= 4;

  return (
    <Modal title="Add user" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          create.mutate({ name: name.trim(), username: username.trim(), password, role }, { onSuccess: onClose });
        }}
      >
        <div className="col">
          <ErrorBanner error={create.error} />
          <div>
            <label htmlFor="user-name">Name</label>
            <input id="user-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div>
            <label htmlFor="user-username">Username</label>
            <input
              id="user-username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <p className="muted field-hint">Letters, digits, dot, dash or underscore. This is what they type to sign in.</p>
          </div>
          <div>
            <label htmlFor="user-password">Password</label>
            <PasswordInput id="user-password" value={password} onChange={setPassword} autoComplete="new-password" />
            <p className="muted field-hint">At least 4 characters. A short numeric PIN still works if that suits your staff.</p>
          </div>
          <div>
            <label htmlFor="user-role">Role</label>
            <select id="user-role" value={role} onChange={(event) => setRole(event.target.value as Role)}>
              {ROLES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
          </div>
          <button className="primary big" type="submit" disabled={!valid || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create user'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditUserDialog({ user, onClose }: { user: User; onClose: () => void }): JSX.Element {
  const update = useUpdateUser();
  const [name, setName] = useState(user.name);
  const [username, setUsername] = useState(user.username);
  const [role, setRole] = useState<Role>(user.role);

  const valid = name.trim() !== '' && username.trim().length >= 3;

  return (
    <Modal title={`Edit ${user.name}`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          update.mutate({ id: user.id, name: name.trim(), username: username.trim(), role }, { onSuccess: onClose });
        }}
      >
        <div className="col">
          <ErrorBanner error={update.error} />
          <div>
            <label htmlFor="edit-name">Name</label>
            <input id="edit-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div>
            <label htmlFor="edit-username">Username</label>
            <input
              id="edit-username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="edit-role">Role</label>
            <select id="edit-role" value={role} onChange={(event) => setRole(event.target.value as Role)}>
              {ROLES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
          </div>
          <button className="primary big" type="submit" disabled={!valid || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordDialog({
  user,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  user: User;
  pending: boolean;
  error: unknown;
  onSubmit: (password: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const mismatch = confirm !== '' && confirm !== password;
  const valid = password.length >= 4 && confirm === password;

  return (
    <Modal title={`Reset password — ${user.name}`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onSubmit(password);
        }}
      >
        <div className="col">
          <ErrorBanner error={error} />
          <div>
            <label htmlFor="reset-password">New password</label>
            <PasswordInput id="reset-password" autoFocus value={password} onChange={setPassword} autoComplete="new-password" />
          </div>
          <div>
            <label htmlFor="reset-confirm">Confirm</label>
            <PasswordInput id="reset-confirm" value={confirm} onChange={setConfirm} autoComplete="new-password" />
            {mismatch && <p className="muted field-hint">The two passwords don’t match.</p>}
          </div>
          <button className="primary big" type="submit" disabled={!valid || pending}>
            {pending ? 'Saving…' : 'Set password'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
