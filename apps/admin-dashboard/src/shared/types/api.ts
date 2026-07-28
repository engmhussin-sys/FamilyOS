/**
 * Mirrors apps/backend/src/modules/auth/domain/auth.types.ts response shapes.
 * Kept as plain hand-written types (not a generated client) for this MVP —
 * see docs/architecture/admin-dashboard.md for the follow-up on generating
 * these from the backend's OpenAPI/Prisma schema once one exists.
 */

export interface Child {
  id: string;
  familyId: string;
  firstName: string;
  lastName: string | null;
  dateOfBirth: string;
  gender: string | null;
  avatarUrl: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  familyId: string;
  familyRole: 'OWNER' | 'PARENT';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
  refreshTokenExpiresInSeconds: number;
}

export interface LoginResponse {
  user: AuthenticatedUser;
  tokens: TokenPair;
}

export interface PairingInitiateResponse {
  code: string;
  expiresInSeconds: number;
}

export interface ApiErrorBody {
  message: string | string[];
  statusCode: number;
  error?: string;
}
