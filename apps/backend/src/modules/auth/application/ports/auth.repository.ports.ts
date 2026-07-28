import type { User, Family, FamilyMember, Device, RefreshToken } from '@prisma/client';
import type { IRegisterParentInput } from '../../domain/auth.types';

/**
 * DI tokens. NestJS resolves interfaces by token, not by type (TS interfaces
 * don't exist at runtime), so every port needs one of these.
 */
export const USER_REPOSITORY = Symbol('USER_REPOSITORY');
export const REFRESH_TOKEN_REPOSITORY = Symbol('REFRESH_TOKEN_REPOSITORY');
export const DEVICE_REPOSITORY = Symbol('DEVICE_REPOSITORY');

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
}

export interface IRefreshTokenRepository {
  create(input: ICreateRefreshTokenInput): Promise<RefreshToken>;
  findActiveByTokenHash(tokenHash: string): Promise<RefreshToken | null>;
  revokeById(id: string, revokedAt: Date): Promise<void>;
  revokeAllForUser(userId: string, revokedAt: Date): Promise<void>;
}

export interface ICreateChildDeviceInput {
  familyId: string;
  childId: string;
  platform: 'ANDROID' | 'IOS';
  deviceModel?: string;
  osVersion?: string;
  appVersion?: string;
  pushToken?: string;
}

export interface IDeviceRepository {
  createPairedChildDevice(input: ICreateChildDeviceInput): Promise<Device>;
  findById(id: string): Promise<Device | null>;
  revoke(id: string): Promise<void>;
}
