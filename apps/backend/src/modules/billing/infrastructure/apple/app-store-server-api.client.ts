import * as crypto from 'crypto';

import { base64UrlEncode } from './apple-jws.verifier';
import {
  APPLE_API_BASE_PRODUCTION,
  APPLE_API_BASE_SANDBOX,
  APPLE_JWT_AUDIENCE,
  APPLE_JWT_MAX_LIFETIME_SECONDS,
  type IAppleStatusResponse,
  type IAppleTransactionInfoResponse,
} from './apple-storekit.types';

/**
 * PHASE D — THE APP STORE SERVER API CLIENT.
 *
 * Authorisation is a per-request ES256 JWT signed with the private key
 * downloaded from App Store Connect. Apple's spec, verbatim
 * (https://developer.apple.com/documentation/appstoreserverapi/generating-json-web-tokens-for-api-requests,
 * fetched 2026-08-16):
 *
 *   header  { "alg": "ES256", "kid": <Key ID>, "typ": "JWT" }
 *   payload { "iss": <Issuer ID>, "iat": <now>, "exp": <= iat + 3600,
 *             "aud": "appstoreconnect-v1", "bid": <bundle id> }
 *
 * and «Generate a new signed JWT for each new request.» This client does
 * exactly that — no token cache. A cached token is a token that outlives a
 * key rotation.
 *
 * WHY A RAW `fetch` AND NOT AN SDK: no new npm dependency can be installed in
 * this environment, and the surface used here is three GETs. Node 22 ships
 * `fetch`. The HTTP boundary is deliberately narrow and injectable
 * (`fetchImpl`) so tests can mock APPLE'S HTTP RESPONSES — never the
 * verification logic, which is the thing under test.
 */

export interface IAppStoreServerApiConfig {
  readonly issuerId: string;
  readonly keyId: string;
  /** The PEM contents of the `.p8` downloaded from App Store Connect. */
  readonly privateKeyPem: string;
  readonly bundleId: string;
  readonly useSandbox: boolean;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export class AppStoreServerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class AppStoreServerApiClient {
  constructor(
    private readonly config: IAppStoreServerApiConfig,
    private readonly fetchImpl: FetchLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get baseUrl(): string {
    return this.config.useSandbox ? APPLE_API_BASE_SANDBOX : APPLE_API_BASE_PRODUCTION;
  }

  /**
   * `GET /inApps/v1/transactions/{transactionId}`.
   *
   * THE POINT OF THIS CALL. A client can hand us a `JWSTransaction` it holds,
   * and the JWS verifier proves Apple signed it. What the JWS alone cannot
   * prove is that the transaction is still valid TODAY — a receipt for a
   * subscription refunded last week is a genuinely Apple-signed receipt. This
   * endpoint is how the current truth is obtained from Apple rather than from
   * a blob the device kept.
   */
  async getTransactionInfo(transactionId: string): Promise<IAppleTransactionInfoResponse> {
    return this.get<IAppleTransactionInfoResponse>(
      `/inApps/v1/transactions/${encodeURIComponent(transactionId)}`,
    );
  }

  /**
   * `GET /inApps/v1/subscriptions/{originalTransactionId}` — the current
   * status of every subscription in the lineage. This is the endpoint the
   * daily reconciliation job uses to catch webhooks Apple sent and we never
   * received (Q17: «missing webhooks happen»).
   */
  async getSubscriptionStatuses(originalTransactionId: string): Promise<IAppleStatusResponse> {
    return this.get<IAppleStatusResponse>(
      `/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`,
    );
  }

  /**
   * `GET /inApps/v1/history/{originalTransactionId}` — the transaction
   * history the brief asks for. Paginated by Apple via `revision`.
   */
  async getTransactionHistory(
    originalTransactionId: string,
    revision?: string,
  ): Promise<{ revision: string; hasMore: boolean; signedTransactions: string[] }> {
    const query = revision ? `?revision=${encodeURIComponent(revision)}` : '';
    return this.get<{ revision: string; hasMore: boolean; signedTransactions: string[] }>(
      `/inApps/v1/history/${encodeURIComponent(originalTransactionId)}${query}`,
    );
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.createJwt()}`,
        Accept: 'application/json',
      },
    });

    const body = await response.text();
    if (!response.ok) {
      // The body is NOT included in the thrown message. Apple's error bodies
      // echo identifiers, and this message reaches logs.
      throw new AppStoreServerApiError(
        `App Store Server API ${path} responded ${response.status}.`,
        response.status,
      );
    }
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new AppStoreServerApiError(`App Store Server API ${path} returned a non-JSON body.`, response.status);
    }
  }

  /**
   * A fresh ES256 JWT per request, exactly as Apple's documentation requires.
   *
   * `dsaEncoding: 'ieee-p1363'` again: a JWS signature is r||s, not DER. The
   * same mistake in the other direction (signing with the default DER
   * encoding) produces a token Apple rejects with a 401 that says nothing
   * useful.
   */
  createJwt(): string {
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    const header = base64UrlEncode(
      JSON.stringify({ alg: 'ES256', kid: this.config.keyId, typ: 'JWT' }),
    );
    const payload = base64UrlEncode(
      JSON.stringify({
        iss: this.config.issuerId,
        iat: issuedAt,
        // Deliberately well inside Apple's 60-minute ceiling. A token that
        // lives as long as it is allowed to is a token worth stealing.
        exp: issuedAt + Math.min(300, APPLE_JWT_MAX_LIFETIME_SECONDS),
        aud: APPLE_JWT_AUDIENCE,
        bid: this.config.bundleId,
      }),
    );
    const signature = crypto.sign(
      'sha256',
      Buffer.from(`${header}.${payload}`, 'ascii'),
      { key: this.config.privateKeyPem, dsaEncoding: 'ieee-p1363' },
    );
    return `${header}.${payload}.${base64UrlEncode(signature)}`;
  }
}
