import * as crypto from 'crypto';

import { base64UrlEncode } from '../apple/apple-jws.verifier';
import {
  GOOGLE_ANDROIDPUBLISHER_BASE,
  GOOGLE_ANDROIDPUBLISHER_SCOPE,
  GOOGLE_OAUTH_TOKEN_URL,
  type IGoogleSubscriptionPurchaseV2,
} from './google-play.types';

/**
 * PHASE D — THE GOOGLE PLAY DEVELOPER API CLIENT.
 *
 * Authorisation is a service-account OAuth2 flow, done by hand because no npm
 * package can be installed here (`googleapis` would be the right dependency
 * otherwise, and this file is the ONLY thing that would need replacing):
 *
 *   1. Build a JWT signed RS256 with the service account's private key, with
 *      `aud = https://oauth2.googleapis.com/token`,
 *      `scope = https://www.googleapis.com/auth/androidpublisher`.
 *   2. POST it to the token endpoint as a
 *      `urn:ietf:params:oauth:grant-type:jwt-bearer` assertion.
 *   3. Use the returned access token as a bearer for the androidpublisher call.
 *
 * The access token IS cached — unlike Apple's per-request JWT — because Google
 * issues it with a one-hour lifetime through a round trip we would otherwise
 * pay on every webhook. It is refreshed 60 seconds before expiry, and the
 * cache is per-instance so a redeployment invalidates it.
 *
 * The HTTP boundary is injectable (`fetchImpl`) for exactly one reason: tests
 * mock GOOGLE'S RESPONSES, never our own state-mapping logic.
 */

export interface IPlayDeveloperApiConfig {
  readonly clientEmail: string;
  /** PEM contents of the service account key. */
  readonly privateKeyPem: string;
  readonly packageName: string;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export class PlayDeveloperApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class PlayDeveloperApiClient {
  private cachedToken: { value: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly config: IPlayDeveloperApiConfig,
    private readonly fetchImpl: FetchLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * `GET /androidpublisher/v3/applications/{packageName}/purchases/subscriptionsv2/tokens/{token}`
   *
   * THE AUTHORITATIVE CALL. Everything this system believes about a Google
   * subscription — its state, its expiry, its price, and which household it
   * belongs to — comes from this response and from nowhere else. The Android
   * client sends a purchase token and nothing more; it could send a token that
   * is not its own, and the answer would still be about whoever really owns it,
   * which is why `obfuscatedExternalAccountId` is checked rather than the
   * caller's session.
   */
  async getSubscriptionV2(purchaseToken: string): Promise<IGoogleSubscriptionPurchaseV2> {
    const path =
      `/androidpublisher/v3/applications/${encodeURIComponent(this.config.packageName)}` +
      `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;

    const response = await this.fetchImpl(`${GOOGLE_ANDROIDPUBLISHER_BASE}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        Accept: 'application/json',
      },
    });

    const body = await response.text();
    if (!response.ok) {
      // Body deliberately not echoed: Google's errors include the purchase
      // token, and this message reaches logs.
      throw new PlayDeveloperApiError(
        `Play Developer API subscriptionsv2 responded ${response.status}.`,
        response.status,
      );
    }
    try {
      return JSON.parse(body) as IGoogleSubscriptionPurchaseV2;
    } catch {
      throw new PlayDeveloperApiError('Play Developer API returned a non-JSON body.', response.status);
    }
  }

  /**
   * `POST .../purchases/subscriptions/{subscriptionId}/tokens/{token}:acknowledge`
   *
   * NOT OPTIONAL, AND EASY TO FORGET. Google AUTOMATICALLY REFUNDS AND
   * CANCELS any purchase not acknowledged within three days. `subscriptionsv2`
   * has no acknowledge method of its own (confirmed against the reference,
   * 2026-08-16) — acknowledgement still goes through the v1 subscriptions
   * resource, which is why this method takes a `subscriptionId` the v2 read
   * does not need.
   */
  async acknowledgeSubscription(subscriptionId: string, purchaseToken: string): Promise<void> {
    const path =
      `/androidpublisher/v3/applications/${encodeURIComponent(this.config.packageName)}` +
      `/purchases/subscriptions/${encodeURIComponent(subscriptionId)}` +
      `/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;

    const response = await this.fetchImpl(`${GOOGLE_ANDROIDPUBLISHER_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (!response.ok) {
      throw new PlayDeveloperApiError(
        `Play Developer API acknowledge responded ${response.status}.`,
        response.status,
      );
    }
  }

  private async accessToken(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.cachedToken && this.cachedToken.expiresAtMs - 60_000 > nowMs) {
      return this.cachedToken.value;
    }

    const assertion = this.createAssertion();
    const response = await this.fetchImpl(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });

    const body = await response.text();
    if (!response.ok) {
      throw new PlayDeveloperApiError(`Google OAuth token endpoint responded ${response.status}.`, response.status);
    }
    const parsed = JSON.parse(body) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) {
      throw new PlayDeveloperApiError('Google OAuth token endpoint returned no access_token.', response.status);
    }
    this.cachedToken = {
      value: parsed.access_token,
      expiresAtMs: nowMs + (parsed.expires_in ?? 3600) * 1000,
    };
    return parsed.access_token;
  }

  /** RS256 service-account assertion. Google's documented shape. */
  createAssertion(): string {
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64UrlEncode(
      JSON.stringify({
        iss: this.config.clientEmail,
        scope: GOOGLE_ANDROIDPUBLISHER_SCOPE,
        aud: GOOGLE_OAUTH_TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + 3600,
      }),
    );
    const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`, 'ascii'), this.config.privateKeyPem);
    return `${header}.${payload}.${base64UrlEncode(signature)}`;
  }
}
