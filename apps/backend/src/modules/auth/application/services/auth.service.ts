import { Inject, Injectable, Logger } from '@nestjs/common';

import type {
  IAuthenticatedUser,
  IDeviceSessionContext,
  IRegisterParentInput,
  ITokenPair,
} from '../../domain/auth.types';
import {
  AccountNotActiveException,
  EmailAlreadyRegisteredException,
  InvalidCredentialsException,
} from '../../domain/auth.errors';
import {
  USER_REPOSITORY,
  type IUserRepository,
} from '../ports/auth.repository.ports';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { AuditService } from '../../../audit/application/audit.service';

/**
 * The domain layer intentionally does not import Prisma's generated
 * `FamilyRole` enum type directly (application/domain code should not
 * depend on the ORM's generated types — see docs/architecture/auth-module.md
 * §"Why a role-mapping helper"). Prisma guarantees the persisted value is
 * always one of these two strings, so this narrows safely rather than
 * silently trusting an arbitrary string.
 */
function toFamilyRole(role: string): IAuthenticatedUser['familyRole'] {
  if (role === 'OWNER' || role === 'PARENT') return role;
  throw new Error(`Unexpected family role value from persistence: "${role}"`);
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly userRepository: IUserRepository,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Registers a new parent account. Also creates that parent's Family and
   * makes them its OWNER, atomically (see PrismaUserRepository) — a
   * standalone "User" with no Family is not a valid state in this system,
   * so we never let one exist even transiently.
   */
  async register(input: IRegisterParentInput): Promise<IAuthenticatedUser> {
    const existing = await this.userRepository.findByEmail(input.email.toLowerCase());
    if (existing) {
      throw new EmailAlreadyRegisteredException(input.email);
    }

    const passwordHash = await this.passwordService.hash(input.password);
    const { user, family, membership } = await this.userRepository.createParentWithFamily(
      { ...input, email: input.email.toLowerCase() },
      passwordHash,
    );

    this.logger.log(`New parent registered: userId=${user.id} familyId=${family.id}`);

    await this.auditService.record({
      // PC-S-006. `/auth/*` runs under `@SystemRoute('AUTH_BOOTSTRAP')`, so the
      // tenant extension stamps nothing; the family is named explicitly, from
      // the row this transaction just created.
      familyId: family.id,
      actorType: 'USER',
      actorUserId: user.id,
      action: 'auth.register',
      entityType: 'User',
      entityId: user.id,
      metadata: { familyId: family.id },
    });

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      familyId: family.id,
      familyRole: toFamilyRole(membership.role),
    };
  }

  async login(
    email: string,
    password: string,
    context: IDeviceSessionContext,
  ): Promise<{ user: IAuthenticatedUser; tokens: ITokenPair }> {
    const user = await this.userRepository.findByEmail(email.toLowerCase());
    if (!user) {
      // Deliberately identical error/timing profile to "wrong password" —
      // never reveal whether an email is registered.
      throw new InvalidCredentialsException();
    }

    const passwordValid = await this.passwordService.verify(user.passwordHash, password);
    if (!passwordValid) {
      throw new InvalidCredentialsException();
    }

    if (user.status !== 'ACTIVE' && user.status !== 'PENDING_VERIFICATION') {
      throw new AccountNotActiveException();
    }

    const membership = await this.userRepository.findPrimaryFamilyMembership(user.id);
    if (!membership) {
      // Should be unreachable given registration always creates a family —
      // if it happens, it indicates data corruption, worth its own alert.
      this.logger.error(`User ${user.id} has no family membership.`);
      throw new AccountNotActiveException();
    }

    const tokens = await this.tokenService.issueTokenPair({
      subjectId: user.id,
      actorType: 'USER',
      familyId: membership.familyId,
      // PHASE C (A4 §SA-005). The role travels in the signed token so the
      // guard chain can decide without a database round-trip on every request.
      familyRole: toFamilyRole(membership.role),
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
    });

    await this.userRepository.updateLastLoginAt(user.id, new Date());

    await this.auditService.record({
      // PC-S-006. "Who signed into this family's account, and when" is the
      // single most useful line in a custody dispute, and it was not
      // tenant-scoped. The id comes from the membership resolved above.
      familyId: membership.familyId,
      actorType: 'USER',
      actorUserId: user.id,
      action: 'auth.login',
      entityType: 'User',
      entityId: user.id,
      ipAddress: context.ipAddress,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        familyId: membership.familyId,
        familyRole: toFamilyRole(membership.role),
      },
      tokens,
    };
  }

  async refresh(
    refreshToken: string,
    context: IDeviceSessionContext,
  ): Promise<ITokenPair> {
    const { payload, record } = await this.tokenService.verifyAndConsumeRefreshToken(refreshToken);

    // Rotation: the old token is already revoked (inside verifyAndConsume,
    // which also detects and punishes reuse of an already-rotated token —
    // SA-002). The successor stays in the SAME rotation family as the
    // token it replaces, so a later reuse anywhere in this chain can
    // still revoke the whole chain in one query.
    // PHASE C. The role is RE-READ from persistence on every rotation rather
    // than copied out of the old payload. Copying it would make the claim
    // immortal: a parent demoted from OWNER would keep OWNER for as long as
    // they kept refreshing, for up to the refresh token's 30 days. Re-reading
    // bounds the staleness of any role change to one 15-minute access-token
    // lifetime. (Device tokens have no persisted role — `CHILD` is derived
    // from `actorType` — so nothing is looked up for them.)
    const familyRole =
      payload.actorType === 'USER'
        ? await this.currentFamilyRole(payload.sub)
        : undefined;

    return this.tokenService.issueTokenPair({
      subjectId: payload.sub,
      actorType: payload.actorType,
      familyId: payload.familyId,
      familyRole,
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
      familyTokenId: record.familyTokenId,
      replacesTokenId: record.id,
    });
  }

  async logout(refreshToken: string): Promise<void> {
    // Reuses the same verify-and-revoke path as refresh; we simply don't
    // issue a replacement pair afterward.
    const { payload } = await this.tokenService.verifyAndConsumeRefreshToken(refreshToken);

    await this.auditService.record({
      // PC-S-006. From the VERIFIED refresh-token payload, not the request.
      familyId: payload.familyId,
      actorType: payload.actorType,
      actorUserId: payload.actorType === 'USER' ? payload.sub : undefined,
      action: 'auth.logout',
      entityType: payload.actorType === 'USER' ? 'User' : 'Device',
      entityId: payload.sub,
    });
  }

  /**
   * PHASE C. Best-effort re-read of the caller's current family role.
   *
   * Returns `undefined` when no membership can be found — which makes the
   * successor token carry NO role claim, which `principalRoleFromToken()`
   * degrades to `PARENT`. That is the fail-safe direction: a user whose
   * membership row has vanished cannot end up holding OWNER.
   */
  private async currentFamilyRole(
    userId: string,
  ): Promise<IAuthenticatedUser['familyRole'] | undefined> {
    const membership = await this.userRepository.findPrimaryFamilyMembership(userId);
    if (!membership) return undefined;
    return toFamilyRole(membership.role);
  }
}
