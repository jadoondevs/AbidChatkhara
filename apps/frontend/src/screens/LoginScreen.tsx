import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.tsx';
import { ErrorBanner, PasswordInput } from '../components/ui.tsx';

/**
 * Screen 1: a plain username-and-password form, driven entirely from
 * the keyboard.
 *
 * This replaced an on-screen number pad, which was right for a tablet
 * and wrong for the PC this runs on: it made staff click twelve times
 * to enter what they can type in two seconds, and it forced every
 * credential to be a number. The whole form is one `<form>` so Enter
 * submits from either field, and nothing about who works here is shown
 * to an unauthenticated screen — the user list is behind manager-only
 * `/api/users`, and the server answers a wrong password and an unknown
 * username identically.
 */
export function LoginScreen(): JSX.Element {
  const { login, terminalId } = useAuth();
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
      await login(username.trim(), password);
    } catch (err) {
      setError(err);
      // Clear the password but keep the username: a mistyped password is
      // far more likely than a mistyped username, and retyping both is
      // busywork.
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app login-page">
      <main className="screen login-main">
        <form className="card login-card" onSubmit={(event) => void submit(event)}>
          <h1 className="login-title">Sign in</h1>
          <p className="muted login-subtitle">Terminal {terminalId}</p>

          <ErrorBanner error={error} />

          <div className="col">
            <div>
              <label htmlFor="login-username">Username</label>
              <input
                id="login-username"
                name="username"
                autoFocus
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>

            <div>
              <label htmlFor="login-password">Password</label>
              <PasswordInput
                id="login-password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={setPassword}
              />
            </div>

            <button className="primary big" type="submit" disabled={busy || !username.trim() || !password}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
