import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setAuthToken } from '../api/client.js';
import type { LoginResult, Role } from '../api/types.js';

export interface Session {
  readonly token: string;
  readonly userId: number;
  readonly name: string;
  readonly username: string;
  readonly role: Role;
  readonly terminalId: string;
}

interface AuthContextValue {
  readonly session: Session | null;
  readonly terminalId: string;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  /** Authenticates a manager for ONE action without switching who is
   * logged in — the manager-approval path behind a line void or an
   * order reopen. Returns that manager's token for the caller to pass to
   * exactly one request. */
  approveAs: (username: string, password: string) => Promise<string>;
  hasAtLeastRole: (minimum: Role) => boolean;
}

const RANK: Record<Role, number> = { server: 0, cashier: 1, manager: 2, admin: 3 };
const SESSION_KEY = 'pos.session';
const TERMINAL_KEY = 'pos.terminalId';

const AuthContext = createContext<AuthContextValue | null>(null);

/** A terminal id is per-device and stable across reloads: every write in
 * this system is attributed to who did it AND which terminal it came
 * from (see ARCHITECTURE.md's "Identity and attribution"). */
function loadTerminalId(): string {
  const existing = localStorage.getItem(TERMINAL_KEY);
  if (existing) return existing;
  const generated = `till-${Math.random().toString(36).slice(2, 8)}`;
  localStorage.setItem(TERMINAL_KEY, generated);
  return generated;
}

function loadSession(): Session | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

// Restore the token BEFORE React renders anything. Doing this in an
// effect instead would leave a window on every reload where the first
// batch of queries fires unauthenticated and 401s — the screen recovers
// on retry, but the till briefly shows an empty floor for no reason.
const restored = loadSession();
if (restored) setAuthToken(restored.token);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [terminalId] = useState(loadTerminalId);
  const [session, setSession] = useState<Session | null>(restored);

  // The token is set synchronously on login/logout and, for a restored
  // session, before this module's first render (see above) — this only
  // catches the case where React remounts the provider with a session
  // already in hand.
  useEffect(() => {
    setAuthToken(session?.token ?? null);
  }, [session]);

  const login = useCallback(
    async (username: string, password: string) => {
      const result = await api.post<LoginResult>('/api/auth/login', { username, password, terminalId });
      const next: Session = {
        token: result.token,
        userId: result.user.id,
        name: result.user.name,
        username: result.user.username,
        role: result.user.role,
        terminalId,
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(next));
      setAuthToken(next.token);
      setSession(next);
    },
    [terminalId],
  );

  const logout = useCallback(() => {
    void api.post('/api/auth/logout').catch(() => undefined); // best effort; the local session goes either way
    localStorage.removeItem(SESSION_KEY);
    setAuthToken(null);
    setSession(null);
  }, []);

  const approveAs = useCallback(
    async (username: string, password: string) => {
      const result = await api.post<LoginResult>('/api/auth/login', { username, password, terminalId });
      if (RANK[result.user.role] < RANK.manager) {
        throw new Error(`${result.user.name} is a ${result.user.role}, not a manager`);
      }
      return result.token;
    },
    [terminalId],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      terminalId,
      login,
      logout,
      approveAs,
      hasAtLeastRole: (minimum: Role) => (session ? RANK[session.role] >= RANK[minimum] : false),
    }),
    [session, terminalId, login, logout, approveAs],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
