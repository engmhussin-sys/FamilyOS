import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Query, UseGuards } from '@nestjs/common';

import { InternalAdminGuard } from '../../../../common/guards/internal-admin.guard';
import { PlatformAdminSurface } from '../../../../common/authz/roles.decorator';
import { SystemRoute } from '../../../../common/tenancy/system-route.decorator';
import { OperatorGrantService } from '../../application/services/operator-grant.service';
import { PlanCatalogueService } from '../../application/services/plan-catalogue.service';
import { UpsertPlanDto } from '../dto/plan-catalogue.dto';
import { OperatorGrantDto, OperatorGrantFeaturesDto, OperatorRevokeDto } from '../dto/operator-grant.dto';
import { OperatorLookupDto } from '../dto/operator-lookup.dto';

/**
 * ===========================================================================
 * AN OPERATOR SURFACE FOR COMPING A PLAN. EVERY ROUTE IS BEHIND
 * `InternalAdminGuard` AND DECLARES `SUPER_ADMIN`.
 * ===========================================================================
 *
 * WHAT IT IS FOR. Giving a household full features without a payment — a
 * tester, a pilot family, a support apology, a partner campaign — and taking it
 * back afterwards. The alternative, which is what happens when this does not
 * exist, is somebody editing `subscriptions` in a SQL console: untraceable,
 * unreversible, and afterwards indistinguishable from a real purchase.
 *
 * IT ADDS NO NEW WAY TO BE ENTITLED. `EntitlementService.hasFeature` is still
 * the single authority, an `entitlements` row still outranks the
 * `subscriptions` fallback, and ending a comp uses `revokeAll` — the same
 * method a refund uses. The one thing this controller introduces is a door,
 * and the door is the guard's.
 *
 * NO ROUTE HERE TAKES A `familyId`. The household is resolved from the parent's
 * email server-side, which is both the identifier an operator actually has and
 * the rule CI RULE 3 enforces on every request DTO in this codebase.
 *
 * ============================== REMOVING IT ================================
 *
 * This file, `OperatorGrantService`, the two DTO files and their tests are the
 * whole feature. Delete them and it is gone: no migration to reverse, because a
 * comp is an ordinary `entitlements` row with `source = 'MANUAL'`, written by a
 * method that predates this controller. Grants already issued keep their end
 * date and lapse on their own; revoke first to end them sooner.
 *
 * To disable it WITHOUT a deploy, unset `INTERNAL_ADMIN_API_KEY` on the
 * service: the guard fails closed and every route here refuses — along with
 * every other operator surface, which is the honest cost of that lever.
 */
@Controller('system/billing')
export class BillingOperationsController {
  constructor(
    private readonly grants: OperatorGrantService,
    private readonly catalogue: PlanCatalogueService,
  ) {}

  /**
   * THE PLAN CATALOGUE. It is on this controller rather than one of its own
   * because it is the same operator, the same key, and the same question:
   * "what does this platform sell, and what has this household got".
   *
   * Returns EVERY tier including inactive ones — `findAllActivePlans` is the
   * customer-facing list, and a tier somebody deactivated is precisely the row
   * an operator has come to look at.
   */
  @Get('plans')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Operator plan catalogue; plan_definitions is a global table with no family_id, and is behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  listPlans() {
    return this.catalogue.list();
  }

  /**
   * CREATE OR REPLACE ONE TIER. There is deliberately NO DELETE: existing
   * subscriptions point at a tier, and removing its row would leave them
   * pointing at nothing. `isActive: false` retires a plan from the customer
   * list while keeping every reference to it valid.
   */
  @Put('plans')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Operator writes one row of the global plan catalogue; touches no tenant-scoped table and is behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  @HttpCode(HttpStatus.OK)
  upsertPlan(@Body() dto: UpsertPlanDto) {
    return this.catalogue.upsert(dto);
  }

  /**
   * WHAT IS LIVE ON THIS HOUSEHOLD RIGHT NOW — read this before granting and
   * after revoking. An operator who cannot see the current state guesses, and
   * a second grant on top of a live one is how a comp quietly becomes
   * permanent.
   */
  @Get('grants')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Operator entitlement console; resolves one household from an email and reads its entitlement rows, so it runs without a tenant and is behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  describe(@Query() query: OperatorLookupDto) {
    return this.grants.describe(query.email);
  }

  /**
   * COMP A PLAN FOR A BOUNDED NUMBER OF DAYS. `days` and `reason` are both
   * required — see the DTO for why neither is optional.
   */
  @Post('grants')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Operator grants a time-boxed manual entitlement to one household resolved from an email; writes no tenant-scoped row other than that household\'s own entitlements and audit entry, and is behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  @HttpCode(HttpStatus.OK)
  grant(@Body() dto: OperatorGrantDto) {
    return this.grants.grant(dto);
  }

  /**
   * COMP EXPLICIT FEATURES — use this when `POST grants` answers
   * `PLAN_CATALOGUE_EMPTY`, which it will on any database built from this
   * repository's migrations: `plan_definitions` is documented as seeded once
   * and no migration seeds it. The six feature keys are a closed vocabulary in
   * code, so this path needs no business data — and deciding a price in order
   * to unblock a tester would be inventing one.
   */
  @Post('grants/features')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Operator grants named, time-boxed entitlements to one household resolved from an email, without consulting the plan catalogue, behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  @HttpCode(HttpStatus.OK)
  grantFeatures(@Body() dto: OperatorGrantFeaturesDto) {
    return this.grants.grantFeatures(dto);
  }

  /**
   * END EVERY GRANT ON THE HOUSEHOLD.
   *
   * `POST .../revoke` rather than `DELETE grants`, because this takes a body —
   * the reason is mandatory — and a DELETE with a required body is a request
   * shape that proxies, browsers and HTTP clients disagree about. The action is
   * not idempotent in an interesting way either: the returned count differs
   * between the first call and the second, and that difference is information
   * the operator should see.
   */
  @Post('grants/revoke')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Operator revokes every entitlement on one household resolved from an email, using the same path a refund uses, behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  @HttpCode(HttpStatus.OK)
  revoke(@Body() dto: OperatorRevokeDto) {
    return this.grants.revoke(dto);
  }
}
