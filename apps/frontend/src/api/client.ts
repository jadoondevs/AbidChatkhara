/**
 * One fetch wrapper for the whole app. Everything goes to the same
 * origin the PWA was served from — the server serves both the API and
 * this bundle (see ARCHITECTURE.md) — so there is no base URL to
 * configure and nothing to point at a different host.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  /** 422: a domain rule said no (order already settled, shift has open
   * orders, discount exceeds subtotal...). Always safe to show verbatim
   * to the cashier — the server writes these for exactly that. */
  get isDomainError(): boolean {
    return this.status === 422;
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }
}

let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

export interface RequestOptions {
  /** Overrides the ambient session token for this one call — used by the
   * manager-approval flow, which authenticates a manager just long
   * enough to approve a void without switching who is logged in. */
  readonly token?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = opts.token ?? authToken;
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (opts.signal) init.signal = opts.signal;

  const response = await fetch(path, init);

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  const parsed: unknown = contentType.includes('application/json') && text ? JSON.parse(text) : text;

  if (!response.ok) {
    const message =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `${method} ${path} failed (${response.status})`;
    throw new ApiError(response.status, message, parsed);
  }

  return parsed as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, body, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, body, opts),
  del: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts),
};

/** Builds `?a=1&b=2`, dropping undefined/empty values so an unset date
 * filter doesn't turn into `from=undefined`. */
export function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}
