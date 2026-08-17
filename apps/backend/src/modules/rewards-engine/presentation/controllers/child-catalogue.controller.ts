import { Controller, Get, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { ChildSurface } from '../../../../common/authz/roles.decorator';
import { DeviceJwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { PairingOrchestratorService } from '../../../pairing/application/services/pairing-orchestrator.service';
import { LearningCatalogueService } from '../../application/services/learning-catalogue.service';

/**
 * CHILD SURFACE — `/api/v1/self/catalogue`. «إيه اللي عايز تتعلمه النهاردة؟»
 *
 * THE GAP THIS CLOSES, in the child app's own words
 * (`domain_chooser.dart`): «The fuller flow in the product brief — child picks
 * a domain, the Smart Reward Engine proposes a suitable activity and duration
 * inside it — needs a child-facing route that does not exist. `reward-programs`
 * is parent-only (`@Controller('reward-programs')`, parent guard), and the only
 * two `self/*` controllers are `self/achievements` and `self/coach`; neither
 * serves a catalogue or an activity proposal.» Until this file, a child could
 * see the goals a parent had already created and could not discover that
 * PROGRAMMING, SCIENCE or FIQH existed at all.
 *
 * THE SECURITY SHAPE — the same paragraph `ChildAchievementsController` and
 * `ChildCoachController` state about themselves, because it is deliberately the
 * same shape:
 *
 *   - Every route carries `@UseGuards(DeviceJwtAuthGuard)` PER ROUTE — the
 *     `'device-jwt'` Passport strategy. A parent token cannot reach these
 *     routes and a device token cannot reach `RewardProgramsController`. There
 *     is no class-level guard and no stacked pair, per the pattern F1
 *     established.
 *   - `childId` is NEVER read from the request. It is derived from the DEVICE
 *     in the verified token via
 *     `PairingOrchestratorService.getChildAndFamilyIdForDevice`. A device that
 *     sends another child's id gains nothing, because the value is not read —
 *     and under `main.ts`'s `forbidNonWhitelisted: true` there is no body on
 *     these routes to send it in.
 *
 * THE INVARIANT, MADE STRUCTURAL RATHER THAN POLICED. A child must not be able
 * to influence `points`, `reward`, `verificationLevel`, `requiresParentApproval`
 * or any quota. Every handler below:
 *
 *   - is a `@Get`. There is no POST, PATCH, PUT or DELETE on this controller,
 *     so there is no write path to audit.
 *   - takes NO `@Body`, NO `@Query` and NO `@Param`. The only argument any
 *     handler receives is `@CurrentUser()`, i.e. the verified token.
 *   - returns `buildLearningCatalogue(ageYears)` — a pure function whose ONLY
 *     input is an integer the server computed from the child's `dateOfBirth`.
 *
 * So the values served are not "validated to be server-controlled"; there is no
 * channel on this surface through which a caller could propose one.
 * `test/rewards/child-learning-catalogue.spec.ts` asserts both halves of that
 * from Nest's own route metadata, so a future handler that adds a body fails a
 * test rather than a review.
 *
 * THROTTLE: `{ limit: 60, ttl: 60_000 }`, matching `GET /self/coach/topics` —
 * the other static, per-device, database-light read in the child app.
 */
@Controller('self/catalogue')
export class ChildCatalogueController {
  constructor(
    private readonly catalogue: LearningCatalogueService,
    private readonly pairing: PairingOrchestratorService,
  ) {}

  private selfOf(device: IJwtPayload): Promise<{ childId: string; familyId: string }> {
    return this.pairing.getChildAndFamilyIdForDevice(device.sub);
  }

  /**
   * THE WHOLE CATALOGUE: every domain, every activity inside it, annotated for
   * the age of the child whose device is asking.
   *
   * NOTHING IS HIDDEN. An activity the server does not suggest at this age is
   * returned with `suitability.suggestedAtThisAge: false` and a non-punitive
   * Arabic line — the DIMMED, never hidden, never locked convention
   * `domain_chooser.dart` and `GoalCard` already apply on the device. The
   * reasoning is in `learning-catalogue.ts` beside `CatalogueSuitability`.
   */
  @Get()
  @ChildSurface()
  @UseGuards(DeviceJwtAuthGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async list(@CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.selfOf(device);
    return this.catalogue.forChild(childId, familyId);
  }

  /**
   * The chooser row alone — domains, counts and suitability, without the
   * activity lists. Derived from the same projection, so the two routes cannot
   * disagree about which domains exist or in what order.
   */
  @Get('domains')
  @ChildSurface()
  @UseGuards(DeviceJwtAuthGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async domains(@CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.selfOf(device);
    return this.catalogue.domainsForChild(childId, familyId);
  }
}
