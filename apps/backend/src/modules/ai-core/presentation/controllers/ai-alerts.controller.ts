import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';

import { AI_ALERT_REPOSITORY, type IAiAlertRepository } from '../../domain/ai-alert.types';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { ParentSurface } from '../../../../common/authz/roles.decorator';

/**
 * ============================================================================
 * THE PARENT'S READ SIDE OF `ai_alerts`.
 * ============================================================================
 *
 * WHY IT HAD TO BE ADDED RATHER THAN REUSED. `grep -rn "aiAlert" src/` returned
 * ONE line before this work — `GrowthAlertsService.aiSafetyIncident`, an
 * OPERATOR page behind `InternalAdminGuard`, not a parent surface. So the table
 * `schema.prisma` calls «the AI layer's output contract — parents see alerts»
 * had no writer AND no parent-facing reader: connecting the producer alone
 * would have produced rows nobody in the product could see.
 *
 * IT IS A COLLECTION ROUTE, AND THAT IS DELIBERATE. There is no
 * `GET /ai-core/alerts/:alertId`: a parent needs the list, an id-addressed
 * route is one more door for `test/tenancy/cross-tenant-probe.e2e.spec.ts` to
 * have to aim at, and nothing in the product needs to deep-link a single alert
 * yet. (`notification-destination.ts`'s `safetyDestination` says «the alert row
 * when a producer ever carries one» — wiring that link is a follow-up in the
 * notifications module, which this work does not own.)
 *
 * THE FAMILY COMES FROM THE TOKEN. `user.familyId` is a signed claim; there is
 * no `familyId` query parameter, no body, and nothing a client can say that
 * changes which rows are returned — the server is authoritative, and
 * `ci:tenant-guard` RULE 3 enforces that this stays true.
 *
 * WHAT THE PAYLOAD DOES NOT CONTAIN. `source_event_id` — the server's dedupe
 * key — is excluded by the repository's own `select`, and no column of an
 * `ai_alerts` row can hold the child's words in the first place. The parent
 * gets a classification, a human-written next step, and which child it is
 * about.
 */
@Controller('ai-core')
export class AiAlertsController {
  /** A parent reads a list, not an archive. Bounded here rather than by the
   * caller so that a client cannot ask for the whole table. */
  private static readonly DEFAULT_LIMIT = 50;
  private static readonly MAX_LIMIT = 200;

  constructor(@Inject(AI_ALERT_REPOSITORY) private readonly alerts: IAiAlertRepository) {}

  @Get('alerts')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  listAlerts(@CurrentUser() user: IJwtPayload, @Query('limit') limit?: string) {
    const parsed = limit ? Number.parseInt(limit, 10) : AiAlertsController.DEFAULT_LIMIT;
    const safeLimit =
      Number.isFinite(parsed) && parsed > 0 && parsed <= AiAlertsController.MAX_LIMIT
        ? parsed
        : AiAlertsController.DEFAULT_LIMIT;
    return this.alerts.listForFamily(user.familyId!, safeLimit);
  }
}
