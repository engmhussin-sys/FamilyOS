/**
 * ── WHERE THE OPERATOR KEY LIVES, AND WHY IT LIVES THERE ────────────────
 *
 * `/admin/growth/*`, `/analytics/dashboard-metrics` and
 * `/system/notifications/analytics` are all behind `InternalAdminGuard`
 * (`apps/backend/src/common/guards/internal-admin.guard.ts`): one shared
 * secret in the `x-internal-admin-key` header, failing CLOSED when unset.
 * That guard is correct and is not being changed. What had to change is the
 * browser side: a web app cannot ship a shared secret, so the operator types
 * it in at runtime.
 *
 * THE KEY IS HELD IN THIS MODULE'S CLOSURE — one `let`, nothing more:
 *
 *   - NOT `localStorage`. A value there survives every tab, every restart,
 *     and is readable by any XSS payload at leisure, forever.
 *   - NOT `sessionStorage`. Narrower, but still readable by the same XSS and
 *     still outlives the page the operator was looking at. The refresh token
 *     lives there as a documented MVP tradeoff (see `tokenStorage.ts`); a
 *     platform-wide admin secret is a strictly worse thing to leave lying
 *     about, so it does not get the same allowance.
 *   - NOT a cookie. Sent automatically on every request to the origin,
 *     persisted, and visible to `document.cookie` unless httpOnly — which a
 *     client-entered value can never be.
 *   - NOT the URL. Query strings land in browser history, in the referer
 *     header, in proxy logs and in screenshots.
 *   - NOT React state, and NOT a context value. Components subscribe to
 *     `hasKey` (a boolean) only — the secret itself never becomes a prop, a
 *     state value or a context value, so it never appears in a React
 *     DevTools tree, a component-stack error overlay or a serialised
 *     redux-style dump.
 *
 * It therefore dies with the page: a reload, a tab close or a crash all
 * require the operator to type it again. That is the intended cost.
 *
 * It is also never logged, never interpolated into an error message and
 * never attached to anything that gets reported: `adminHttp` reads it at the
 * moment of the fetch and hands it straight to `headers`, and the failure
 * paths below carry a reason code, never the value.
 */

/** Why the operator is being asked for the key. Never a raw HTTP status. */
export type AdminKeyLockReason =
  /** No key held yet in this page's lifetime — the first-open case. */
  | 'NEVER_ENTERED'
  /** The backend refused the key we held (401/403). It has been discarded. */
  | 'REJECTED'
  /** The operator locked the dashboard themselves. */
  | 'LOCKED_BY_OPERATOR';

export interface AdminKeyState {
  hasKey: boolean;
  reason: AdminKeyLockReason;
}

/** THE secret. Module closure, never exported, never serialised. */
let operatorKey: string | null = null;

let snapshot: AdminKeyState = { hasKey: false, reason: 'NEVER_ENTERED' };

const listeners = new Set<() => void>();

function publish(next: AdminKeyState): void {
  // A new object identity only when something actually changed, so
  // `useSyncExternalStore` does not loop.
  snapshot = next;
  for (const listener of listeners) listener();
}

export const adminKeyStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** The only thing components are allowed to observe. */
  getSnapshot(): AdminKeyState {
    return snapshot;
  },

  /**
   * Read at the moment of a request, by `adminHttp` and by nothing else.
   * Deliberately not called from any component.
   */
  peek(): string | null {
    return operatorKey;
  },

  set(key: string): void {
    const trimmed = key.trim();
    if (trimmed === '') return;
    operatorKey = trimmed;
    publish({ hasKey: true, reason: 'NEVER_ENTERED' });
  },

  /** Operator-initiated lock. */
  clear(): void {
    operatorKey = null;
    publish({ hasKey: false, reason: 'LOCKED_BY_OPERATOR' });
  },

  /**
   * Called on a 401/403 from any platform-admin route. Discards the key and
   * records WHY, so the unlock screen can say something calm and true
   * without ever printing the status code it came from.
   */
  reject(): void {
    operatorKey = null;
    publish({ hasKey: false, reason: 'REJECTED' });
  },

  /** Test seam only: forget everything, including the reason. */
  resetForTests(): void {
    operatorKey = null;
    publish({ hasKey: false, reason: 'NEVER_ENTERED' });
  },
};
