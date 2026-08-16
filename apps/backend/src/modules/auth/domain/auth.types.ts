/**
 * Domain-layer types for the Auth module.
 *
 * These types deliberately have zero dependency on NestJS, Prisma, or any
 * other framework — they describe the *business* shape of authentication,
 * not its implementation. This is what makes the application layer
 * (services) testable without a database or an HTTP server.
 */

import type { PersistedFamilyRole } from '../../../common/authz/principal-role';

/** Who is the subject of a token: a parent's User account, or a Device. */
export type ActorType = 'USER' | 'DEVICE';

export type TokenKind = 'access' | 'refresh';

/** Decoded payload carried inside every JWT this system issues. */
export interface IJwtPayload {
  /** The subject: userId for USER actors, deviceId for DEVICE actors. */
  sub: string;
  actorType: ActorType;
  tokenKind: TokenKind;
  /** Present for USER actors once they belong to a family (nearly always). */
  familyId?: string;
  /**
   * PHASE C (A4 §SA-005). The caller's role INSIDE that family, copied from
   * `family_members.role` at issue time and therefore signed.
   *
   * Optional for exactly one reason: tokens minted before this claim existed
   * stay valid for up to 15 minutes after a deploy. `principalRoleFromToken()`
   * degrades such a token to `PARENT` — the least privileged adult role — so
   * the ordinary surface keeps working while the destructive operations stay
   * out of reach. It is NOT optional because a route may skip it.
   *
   * DEVICE tokens do not carry it: their role is `CHILD` by construction, and
   * deriving it from `actorType` leaves no claim to get out of sync.
   */
  familyRole?: PersistedFamilyRole;
  /** JWT ID — used to correlate a refresh token to its DB row for revocation. */
  jti: string;
}

export interface ITokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
  refreshTokenExpiresInSeconds: number;
}

export interface IRegisterParentInput {
  email: string;
  password: string;
  fullName: string;
  familyName?: string;
  timezone?: string;
  locale?: string;
  acceptedTerms: boolean;
  /**
   * PHASE D (GROWTH). Where this household came from — the ONLY moment this
   * data exists (install referrer and UTM parameters live in the client's
   * memory between the ad click and this call, and nothing later can
   * reconstruct them).
   *
   * NONE of it is trusted: it is normalised, length-capped and resolved to a
   * closed channel vocabulary in `analytics/domain/attribution.ts`, and it
   * participates in NO authorization decision. It is a marketing label
   * attached to a row the server created; it can bias a chart and can do
   * nothing else. `familyId` is still derived from the transaction that
   * creates the family — CONTEXT §3 principle 3 is not relaxed here.
   */
  attribution?: {
    source?: string;
    campaign?: string;
    medium?: string;
    content?: string;
    countryCode?: string;
    platform?: string;
    referralCode?: string;
    referrer?: string;
    landingPage?: string;
    sessionId?: string;
  };
}

export interface IAuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  familyId: string;
  /** Same vocabulary as the token claim — one definition, no drift. */
  familyRole: PersistedFamilyRole;
}

export interface IDeviceSessionContext {
  userAgent?: string;
  ipAddress?: string;
}


