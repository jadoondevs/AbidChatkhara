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

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** For a dialog that carries a whole panel — the bill — rather than
   * one question. It scrolls either way; this only stops the content
   * being squeezed into a column narrower than it reads well in. */
  wide?: boolean;
}): JSX.Element {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} onClick={(event) => event.stopPropagation()}>
        {/* A dialog whose content carries its own heading passes an
            empty title rather than repeating it — the close control
            still needs somewhere to live. */}
        <div className={`row modal-header${title ? '' : ' modal-header-bare'}`}>
          {title && <h2 style={{ margin: 0, flex: 1 }}>{title}</h2>}
          <span style={{ flex: 1 }} />
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * A masked field with a show/hide toggle, for a PC keyboard.
 *
 * This replaced the on-screen PIN pad: staff type their password on the
 * keyboard in front of them, and the toggle exists because a mistyped
 * password on a till behind a counter is far more likely than someone
 * reading it over the cashier's shoulder — and a cashier who cannot see
 * what they typed just retries blindly. It always starts masked.
 */
export function PasswordInput({
  id,
  name,
  value,
  onChange,
  autoComplete,
  autoFocus,
  placeholder,
}: {
  id?: string;
  name?: string;
  value: string;
  onChange: (next: string) => void;
  autoComplete?: string;
  autoFocus?: boolean;
  placeholder?: string;
}): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="password-field">
      <input
        {...(id === undefined ? {} : { id })}
        {...(name === undefined ? {} : { name })}
        {...(autoComplete === undefined ? {} : { autoComplete })}
        {...(placeholder === undefined ? {} : { placeholder })}
        type={revealed ? 'text' : 'password'}
        autoFocus={autoFocus ?? false}
        autoCapitalize="none"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className="ghost password-toggle"
        // Not in the tab order: tabbing from the password field should
        // reach the submit button, not a visibility toggle.
        tabIndex={-1}
        aria-label={revealed ? 'Hide password' : 'Show password'}
        onClick={() => setRevealed((current) => !current)}
      >
        {revealed ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

/**
 * A quantity a cashier can type as well as step.
 *
 * The old running bill only had + and −, so setting a line to 10 meant
 * nine clicks. The typed value is held as text while it is being edited
 * so a half-typed field isn't clobbered mid-keystroke, and is committed
 * on blur or Enter — never on every keypress, which would fire a
 * request per digit. An empty or nonsensical entry reverts to the value
 * it had rather than being pushed to the server.
 */
export function QtyInput({
  value,
  onCommit,
  max = 999,
  disabled = false,
  label,
}: {
  value: number;
  onCommit: (next: number) => void;
  max?: number;
  disabled?: boolean;
  label?: string;
}): JSX.Element {
  const [text, setText] = useState(String(value));
  const [lastValue, setLastValue] = useState(value);

  // Follow the value when it changes underneath us (another terminal, or
  // our own +/− buttons), without fighting what is being typed.
  if (value !== lastValue) {
    setLastValue(value);
    setText(String(value));
  }

  const commit = () => {
    const parsed = Number.parseInt(text, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > max) {
      setText(String(value));
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };

  const step = (delta: number) => {
    const next = Math.min(max, Math.max(1, value + delta));
    if (next !== value) onCommit(next);
  };

  return (
    <div className="qty-input">
      <button type="button" className="qty-step" disabled={disabled || value <= 1} onClick={() => step(-1)} aria-label="One fewer">
        −
      </button>
      <input
        className="qty-value mono"
        inputMode="numeric"
        disabled={disabled}
        aria-label={label ?? 'Quantity'}
        value={text}
        onChange={(event) => setText(event.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
            (event.target as HTMLInputElement).blur();
          }
          if (event.key === 'Escape') setText(String(value));
        }}
        onFocus={(event) => event.target.select()}
      />
      <button type="button" className="qty-step" disabled={disabled || value >= max} onClick={() => step(1)} aria-label="One more">
        +
      </button>
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
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      onApproved(await approveAs(username.trim(), password));
    } catch (err) {
      setError(err);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Manager approval — ${action}`} onClose={onCancel}>
      <form onSubmit={(event) => void submit(event)}>
        <ErrorBanner error={error} />
        <div className="col">
          <div>
            <label htmlFor="approval-username">Manager username</label>
            <input
              id="approval-username"
              autoFocus
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="approval-password">Password</label>
            <PasswordInput id="approval-password" value={password} onChange={setPassword} />
          </div>
          <button className="primary big" type="submit" disabled={busy || !username.trim() || !password}>
            {busy ? 'Checking…' : 'Approve'}
          </button>
        </div>
      </form>
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
