/**
 * The till's local ESC/POS print agent.
 *
 * A small Node service on the till (see the repo's `agent/`) that prints
 * raw bytes to the BIXOLON, bypassing the Windows driver — which renders
 * blank pages, confirmed. This module is the browser's side of talking
 * to it, and it is deliberately the WHOLE of the print path now: there
 * is no `window.print()` fallback any more, because that path printed
 * blank paper and hid the failure.
 *
 * Everything here is localhost. The agent runs on the same machine as
 * the browser (each till prints to its own printer), so these requests
 * never leave the till and work with no network at all.
 */

/** Where the agent listens. A constant, not a setting: it is a fixed
 * local port on every till, and making it configurable would only invite
 * a till pointed at the wrong printer. */
export const AGENT_URL = 'http://127.0.0.1:7777';

/** How long to wait before treating the agent as down. Short, because it
 * is on the same machine — a slow answer means it is not really there. */
const TIMEOUT_MS = 4000;

async function withTimeout(path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${AGENT_URL}${path}`, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Is the agent up AND the printer reachable? `GET /health` prints
 * nothing and uses no paper, so this is safe to poll. Any failure — the
 * agent not running, the printer unplugged (503), a refused connection —
 * is reported as simply "not connected"; the cashier does not need the
 * distinction, only whether they can print.
 */
export async function agentHealthy(): Promise<boolean> {
  try {
    const res = await withTimeout('/health', { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Thrown when a print did not happen, so nothing upstream mistakes a
 * failed print for a successful one. */
export class PrintFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrintFailedError';
  }
}

/**
 * Send one ticket to the agent to print. Resolves only on a real success
 * (`200 {ok:true}`); every other outcome throws, because the agent's
 * contract is that any non-200 means nothing printed. The caller shows
 * that to the cashier and offers a retry — it never falls back to the
 * browser's own printing.
 */
export async function printViaAgent(payload: unknown): Promise<void> {
  let res: Response;
  try {
    res = await withTimeout('/print', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  } catch {
    throw new PrintFailedError('The receipt printer agent did not respond. Check that it is running on this till.');
  }
  if (!res.ok) {
    throw new PrintFailedError(`The printer did not accept the ticket (agent said ${res.status}). Nothing was printed.`);
  }
}
