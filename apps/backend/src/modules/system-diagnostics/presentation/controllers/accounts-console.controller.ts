import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';

import { InternalAdminGuard } from '../../../../common/guards/internal-admin.guard';
import { PlatformAdminSurface } from '../../../../common/authz/roles.decorator';
import { SystemRoute } from '../../../../common/tenancy/system-route.decorator';
import { AccountsConsoleService } from '../../application/accounts-console.service';
import { AccountActionsService } from '../../application/account-actions.service';
import { HouseholdDetailService } from '../../application/household-detail.service';
import { AccountsQueryDto } from '../dto/accounts-query.dto';
import { AccountActionDto } from '../dto/account-action.dto';

/**
 * WHO IS ON THIS PLATFORM — the first question an owner asks, and the one no
 * existing surface could answer.
 *
 * Everything platform-wide in this product until now has been an AGGREGATE:
 * `GET /analytics/dashboard-metrics` gives `totalFamilies`,
 * `/admin/growth/families` gives a count per market. An owner looking at
 * "1,204 families" cannot tell which of them is stuck on
 * PENDING_VERIFICATION, which has devices that stopped reporting a month ago,
 * or which is the one that just emailed support. That needs rows.
 *
 * BEHIND `InternalAdminGuard`, DECLARING `SUPER_ADMIN`, and reading across
 * every tenant deliberately — which is why `@SystemRoute` carries the reason
 * in the same vocabulary every other operator surface here uses.
 */
@Controller('system/accounts')
export class AccountsConsoleController {
  constructor(
    private readonly accounts: AccountsConsoleService,
    private readonly detail: HouseholdDetailService,
    private readonly actions: AccountActionsService,
  ) {}

  @Get()
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Platform owner household register; reads one row per family across every tenant, which is the whole question being asked, and is behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  list(@Query() query: AccountsQueryDto) {
    return this.accounts.list({
      limit: query.limit,
      cursor: query.cursor ?? null,
      search: query.search ?? null,
    });
  }

  /**
   * ONE HOUSEHOLD IN DETAIL — members, children, devices, subscription,
   * entitlements and the audit trail. This is the difference between a console
   * that reports and one an owner can investigate a complaint with.
   *
   * A child appears by first name and AGE BAND. The date of birth is not
   * selected by the query at all — the safest way to not disclose a field is
   * not to read it.
   */
  @Get(':familyId')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Platform owner household detail; reads one named family across the tenant boundary for support and investigation, behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  household(@Param('familyId', new ParseUUIDPipe()) familyId: string) {
    return this.detail.get(familyId);
  }

  /**
   * SUSPEND OR REACTIVATE ONE USER. Reversible by construction: a status flag,
   * no row removed, nothing cascaded. Account DELETION is a different module
   * with its own retention rules and is deliberately not reachable from here.
   */
  @Post('actions/status')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Operator suspends or reactivates one user resolved by id; the household is derived server-side for the audit row, and the route is behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  @HttpCode(HttpStatus.OK)
  setStatus(@Body() dto: AccountActionDto) {
    return this.actions.setStatus(dto);
  }
}
