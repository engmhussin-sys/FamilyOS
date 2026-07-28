import { tokenStorage, emitSessionExpired } from './tokenStorage';
import type { ApiErrorBody, TokenPair } from '../types/api';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
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
}

// Ensures concurrent 401s trigger exactly one refresh call, not one per
// failed request — every caller awaits the same in-flight promise.
let refreshInFlight: Promise<string | null> | null = null;

async function rawRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
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
    throw new ApiError(message, response.status);
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
