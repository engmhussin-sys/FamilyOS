/**
 * Domain-layer types for the Auth module.
 *
 * These types deliberately have zero dependency on NestJS, Prisma, or any
 * other framework — they describe the *business* shape of authentication,
 * not its implementation. This is what makes the application layer
 * (services) testable without a database or an HTTP server.
 */

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
}

export interface IAuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  familyId: string;
  familyRole: 'OWNER' | 'PARENT';
}

export interface IDeviceSessionContext {
  userAgent?: string;
  ipAddress?: string;
}

export interface IPairingTicket {
  familyId: string;
  childId: string;
  initiatedByUserId: string;
}

export interface IConfirmPairingInput {
  code: string;
  platform: 'ANDROID' | 'IOS';
  deviceModel?: string;
  osVersion?: string;
  appVersion?: string;
  pushToken?: string;
}
