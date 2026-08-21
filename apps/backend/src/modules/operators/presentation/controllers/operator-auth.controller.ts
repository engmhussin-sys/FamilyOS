import { Body, Controller, Delete, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, Length, MaxLength } from 'class-validator';

import { PlatformAdminSurface } from '../../../../common/authz/roles.decorator';
import { InternalAdminGuard } from '../../../../common/guards/internal-admin.guard';
import { SystemRoute } from '../../../../common/tenancy/system-route.decorator';
import { OperatorService } from '../../application/operator.service';
import { OperatorAuthGuard } from '../guards/operator-auth.guard';
import { RequirePermission } from '../decorators/require-permission.decorator';
import type { OperatorSession } from '../../application/operator-session.service';

class SignInDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @Length(8, 200)
  password!: string;
}

class BootstrapDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @Length(2, 120)
  fullName!: string;

  /**
   * Long, because this is the credential for the whole operator console and it
   * is typed once by whoever runs the deployment. Twelve is the floor rather
   * than eight for that reason alone.
   */
  @IsString()
  @Length(12, 200)
  password!: string;
}

/**
 * ===========================================================================
 * THE WAY IN — behind the shared key, which is now the OUTER gate.
 * ===========================================================================
 *
 * Every route here carries `InternalAdminGuard`, so none of them is reachable
 * without the platform key. That is what keeps the operator LOGIN itself off
 * the public internet: a sign-in form that anyone can reach is a password
 * oracle for a console that can suspend households.
 *
 * ── WHY SIGN-IN IS NOT IN `PUBLIC_ROUTES` ──────────────────────────────
 *
 * `POST /auth/login` is public because a parent has no other credential to
 * present. An operator does: the shared key. So the operator login is the one
 * authentication surface in this codebase that is itself authenticated, and the
 * guard-coverage ratchet sees a guarded route rather than an allow-list entry.
 *
 * ── THE BOOTSTRAP CLOSES ITSELF ────────────────────────────────────────
 *
 * `POST /system/operators/bootstrap` refuses the moment any operator row
 * exists. It is reachable for the window between the first migration and the
 * first operator and never again, and it needs no session because on a fresh
 * deployment there is nobody to have one. The alternative — a seeded
 * credential in a migration — would be a password that ships in a repository
 * and lives in production forever.
 *
 * ── THROTTLED, BECAUSE A KEY IS NOT A RATE LIMIT ───────────────────────
 *
 * Holding the shared key gets you to this route; it does not entitle you to ten
 * thousand password attempts against a named operator.
 */
@Controller('system/operators')
export class OperatorAuthController {
  constructor(private readonly operators: OperatorService) {}

  @Post('session')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @PlatformAdminSurface()
  @SystemRoute(
    'AUTH_BOOTSTRAP',
    'Operator sign-in resolves a member of platform staff by email; staff belong to no household, so there is no tenant to establish.',
  )
  @UseGuards(InternalAdminGuard)
  async signIn(@Body() dto: SignInDto, @Req() request: { ip?: string }) {
    const { token, session } = await this.operators.signIn(dto.email, dto.password, request.ip);
    // The token is returned ONCE and never again. It is not logged, not stored
    // in plaintext anywhere, and the server holds only its SHA-256.
    return { token, operator: { email: session.email, role: session.role, issuedAt: session.issuedAt } };
  }

  @Delete('session')
  @HttpCode(204)
  @PlatformAdminSurface()
  @RequirePermission('operators.read')
  @SystemRoute('ADMIN_CONSOLE', 'Operator sign-out ends one platform-staff session; staff belong to no household.')
  @UseGuards(OperatorAuthGuard)
  async signOut(@Req() request: { operator: OperatorSession; headers: Record<string, string | string[]> }) {
    const header = request.headers[OperatorAuthGuard.SESSION_HEADER];
    const token = Array.isArray(header) ? header[0] : header;
    if (typeof token === 'string') await this.operators.signOut(token, request.operator);
  }

  /** Who am I — the call a console makes on load to decide what to render. */
  @Get('me')
  @PlatformAdminSurface()
  @RequirePermission('operators.read')
  @SystemRoute('ADMIN_CONSOLE', 'Returns the calling operator\'s own identity; staff belong to no household.')
  @UseGuards(OperatorAuthGuard)
  me(@Req() request: { operator: OperatorSession }) {
    const { operatorId, email, role, issuedAt } = request.operator;
    return { operatorId, email, role, issuedAt };
  }

  @Post('bootstrap')
  @HttpCode(201)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @PlatformAdminSurface()
  @SystemRoute(
    'AUTH_BOOTSTRAP',
    'Creates the first platform operator on a deployment that has none; refuses once any operator exists.',
  )
  @UseGuards(InternalAdminGuard)
  async bootstrap(@Body() dto: BootstrapDto) {
    return this.operators.bootstrapFirstOperator(dto);
  }
}
