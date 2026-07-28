import type { AuthenticatedUser } from '../types/api';

/**
 * MVP tradeoff (documented, not silent — see docs/architecture/admin-dashboard.md
 * §Security): the backend currently returns the refresh token in the JSON
 * body (mobile-friendly design), not as an httpOnly cookie. Storing it in
 * `localStorage` would survive indefinitely and is a stronger XSS target;
 * `sessionStorage` is the safer choice available today — cleared when the
 * tab closes. The access token is kept in memory ONLY and is never
 * persisted, by design (it's short-lived and the highest-value token to
 * keep out of any storage an XSS payload could read at leisure).
 *
 * Production hardening path: add a web-specific login/refresh flow on the
 * backend that sets the refresh token as an httpOnly, Secure, SameSite=strict
 * cookie, and stop returning it in the JSON body for browser clients.
 */

const REFRESH_TOKEN_KEY = 'afdc.refreshToken';
const PROFILE_KEY = 'afdc.profile';

let accessToken: string | null = null;

export const tokenStorage = {
  getAccessToken(): string | null {
    return accessToken;
  },

  setAccessToken(token: string | null): void {
    accessToken = token;
  },

  getRefreshToken(): string | null {
    return sessionStorage.getItem(REFRESH_TOKEN_KEY);
  },

  setRefreshToken(token: string | null): void {
    if (token) sessionStorage.setItem(REFRESH_TOKEN_KEY, token);
    else sessionStorage.removeItem(REFRESH_TOKEN_KEY);
  },

  /** Display-only profile cache — NOT a source of authorization truth. */
  getProfile(): AuthenticatedUser | null {
    const raw = sessionStorage.getItem(PROFILE_KEY);
    return raw ? (JSON.parse(raw) as AuthenticatedUser) : null;
  },

  setProfile(profile: AuthenticatedUser | null): void {
    if (profile) sessionStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    else sessionStorage.removeItem(PROFILE_KEY);
  },

  setSession(user: AuthenticatedUser, access: string, refresh: string): void {
    this.setAccessToken(access);
    this.setRefreshToken(refresh);
    this.setProfile(user);
  },

  clear(): void {
    this.setAccessToken(null);
    this.setRefreshToken(null);
    this.setProfile(null);
  },

  hasPersistedSession(): boolean {
    return this.getRefreshToken() !== null && this.getProfile() !== null;
  },
};

/** Dispatched by httpClient when a refresh attempt fails — the auth store
 * listens for this to clear its state and redirect to /login, without
 * httpClient needing to import React or zustand. */
export const SESSION_EXPIRED_EVENT = 'afdc:session-expired';

export function emitSessionExpired(): void {
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}
