import { format, paisa, parseRupees, toRupeeInput, type Paisa } from '@pos/shared';
import { useState, type ReactNode } from 'react';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.tsx';

/** Every error the cashier sees goes through here: a domain error (422)
 * is the server's own plain-language sentence and is shown verbatim;
 * anything else gets a short prefix so it's obvious it wasn't a rule
 * they broke. */
export function ErrorBanner({ error }: { error: unknown }): JSX.Element | null {
  if (!error) return null;
  const message =
    error instanceof ApiError
      ? error.isDomainError || error.isForbidden
        ? error.message
        : `Something went wrong: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return <div className="error">{message}</div>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): JSX.Element {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, flex: 1 }}>{title}</h2>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function PinPad({ value, onChange, maxLength = 8 }: { value: string; onChange: (next: string) => void; maxLength?: number }): JSX.Element {
  const press = (digit: string) => {
    if (value.length < maxLength) onChange(value + digit);
  };
  return (
    <div className="col">
      <div
        className="card mono"
        style={{ fontSize: 30, letterSpacing: 10, textAlign: 'center', minHeight: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        {value.replace(/./g, '•') || <span className="muted" style={{ letterSpacing: 0, fontSize: 16 }}>enter PIN</span>}
      </div>
      <div className="pinpad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <button key={digit} onClick={() => press(digit)}>
            {digit}
          </button>
        ))}
        <button className="ghost" onClick={() => onChange('')}>
          Clear
        </button>
        <button onClick={() => press('0')}>0</button>
        <button className="ghost" onClick={() => onChange(value.slice(0, -1))}>
          ⌫
        </button>
      </div>
    </div>
  );
}

/**
 * Manager approval for an action the signed-in user isn't allowed to
 * take (a line void, an order reopen). The manager authenticates just
 * long enough to authorise this one call — the till stays logged in as
 * whoever was using it, and the returned token is used for exactly one
 * request and then dropped (see AuthContext.approveAs).
 */
export function ManagerApproval({ action, onApproved, onCancel }: { action: string; onApproved: (token: string) => void; onCancel: () => void }): JSX.Element {
  const { approveAs } = useAuth();
  const [userId, setUserId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await approveAs(Number(userId), pin);
      onApproved(token);
    } catch (err) {
      setError(err);
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Manager approval — ${action}`} onClose={onCancel}>
      <ErrorBanner error={error} />
      <div className="col">
        <div>
          <label htmlFor="approval-user">Manager user id</label>
          <input id="approval-user" inputMode="numeric" value={userId} onChange={(event) => setUserId(event.target.value)} />
        </div>
        <PinPad value={pin} onChange={setPin} />
        <button className="primary big" disabled={busy || !userId || pin.length < 4} onClick={() => void submit()}>
          Approve
        </button>
      </div>
    </Modal>
  );
}

/**
 * Money input in RUPEES, held as `Paisa`. Staff type "250", the system
 * records 25000 — via the money module's own `parseRupees`, never bare
 * arithmetic here (see docs/decisions/001 and the money-arithmetic
 * guard, which scans .tsx too). The raw text is kept in local state so a
 * half-typed "250." isn't clobbered mid-keystroke; only a cleanly
 * parseable value is ever committed upward, and `isValid` lets the
 * caller keep its submit button disabled until then.
 */
export function MoneyInput({
  id,
  valueMinor,
  onChange,
  onValidityChange,
}: {
  id?: string;
  valueMinor: Paisa;
  onChange: (next: Paisa) => void;
  onValidityChange?: (valid: boolean) => void;
}): JSX.Element {
  const [text, setText] = useState(() => (valueMinor === 0 ? '' : toRupeeInput(valueMinor)));

  // Keep the visible text in step when the value is set from OUTSIDE
  // (the payment screen's "Exact total" button, an editor pre-filled
  // from a fetch) — but never while the field holds a half-typed value
  // that already means this amount, or every keystroke would fight the
  // cursor ("250." would snap back to "250.00" mid-entry).
  const parsedText = text.trim() === '' ? paisa(0) : parseRupees(text);
  if (parsedText !== valueMinor) {
    setText(valueMinor === 0 ? '' : toRupeeInput(valueMinor));
  }

  const handle = (next: string) => {
    setText(next);
    const parsed = next.trim() === '' ? paisa(0) : parseRupees(next);
    onValidityChange?.(parsed !== null);
    if (parsed !== null) onChange(parsed);
  };

  const invalid = text.trim() !== '' && parseRupees(text) === null;
  const props = id === undefined ? {} : { id };
  return (
    <input
      {...props}
      inputMode="decimal"
      placeholder="0.00"
      value={text}
      onChange={(event) => handle(event.target.value)}
      style={invalid ? { borderColor: 'var(--danger)' } : undefined}
    />
  );
}

/** Every money figure on screen goes through the money module's own
 * `format` — one formatter, server and browser alike. */
export function Money({ minor }: { minor: Paisa | null | undefined }): JSX.Element {
  if (minor === null || minor === undefined) return <span className="muted">—</span>;
  return <span className="mono">{format(minor)}</span>;
}

export function elapsedSince(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function Loading(): JSX.Element {
  return <p className="muted">Loading…</p>;
}
