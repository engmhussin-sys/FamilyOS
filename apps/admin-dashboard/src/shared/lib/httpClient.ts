import { tokenStorage, emitSessionExpired } from './tokenStorage';
import type { ApiErrorBody, TokenPair } from '../types/api';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

/**
 * B3: `message` and `statusCode` keep their exact previous meaning — every
 * existing `catch (e) { e.message }` still works untouched. `code`, `messageAr`,
 * `requestId` and `details` are ADDITIVE: branch on `code` (never on prose),
 * show `messageAr` in an Arabic locale, quote `requestId` in a support ticket.
 * All four are optional because a non-JSON failure (a proxy 502, a dropped
 * connection) still produces an ApiError carrying none of them.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string,
    public readonly messageAr?: string,
    public readonly requestId?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Skip attaching the access token — only for register/login/refresh themselves. */
  skipAuth?: boolean;
  /**
   * Extra request headers. Added for the `/admin/growth/*` surface, which
   * authenticates with `x-internal-admin-key` and not a parent JWT
   * (GROWTH_ANALYTICS_API §1). Those calls also pass `skipAuth`, because
   * the refresh-on-401 machinery below has nothing to refresh for them.
   */
  headers?: Record<string, string>;
}

// Ensures concurrent 401s trigger exactly one refresh call, not one per
// failed request — every caller awaits the same in-flight promise.
let refreshInFlight: Promise<string | null> | null = null;

async function rawRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...options.headers };
  if (!options.skipAuth) {
    const token = tokenStorage.getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) return undefined as T;

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorBody = data as ApiErrorBody;
    const message = Array.isArray(errorBody.message)
      ? errorBody.message.join(' ')
      : (errorBody.message ?? 'Request failed.');
    throw new ApiError(
      message,
      response.status,
      errorBody.code,
      errorBody.messageAr,
      // `requestId` and `correlationId` are the same value server-side; the
      // fallback exists only for a response emitted before B3.
      errorBody.requestId ?? errorBody.correlationId,
      errorBody.details,
    );
  }

  return data as T;
}

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = tokenStorage.getRefreshToken();
  if (!refreshToken) return null;

  try {
    const pair = await rawRequest<TokenPair>('/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
      skipAuth: true,
    });
    tokenStorage.setAccessToken(pair.accessToken);
    tokenStorage.setRefreshToken(pair.refreshToken);
    return pair.accessToken;
  } catch {
    return null;
  }
}

/**
 * Public entry point. On a 401 (and only once per request — no retry loops),
 * attempts a single coordinated refresh, retries the original request with
 * the new access token, and gives up (clearing the session) if that fails.
 */
export async function httpClient<T>(path: string, options: RequestOptions = {}): Promise<T> {
  try {
    return await rawRequest<T>(path, options);
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 401 && !options.skipAuth) {
      refreshInFlight ??= refreshAccessToken().finally(() => {
        refreshInFlight = null;
      });
      const newAccessToken = await refreshInFlight;

      if (!newAccessToken) {
        tokenStorage.clear();
        emitSessionExpired();
        throw err;
      }

      return rawRequest<T>(path, options);
    }
    throw err;
  }
}
