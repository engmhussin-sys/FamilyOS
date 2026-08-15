import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';

import { ScreenTimeService } from '../../application/services/screen-time.service';
import { SetScreenTimePolicyDto } from '../dto/set-screen-time-policy.dto';
import { CreateAppBlockRuleDto } from '../dto/create-app-block-rule.dto';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { ParentSurface } from '../../../../common/authz/roles.decorator';

@Controller('children/:childId/screen-time-policy')
@UseGuards(JwtAuthGuard)
export class ScreenTimeController {
  constructor(private readonly screenTimeService: ScreenTimeService) {}

  @Get()
  @ParentSurface()
  getPolicy(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.screenTimeService.getPolicy(childId, user.familyId!);
  }

  /**
   * F4. The allowance a device should actually enforce: the parent's base
   * policy PLUS the bonus minutes the child has earned and not used up. A
   * separate route rather than a change to `GET /` so no existing client's
   * response shape moves under it.
   */
  @Get('effective')
  @ParentSurface()
  getEffectivePolicy(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.screenTimeService.getEffectivePolicy(childId, user.familyId!);
  }

  @Post()
  @ParentSurface()
  setPolicy(
    @Param('childId') childId: string,
    @Body() dto: SetScreenTimePolicyDto,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.screenTimeService.setPolicy(childId, user.familyId!, user.sub, dto);
  }
}

/** CLOSES A REAL GAP: `AppBlockRule` had no controller at all before
 * this. Separate `@Controller` (own base path) rather than nested
 * under screen-time-policy's — an app block rule isn't a sub-resource
 * of the policy, it's its own resource that happens to live in the
 * same module per this module's existing "Parental Control Engine"
 * scope. */
@Controller('children/:childId/app-block-rules')
@UseGuards(JwtAuthGuard)
export class AppBlockRuleController {
  constructor(private readonly screenTimeService: ScreenTimeService) {}

  @Get()
  @ParentSurface()
  listRules(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.screenTimeService.listAppBlockRules(childId, user.familyId!);
  }

  @Post()
  @ParentSurface()
  createRule(@Param('childId') childId: string, @Body() dto: CreateAppBlockRuleDto, @CurrentUser() user: IJwtPayload) {
    return this.screenTimeService.createAppBlockRule(childId, user.familyId!, user.sub, dto);
  }

  @Delete(':ruleId')
  @ParentSurface()
  deactivateRule(
    @Param('childId') childId: string,
    @Param('ruleId') ruleId: string,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.screenTimeService.deactivateAppBlockRule(ruleId, childId, user.familyId!, user.sub);
  }
}
