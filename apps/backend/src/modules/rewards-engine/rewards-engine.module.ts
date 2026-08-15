import { Module } from '@nestjs/common';

import { AiCoreModule } from '../ai-core/ai-core.module';
import { ChildrenModule } from '../children/children.module';
import { EventsModule } from '../events/events.module';
import { PairingModule } from '../pairing/pairing.module';
import { AchievementOutcomeConsumer } from './application/consumers/achievement-outcome.consumer';
import { RewardSideEffectConsumer } from './application/consumers/reward-side-effect.consumer';
import { AchievementService } from './application/services/achievement.service';
import { AchievementEvidenceService } from './application/services/achievement-evidence.service';
import { QuizService } from './application/services/quiz.service';
import { EvidenceStorageModule } from './evidence-storage.module';
import { RewardPayoutService } from './application/services/reward-payout.service';
import { RewardProgramService } from './application/services/reward-program.service';
import { RewardSuggestionService } from './application/services/reward-suggestion.service';
import { PrismaRewardProgramRepository } from './infrastructure/repositories/prisma-reward-program.repository';
import { ChildAchievementsController } from './presentation/controllers/child-achievements.controller';
import { RewardProgramsController } from './presentation/controllers/reward-programs.controller';

/**
 * Sprint F4 — the Smart Learning & Reward Engine.
 *
 * WHAT THIS MODULE DOES NOT CONTAIN, which is the point:
 *
 *   - no reward ledger. `RewardsEngineService` (life-intelligence) writes it,
 *     unmodified, against the companion `RewardRule` rows a program
 *     materialises.
 *   - no notification logic. `NotificationRewardConsumer` (events) already
 *     subscribes to `REWARD_GRANTED`, so a program's reward notifies through
 *     the same fatigue-guarded pipeline as every other reward — and does NOT
 *     notify when nothing was granted, because nothing is emitted.
 *   - no event bus and no outbox. It imports `EventsModule` and writes through
 *     `OutboxWriter`, so every F4 event is transactional and replay-safe by the
 *     same machinery F3 proved.
 *   - no streak table. Streaks are recomputed from verified rows via the
 *     existing `computeCurrentStreak`.
 *   - no second AI architecture. `RewardSuggestionService` is deterministic and
 *     borrows `AI_PROVIDER` for optional Arabic phrasing only.
 *
 * `ConsumerIdempotency`, `OutboxWriter` and `EVENT_SUBSCRIBER` all come from
 * `EventsModule`'s exports, so the two consumers here register on the SAME bus
 * instance the relay publishes to. Registering a second bus would have produced
 * consumers that never fire — silently.
 */
@Module({
  imports: [EventsModule, ChildrenModule, PairingModule, AiCoreModule, EvidenceStorageModule],
  controllers: [RewardProgramsController, ChildAchievementsController],
  providers: [
    PrismaRewardProgramRepository,
    RewardProgramService,
    AchievementService,
    // B5 — `QuizService` (PA-B-017) and `AchievementEvidenceService`
    // (PA-B-019). Both are collaborators of the EXISTING `AchievementService`,
    // not rivals to it: there is still exactly one `submit()` and exactly one
    // `markVerified()`, and neither new service can emit an event or write a
    // ledger row.
    QuizService,
    AchievementEvidenceService,
    RewardPayoutService,
    RewardSuggestionService,
    AchievementOutcomeConsumer,
    RewardSideEffectConsumer,
  ],
  exports: [RewardProgramService, AchievementService, RewardPayoutService, AchievementEvidenceService],
})
export class RewardsEngineModule {}
