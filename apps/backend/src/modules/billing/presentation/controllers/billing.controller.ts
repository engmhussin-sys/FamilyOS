import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { PlanService } from '../../application/services/plan.service';
import { SubscriptionService } from '../../application/services/subscription.service';
import { TrialManager } from '../../application/services/trial-manager.service';
import { SubscribeDto } from '../dto/subscribe.dto';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { OwnerOnly, ParentSurface } from '../../../../common/authz/roles.decorator';

@Controller('billing')
@UseGuards(JwtAuthGuard)
export class BillingController {
  constructor(
    private readonly planService: PlanService,
    private readonly subscriptionService: SubscriptionService,
    private readonly trialManager: TrialManager,
  ) {}

  @Get('plans')
  @ParentSurface()
  listPlans() {
    return this.planService.listActivePlans();
  }

  /**
   * SPRINT F1 (DECISION 3) — `cancellation` IS NEW, AND IT IS THE SERVER'S OWN
   * ANSWER TO A QUESTION THE CLIENT USED TO ANSWER FOR ITSELF.
   *
   * The client gated its cancel affordance on `status === 'ACTIVE'`, which left
   * a `GRACE_PERIOD` household — entitled, treated as paying, and in that state
   * precisely because its card just failed — unable to leave. The set of states
   * that may cancel now lives in `subscription-status.ts` with a written reason
   * per state, is ENFORCED by `POST /billing/cancel`, and is REPORTED here so
   * the two can never disagree:
   *
   *   cancellation: { canCancel: boolean,
   *                   status: 'TRIAL'|'ACTIVE'|'PAST_DUE'|'GRACE_PERIOD'
   *                          |'PENDING'|'CANCELLED'|'EXPIRED'|'REFUNDED'|null,
   *                   accessUntil: ISO-8601 | null }
   *
   * `status` is the CANONICAL vocabulary (`TRIAL`, `CANCELLED`), not the
   * database's (`TRIALING`, `CANCELED`) — the two meet in exactly one file, and
   * this is the one that leaves the building. `accessUntil` is what the
   * household KEEPS after cancelling, because cancelling ends renewal and
   * revokes nothing.
   */
  @Get('subscription')
  @ParentSurface()
  async getSubscription(@CurrentUser() user: IJwtPayload) {
    const [subscription, isInTrial, trialDaysRemaining, cancellation] = await Promise.all([
      this.subscriptionService.getForFamily(user.familyId!),
      this.trialManager.isInTrial(user.familyId!),
      this.trialManager.trialDaysRemaining(user.familyId!),
      this.subscriptionService.describeCancellability(user.familyId!),
    ]);
    return { subscription, isInTrial, trialDaysRemaining, cancellation };
  }

  @Post('trial/start')
  @ParentSurface()
  startTrial(@CurrentUser() user: IJwtPayload) {
    return this.subscriptionService.startTrial(user.familyId!);
  }

  /**
   * CLOSING A KNOWN GAP (documented since Sprint 10's SECURITY_REVIEW.md
   * and repeated in every subsequent readiness report): this endpoint
   * had no endpoint-specific rate limit, unlike auth's login/register.
   * The `MANUAL` payment adapter always succeeds, so an unthrottled
   * loop here could churn subscription state indefinitely. Same
   * @Throttle pattern already used for auth \u2014 5/min is generous for a
   * real user retrying a failed card, tight enough to block scripted abuse.
   */
  @Post('subscribe')
  // PHASE C. `FamilyRole.OWNER` is documented in schema.prisma as the BILLING
  // owner. Money leaves one person's card; a co-parent may read the plan and
  // the history (below) but may not commit the family to a charge.
  @OwnerOnly()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  subscribe(@Body() dto: SubscribeDto, @CurrentUser() user: IJwtPayload) {
    return this.subscriptionService.subscribe(user.familyId!, dto.planTier, dto.provider, user.sub);
  }

  /**
   * SPRINT F1 (DECISION 3). TWO THINGS CHANGED, AND THE SECOND CORRECTS A
   * COMMENT THAT WAS WRONG ABOUT THE PRODUCT.
   *
   *   1. THE RESPONSE HAS A BODY. `{ status, canceledAt, accessUntil }` — what
   *      changed and what the household keeps. A client that had to infer
   *      «you still have until the 19th» from a status would infer it wrong.
   *   2. THE COMMENT BELOW USED TO SAY «cancelling removes every paid
   *      entitlement from the whole family». IT DOES NOT AND MUST NOT. It ends
   *      RENEWAL: `subscriptions.status` and `canceled_at` move, nothing is
   *      revoked, `current_period_end` is not shortened, and every
   *      `Entitlement` row stays live until its own `valid_until`. A REFUND is
   *      the thing that revokes immediately, and it is a different path.
   *
   * A refusal is a 409 carrying `{ code, messageAr, status }` —
   * `SUBSCRIPTION_ALREADY_CANCELLED` when renewal has already been stopped,
   * `SUBSCRIPTION_NOT_CANCELLABLE` when there is no renewal to stop.
   */
  @Post('cancel')
  // PHASE C. Money and the household's commitment belong to the billing owner.
  // Symmetric with subscribe: the person who can start the charge is the person
  // who can stop it.
  @OwnerOnly()
  async cancel(@CurrentUser() user: IJwtPayload) {
    return this.subscriptionService.cancel(user.familyId!, user.sub);
  }

  @Get('history')
  @ParentSurface()
  getBillingHistory(@CurrentUser() user: IJwtPayload) {
    return this.subscriptionService.getBillingHistory(user.familyId!);
  }
}
