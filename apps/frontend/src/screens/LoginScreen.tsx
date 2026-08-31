import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.tsx';
import { ErrorBanner, PinPad } from '../components/ui.tsx';

/** Screen 1: PIN pad, per user. The user list itself is behind
 * manager-only `/api/users`, so this asks for the user id rather than
 * showing a roster — nothing about who works here leaks to an
 * unauthenticated tablet. */
export function LoginScreen(): JSX.Element {
  const { login, terminalId } = useAuth();
  const [userId, setUserId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await login(Number(userId), pin);
    } catch (err) {
      setError(err);
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <main className="screen" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="card" style={{ width: 420 }}>
          <h2>Sign in</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Terminal {terminalId}
          </p>
          <ErrorBanner error={error} />
          <div className="col">
            <div>
              <label htmlFor="login-user">User id</label>
              <input id="login-user" inputMode="numeric" autoFocus value={userId} onChange={(event) => setUserId(event.target.value)} />
            </div>
            <PinPad value={pin} onChange={setPin} />
            <button className="primary big" disabled={busy || !userId || pin.length < 4} onClick={() => void submit()}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
