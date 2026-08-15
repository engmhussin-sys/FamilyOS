import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { OwnerOnly, ParentSurface } from '../../../../common/authz/roles.decorator';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { FamilyMembershipService } from '../../application/services/family-membership.service';
import { TransferOwnershipDto } from '../dto/transfer-ownership.dto';

/**
 * PHASE C — the destructive intra-family surface.
 *
 * GUARDS, per the pattern F1/F2 established: `@UseGuards(JwtAuthGuard)` PER
 * ROUTE, never class-level, and never a parent guard stacked with a device
 * guard on the same handler. `familyId` is taken from the verified token on
 * every route and never appears in a path, a query or a body — the only id a
 * client may name here is the OTHER MEMBER, and that member is looked up
 * inside the caller's own family or not at all.
 */
@Controller('families')
export class FamiliesController {
  constructor(private readonly membership: FamilyMembershipService) {}

  /**
   * Both parents may see the roster. Hiding a co-parent from a co-parent would
   * be security theatre — they share a household — and the Parent App needs it
   * to render "you are a co-parent; ask <name> to change the plan".
   */
  @Get('members')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  listMembers(@CurrentUser() user: IJwtPayload) {
    return this.membership.listMembers({
      familyId: user.familyId as string,
      actingUserId: user.sub,
    });
  }

  /**
   * The single most dangerous non-deleting action in the product: after it,
   * someone else can delete the family. Rate-limited like account deletion.
   */
  @Post('ownership/transfer')
  @OwnerOnly()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async transferOwnership(
    @Body() dto: TransferOwnershipDto,
    @CurrentUser() user: IJwtPayload,
    @Ip() ip: string,
  ): Promise<void> {
    await this.membership.transferOwnership(
      { familyId: user.familyId as string, actingUserId: user.sub, ipAddress: ip },
      dto.toUserId,
    );
  }

  /**
   * A4's custody-dispute scenario, named: one parent removing the other. It is
   * OWNER-only at the guard, re-verified against `family_members` inside the
   * transaction, audited with tenant scope, and it revokes the removed
   * member's refresh tokens so the removal is effective rather than nominal.
   */
  @Delete('members/:userId')
  @OwnerOnly()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: IJwtPayload,
    @Ip() ip: string,
  ): Promise<void> {
    await this.membership.removeMember(
      { familyId: user.familyId as string, actingUserId: user.sub, ipAddress: ip },
      userId,
    );
  }
}
