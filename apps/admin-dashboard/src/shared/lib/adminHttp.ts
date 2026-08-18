import { httpClient, ApiError } from './httpClient';
import { adminKeyStore } from '../../features/admin-key/adminKeyStore';

/**
 * The one door every platform-admin request goes through.
 *
 * Three routes in this backend share `InternalAdminGuard` and therefore
 * share this client: `/admin/growth/*`, `/analytics/dashboard-metrics` and
 * `/system/notifications/analytics`. They all pass `skipAuth`, because the
 * guard reads a header, not the parent JWT, and because the refresh-on-401
 * machinery in `httpClient` has nothing to refresh for them.
 *
 * The key is read from `adminKeyStore` at the instant of the fetch and is
 * handed straight to `headers`. It is never copied into a local that
 * outlives the call, never put in the URL, never logged and never
 * interpolated into a thrown error — the errors below carry a reason, not
 * the secret.
 */

export const ADMIN_KEY_HEADER = 'x-internal-admin-key';

/**
 * Thrown instead of firing a request that is guaranteed to fail closed.
 * Carries no value and no status: it exists so a caller can distinguish
 * "the operator has not unlocked yet" from "the backend said no".
 */
export class AdminKeyMissingError extends Error {
  constructor() {
    super('No operator key is held in this page.');
    this.name = 'AdminKeyMissingError';
  }
}

/** A refusal by the guard: 401 (no/unknown key) or 403 (wrong role). */
export function isAdminKeyRejection(error: unknown): boolean {
  return error instanceof ApiError && (error.statusCode === 401 || error.statusCode === 403);
}

async function adminRequest<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  const key = adminKeyStore.peek();
  if (key === null) throw new AdminKeyMissingError();

  try {
    return await httpClient<T>(path, {
      method: init.method ?? 'GET',
      body: init.body,
      skipAuth: true,
      headers: { [ADMIN_KEY_HEADER]: key },
    });
  } catch (error) {
    // A 401/403 means the key we hold is not the key this environment
    // expects. Holding on to it would retry a known-bad secret on every
    // subsequent panel; discarding it returns the operator to one calm
    // screen instead of eight red panels.
    if (isAdminKeyRejection(error)) adminKeyStore.reject();
    throw error;
  }
}

export function adminGet<T>(path: string): Promise<T> {
  return adminRequest<T>(path);
}

export function adminPost<T>(path: string, body: unknown): Promise<T> {
  return adminRequest<T>(path, { method: 'POST', body });
}

/** Query-string builder shared by every admin client: skips absent values so
 * an optional filter never becomes `?channel=undefined`. */
export function adminQuery(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const serialised = search.toString();
  return serialised ? `?${serialised}` : '';
}
