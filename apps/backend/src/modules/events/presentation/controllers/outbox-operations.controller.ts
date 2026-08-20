import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

import { InternalAdminGuard } from '../../../../common/guards/internal-admin.guard';
import { SystemRoute } from '../../../../common/tenancy/system-route.decorator';
import { PlatformAdminSurface } from '../../../../common/authz/roles.decorator';
import { OutboxRelay } from '../../application/outbox.relay';
import { OUTBOX_RELAY_DEFAULTS } from '../../domain/outbox.types';

class RecoverDeadLettersDto {
  /**
   * SCOPING IS MANDATORY IN SPIRIT AND OPTIONAL IN SHAPE. Both filters may be
   * omitted, which means "the oldest N dead letters of any type in any family"
   * — a real operator need after a platform-wide outage. It is bounded by
   * `limit` rather than forbidden, because forbidding it would push an operator
   * into writing the UPDATE by hand against production, which is strictly
   * worse than giving them a bounded, logged, idempotent button.
   */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  eventType?: string;

  @IsOptional()
  @IsUUID()
  familyId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(OUTBOX_RELAY_DEFAULTS.recoveryBatchSize)
  limit?: number;
}

/**
 * PHASE C (`PC-B-002`) — THE OPERATOR SURFACE FOR A DELIVERY THAT DIED.
 *
 * WHY THIS EXISTS AT ALL. F3 gave the outbox a `DEAD` status, a backoff and a
 * `maxAttempts` of 8, and then gave nobody a way to see or undo any of it.
 * `backlog()` counts `('PENDING','FAILED')` only, so a message reaching `DEAD`
 * makes the backlog gauge go DOWN — the one alert that existed got QUIETER as
 * the incident got worse. A reward could be sitting in `rewards_ledger_entries`
 * with its `REWARD_GRANTED` announcement permanently undelivered, and no query,
 * metric or route in the entire repository would have said so.
 *
 * WHY IT IS BEHIND `InternalAdminGuard` AND NOT A PARENT ROUTE. A dead letter
 * is a platform condition, not a family's business: the gauge is deliberately
 * cross-tenant (that is what makes it an alert), and recovery re-runs a
 * delivery. Neither belongs to a parent. `@PlatformAdminSurface()` states the
 * same thing to the role model that `@SystemRoute` states to the tenancy audit.
 *
 * WHY RECOVERY IS A POST AN OPERATOR PRESSES AND NOT A TIMER. A message that
 * has failed eight times is a message that may fail forever; requeueing it
 * automatically is how a poison message becomes an infinite loop and how an
 * incident becomes an outage. The judgement of "the downstream is healthy now"
 * is a human's, and this route is where that human expresses it.
 *
 * WHY IT IS SAFE TO PRESS TWICE. `SQL_RECOVER_DEAD_LETTERS` filters on
 * `status = 'DEAD'`, so the second call moves zero rows. And `PC-B-001` made
 * the redelivery itself non-duplicating: a completion whose grant already
 * exists re-emits its announcement, which then collides on
 * `domain_events (family_id, idempotency_key)`, and the notification collides
 * on `notifications (family_id, source_event_id, user_id)`. Recovery therefore
 * cannot produce a second reward, a second event or a second notification —
 * proven in `test/events/reward-delivery-recovery.e2e.spec.ts`, not asserted.
 */
@Controller('system/outbox')
export class OutboxOperationsController {
  constructor(private readonly relay: OutboxRelay) {}

  /**
   * THE GAUGE AN ALERT PAGES ON, plus the rows a human triages. `backlog` is
   * returned alongside deliberately: "12 dead and 0 pending" and "12 dead and
   * 4,000 pending" are different incidents, and an operator should not need two
   * calls to tell them apart.
   */
  @Get('dead-letters')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Dead-letter gauge over outbox_messages; cross-tenant because an undeliverable event is a platform-level condition, behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  async deadLetters() {
    const [deadLetters, backlog] = await Promise.all([
      this.relay.deadLetters(),
      this.relay.backlog(),
    ]);
    return { deadLetters, backlog };
  }

  /** Returns DEAD messages to PENDING. Deterministic, bounded, idempotent. */
  @Post('dead-letters/recover')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Operator-initiated recovery returns DEAD outbox messages to PENDING across tenants, behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  async recover(@Body() dto: RecoverDeadLettersDto) {
    const recovered = await this.relay.recoverDeadLetters({
      eventType: dto.eventType,
      familyId: dto.familyId,
      limit: dto.limit,
    });
    return { recovered, remaining: (await this.relay.deadLetters()).total };
  }
}
