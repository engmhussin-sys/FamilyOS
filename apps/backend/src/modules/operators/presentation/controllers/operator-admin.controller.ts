import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { OperatorRole } from '@prisma/client';
import { IsEmail, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';

import { OPERATOR_ROLES } from '../../../../common/authz/permissions';
import { PlatformAdminSurface } from '../../../../common/authz/roles.decorator';
import { SystemRoute } from '../../../../common/tenancy/system-route.decorator';
import { OperatorService } from '../../application/operator.service';
import { OperatorAuthGuard } from '../guards/operator-auth.guard';
import { RequirePermission } from '../decorators/require-permission.decorator';
import type { OperatorSession } from '../../application/operator-session.service';

/**
 * The valid roles come from the MATRIX, not from a list retyped here. A second
 * copy is a second thing to update, and the one that gets forgotten is always
 * the validator — which fails open by accepting a role the matrix does not
 * grant, or fails closed by rejecting one it does.
 */
const ROLES = OPERATOR_ROLES as readonly string[];
const STATUSES = ['ACTIVE', 'SUSPENDED', 'REVOKED'] as const;

class CreateOperatorDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @Length(2, 120)
  fullName!: string;

  /** Twelve, for the same reason the bootstrap asks for twelve: this is a
   * credential for a console that can suspend households. */
  @IsString()
  @Length(12, 200)
  password!: string;

  @IsIn(ROLES)
  role!: OperatorRole;

  /**
   * REQUIRED, and long enough to be a sentence. `operator.created` is one of the
   * rows a compliance review reads, and «why does this person have access» is
   * the question it is read to answer.
   */
  @IsString()
  @Length(10, 500)
  reason!: string;
}

class UpdateOperatorDto {
  @IsOptional()
  @IsIn(ROLES)
  role?: OperatorRole;

  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];

  @IsString()
  @Length(10, 500)
  reason!: string;
}

/**
 * ===========================================================================
 * MANAGING STAFF — the routes without which `operators.manage` had no holder.
 * ===========================================================================
 *
 * `OperatorService.create` and `OperatorService.update` were written, tested and
 * REACHABLE FROM NOTHING. The permission `operators.manage` existed in the
 * matrix, was granted to SUPER_ADMIN, and no route in the application ever asked
 * for it — so the one capability the whole sprint was built to provide,
 * REVOKING ONE PERSON'S ACCESS WITHOUT REVOKING EVERYONE'S, could not actually
 * be performed by anybody. Found by review, not by a test, because a permission
 * with no route is exactly the thing a test suite has no reason to notice.
 *
 * ── THREE ROUTES, TWO PERMISSIONS ──────────────────────────────────────
 *
 *   GET   /system/operators           `operators.read`    the staff directory
 *   POST  /system/operators           `operators.manage`  add a member of staff
 *   PATCH /system/operators/:id       `operators.manage`  re-role, suspend, revoke
 *
 * READING THE DIRECTORY AND CHANGING IT ARE DIFFERENT ACTS, so they are
 * different permissions — the same rule that keeps `safety.read` apart from
 * `safety.read_content`. SUPPORT and SAFETY hold neither: who else works here is
 * not information either desk needs to do its job.
 *
 * ── EVERY MUTATION CARRIES A REASON, AND THE SERVICE DEMANDS IT ────────
 *
 * `reason` is required by the DTO and required AGAIN by `AuditService`, which
 * throws on `operator.updated` or `operator.revoked` with an empty one. Two
 * checks, because the DTO protects the route and the audit service protects the
 * table — and the table is the thing a compliance review actually opens.
 *
 * ── THERE IS NO DELETE ─────────────────────────────────────────────────
 *
 * Revocation is a status and a tombstone (`revokedAt`), never a removed row.
 * The audit rows an operator wrote name an operator that must still exist, and
 * deleting the person would turn their entire history into dangling uuids.
 */
@Controller('system/operators')
export class OperatorAdminController {
  constructor(private readonly operators: OperatorService) {}

  @Get()
  @PlatformAdminSurface()
  @RequirePermission('operators.read')
  @SystemRoute('ADMIN_CONSOLE', 'The staff directory lists platform operators; staff belong to no household.')
  @UseGuards(OperatorAuthGuard)
  async list() {
    const operators = await this.operators.list();
    return { operators, total: operators.length };
  }

  @Post()
  @HttpCode(201)
  @PlatformAdminSurface()
  @RequirePermission('operators.manage')
  @SystemRoute('ADMIN_CONSOLE', 'A platform operator creates another operator; staff belong to no household.')
  @UseGuards(OperatorAuthGuard)
  async create(@Body() dto: CreateOperatorDto, @Req() request: { operator: OperatorSession }) {
    return this.operators.create(
      { email: dto.email, fullName: dto.fullName, password: dto.password, role: dto.role },
      request.operator,
      dto.reason,
    );
  }

  /**
   * ROLE AND STATUS THROUGH ONE ROUTE, because they have one consequence: every
   * live session this person holds is killed. Two routes would be two places to
   * remember that, and the second one would forget.
   */
  @Patch(':operatorId')
  @PlatformAdminSurface()
  @RequirePermission('operators.manage')
  @SystemRoute(
    'ADMIN_CONSOLE',
    'A platform operator changes another operator\'s role or status; staff belong to no household.',
  )
  @UseGuards(OperatorAuthGuard)
  async update(
    @Param('operatorId', ParseUUIDPipe) operatorId: string,
    @Body() dto: UpdateOperatorDto,
    @Req() request: { operator: OperatorSession },
  ) {
    // A PATCH that changes nothing still kills every session this person holds.
    // Doing that by accident is not a no-op, so an empty change is refused.
    if (dto.role === undefined && dto.status === undefined) {
      throw new BadRequestException({
        code: 'OPERATOR_UPDATE_EMPTY',
        message: 'Provide role, status, or both.',
        messageAr: 'حدّد الدور أو الحالة أو كليهما.',
      });
    }

    return this.operators.update(
      operatorId,
      { role: dto.role, status: dto.status },
      request.operator,
      dto.reason,
    );
  }
}
