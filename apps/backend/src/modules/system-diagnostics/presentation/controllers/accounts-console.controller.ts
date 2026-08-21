import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { InternalAdminGuard } from '../../../../common/guards/internal-admin.guard';
import { PlatformAdminSurface } from '../../../../common/authz/roles.decorator';
import { SystemRoute } from '../../../../common/tenancy/system-route.decorator';
import { AccountsConsoleService } from '../../application/accounts-console.service';
import { AccountsQueryDto } from '../dto/accounts-query.dto';

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
  constructor(private readonly accounts: AccountsConsoleService) {}

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
}
