import { useState } from 'react';
import {
  useCreatePaymentAccount,
  useCreateUser,
  usePaymentAccounts,
  usePaymentMethods,
  usePrinterSettings,
  useSaveReceiptSettings,
  useSavePrinterSettings,
  useSaveRestaurantSettings,
  useSetUserPassword,
  useSettings,
  useUpdatePaymentAccount,
  useUpdateUser,
  useUsers,
} from '../api/hooks.js';
import type { PaymentAccount, PrinterSettings, ReceiptSettings, RestaurantSettings, Role, User } from '../api/types.js';
import { ErrorBanner, Loading, Modal, PasswordInput } from '../components/ui.tsx';

type Tab = 'restaurant' | 'receipt' | 'accounts' | 'printer' | 'users';

const TABS: { key: Tab; label: string }[] = [
  { key: 'restaurant', label: 'Restaurant' },
  { key: 'receipt', label: 'Receipt' },
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
      <h1 style={{ margin: 0 }}>Settings</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Everything here is specific to this restaurant. Nothing is built into the software.
      </p>

      <div className="tabs">
        {TABS.map((candidate) => (
          <button key={candidate.key} className={candidate.key === tab ? 'active' : ''} onClick={() => setTab(candidate.key)}>
            {candidate.label}
          </button>
        ))}
      </div>

      {tab === 'restaurant' && <RestaurantPanel />}
      {tab === 'receipt' && <ReceiptPanel />}
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

function PrinterPanel(): JSX.Element {
  const printer = usePrinterSettings(true);
  const save = useSavePrinterSettings();
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

      <div>
        <label htmlFor="printer-host">Printer address</label>
        <input id="printer-host" value={current.host} onChange={(event) => update({ host: event.target.value })} placeholder="e.g. 192.168.1.50" />
        <p className="muted field-hint">
          The receipt printer’s address on the restaurant’s own network. Leave blank to use whatever the server was started with
          (POS_PRINTER_HOST).
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

      <label className="checkbox-row">
        <input type="checkbox" checked={current.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
        Printing enabled
      </label>
      <p className="muted field-hint">
        Turn this off while the printer is away for repair: printing then fails immediately with a clear message instead of every bill
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
function AccountsPanel(): JSX.Element {
  const methods = usePaymentMethods();
  const accounts = usePaymentAccounts(undefined, true);
  const create = useCreatePaymentAccount();
  const update = useUpdatePaymentAccount();

  const [adding, setAdding] = useState(false);
  const [paymentMethodId, setPaymentMethodId] = useState<number | ''>('');
  const [label, setLabel] = useState('');
  const [accountTitle, setAccountTitle] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [bankName, setBankName] = useState('');

  // Cash has no account to arrive in, so it is not offered.
  const eligible = (methods.data ?? []).filter((method) => method.kind !== 'cash');

  const reset = () => {
    setAdding(false);
    setPaymentMethodId('');
    setLabel('');
    setAccountTitle('');
    setAccountNumber('');
    setBankName('');
  };

  const methodName = (id: number) => methods.data?.find((method) => method.id === id)?.displayName ?? `method ${id}`;
  const isBank = eligible.find((method) => method.id === paymentMethodId)?.kind === 'bank_transfer';

  return (
    <div className="card col settings-panel">
      <ErrorBanner error={create.error ?? update.error} />

      <div className="row">
        <h3 style={{ margin: 0, flex: 1 }}>Accounts</h3>
        <button className="primary" onClick={() => setAdding(true)}>
          Add account
        </button>
      </div>

      {accounts.isLoading && <Loading />}
      {accounts.data?.length === 0 && <p className="muted">No accounts configured yet. Add one so cashiers can record where a transfer landed.</p>}

      <table>
        <thead>
          <tr>
            <th>Label</th>
            <th>Method</th>
            <th>Account</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {accounts.data?.map((account: PaymentAccount) => (
            <tr key={account.id} className={account.active ? '' : 'muted'}>
              <td>{account.label}</td>
              <td>{methodName(account.paymentMethodId)}</td>
              <td>
                {account.accountNumber ?? '—'}
                {account.bankName && <span className="muted"> · {account.bankName}</span>}
              </td>
              <td>{account.active ? 'Active' : 'Inactive'}</td>
              <td className="num">
                <button className="ghost" onClick={() => update.mutate({ id: account.id, active: !account.active })}>
                  {account.active ? 'Deactivate' : 'Reactivate'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {adding && (
        <Modal title="Add payment account" onClose={reset}>
          <div className="col">
            <ErrorBanner error={create.error} />
            <div>
              <label htmlFor="account-method">Payment method</label>
              <select
                id="account-method"
                value={paymentMethodId}
                onChange={(event) => setPaymentMethodId(event.target.value === '' ? '' : Number(event.target.value))}
              >
                <option value="">Select…</option>
                {eligible.map((method) => (
                  <option key={method.id} value={method.id}>
                    {method.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="account-label">Label</label>
              <input id="account-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Counter wallet" />
              <p className="muted field-hint">What a cashier picks from a list — keep it short and unambiguous.</p>
            </div>
            <div>
              <label htmlFor="account-title">Account title</label>
              <input id="account-title" value={accountTitle} onChange={(event) => setAccountTitle(event.target.value)} />
            </div>
            <div>
              <label htmlFor="account-number">Account number / IBAN</label>
              <input id="account-number" value={accountNumber} onChange={(event) => setAccountNumber(event.target.value)} />
            </div>
            {isBank && (
              <div>
                <label htmlFor="account-bank">Bank name</label>
                <input id="account-bank" value={bankName} onChange={(event) => setBankName(event.target.value)} />
              </div>
            )}
            <button
              className="primary big"
              disabled={create.isPending || paymentMethodId === '' || !label.trim()}
              onClick={() =>
                create.mutate(
                  {
                    paymentMethodId: Number(paymentMethodId),
                    label: label.trim(),
                    ...(accountTitle.trim() ? { accountTitle: accountTitle.trim() } : {}),
                    ...(accountNumber.trim() ? { accountNumber: accountNumber.trim() } : {}),
                    ...(bankName.trim() ? { bankName: bankName.trim() } : {}),
                  },
                  { onSuccess: reset },
                )
              }
            >
              Add account
            </button>
          </div>
        </Modal>
      )}
    </div>
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
