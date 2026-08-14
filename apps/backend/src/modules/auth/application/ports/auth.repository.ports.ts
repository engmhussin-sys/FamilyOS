import type { User, Family, FamilyMember, RefreshToken } from '@prisma/client';
import type { IRegisterParentInput } from '../../domain/auth.types';

/**
 * DI tokens. NestJS resolves interfaces by token, not by type (TS interfaces
 * don't exist at runtime), so every port needs one of these.
 */
export const USER_REPOSITORY = Symbol('USER_REPOSITORY');
export const REFRESH_TOKEN_REPOSITORY = Symbol('REFRESH_TOKEN_REPOSITORY');

export interface IUserRepository {
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  /**
   * Registration is transactional: creates the User, a new Family, and a
   * FamilyMember(role=OWNER) row atomically. Implemented as a single
   * Prisma `$transaction` in the infrastructure layer.
   */
  createParentWithFamily(
    input: IRegisterParentInput,
    passwordHash: string,
  ): Promise<{ user: User; family: Family; membership: FamilyMember }>;
  updateLastLoginAt(userId: string, at: Date): Promise<void>;
  /** Returns the user's primary family membership (MVP: one family per user). */
  findPrimaryFamilyMembership(userId: string): Promise<(FamilyMember & { family: Family }) | null>;
}

export interface ICreateRefreshTokenInput {
  jti: string;
  tokenHash: string;
  userId?: string;
  deviceId?: string;
  expiresAt: Date;
  userAgent?: string;
  ipAddress?: string;
  /** SA-002 rotation lineage. Defaults to `jti` for the first token of a
   * session; a rotated successor inherits its predecessor's value. */
  familyTokenId: string;
}

export interface IRefreshTokenRepository {
  create(input: ICreateRefreshTokenInput): Promise<RefreshToken>;
  findActiveByTokenHash(tokenHash: string): Promise<RefreshToken | null>;
  /** SA-002: unlike findActiveByTokenHash this returns the row whatever
   * its state, so an already-revoked token can be told apart from a
   * token that never existed. Those are very different events. */
  findAnyByTokenHash(tokenHash: string): Promise<RefreshToken | null>;
  revokeById(id: string, revokedAt: Date): Promise<void>;
  /** SA-002: revokes every still-active token in one rotation lineage.
   * Returns how many rows it actually revoked, which is what the audit
   * record reports. */
  revokeFamily(familyTokenId: string, revokedAt: Date): Promise<number>;
  /** SA-002 forensics: links a consumed token to its replacement. */
  markReplacedBy(id: string, replacedById: string): Promise<void>;
  revokeAllForUser(userId: string, revokedAt: Date): Promise<void>;
  /** Sprint 3 addition — needed by PairingModule's /pairing/revoke to
   * kill a specific device's session without touching any USER's other
   * sessions. Mirrors revokeAllForUser's shape exactly, scoped to
   * deviceId instead of userId. */
  revokeAllForDevice(deviceId: string, revokedAt: Date): Promise<void>;
}


