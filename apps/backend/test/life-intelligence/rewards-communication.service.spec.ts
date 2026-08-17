import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { RewardsEngineService } from '../../src/modules/life-intelligence/application/services/rewards-engine.service';
import { PrismaRewardsRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-rewards.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { LIFE_TIMELINE_WRITER } from '../../src/modules/life-intelligence/domain/life-timeline.types';
import { SmartNotificationEngineService } from '../../src/modules/notification-engine/application/services/smart-notification-engine.service';
import { FamilyDateService } from '../../src/common/time/family-date.service';
import { GrowthEventEmitter } from '../../src/modules/analytics/application/growth-event-emitter.service';
import { TIMELINE_COPY_AR } from '../../src/modules/life-intelligence/domain/life-timeline-copy';

/** Any Arabic letter. A timeline title in «سجل حياة الطفل» that matches nothing
 * here is in the wrong language, whatever else is true of it. */
const ARABIC_LETTERS = /[؀-ۿ]/;

describe('RewardsEngineService', () => {
  const repositoryMock = {
    getOrCreateAccount: jest.fn(),
    applyEarn: jest.fn(),
    findBadgeByKey: jest.fn(),
    awardBadgeIfNotAlready: jest.fn(),
    listActiveRewardRules: jest.fn(),
    listActiveCatalogItems: jest.fn(),
    findCatalogItemById: jest.fn(),
    createRedemption: jest.fn(),
    findRedemptionById: jest.fn(),
    approveRedemption: jest.fn(),
    denyRedemption: jest.fn(),
  };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  const timelineMock = { record: jest.fn() };
  // PHASE F (`F6-003`) — the decision layer, not the delivery pipeline. This
  // suite is about ownership checks and redemption arithmetic; the double only
  // has to exist and resolve.
  const notificationEngineMock = { handleEvent: jest.fn() };
  // B4: rule caps are counted on the FAMILY's business day, so the engine now
  // depends on B1+B2's single date authority. No rule in this suite declares a
  // cap, so nothing here is ever called.
  const familyDateMock = { getBusinessDate: jest.fn().mockResolvedValue('2026-08-14') };
  let service: RewardsEngineService;
  const childId = 'child-1';
  const familyId = 'family-1';

  /** The title of the ONE timeline entry of a given kind this trigger wrote.
   * Reads the recorded call rather than the arguments the test passed, so the
   * assertion is about what the engine produced. */
  const timelineTitleFor = (eventType: string): string | undefined =>
    timelineMock.record.mock.calls
      .map((call: unknown[]) => call[0] as { eventType: string; title: string })
      .find((entry) => entry.eventType === eventType)?.title;

  beforeEach(async () => {
    jest.clearAllMocks();
    notificationEngineMock.handleEvent.mockResolvedValue({
      decision: { verdict: 'SEND', targetAudience: 'CHILD', score: 40, reason: 'SCORE_IN_DEFER_BAND' },
      decisionId: 'decision-1',
      outcome: { type: 'x', targetAudience: 'CHILD', decision: 'SEND' },
      title: 'x',
      body: 'y',
      aiRewritten: false,
      aiFailed: false,
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        RewardsEngineService,
        { provide: PrismaRewardsRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: LIFE_TIMELINE_WRITER, useValue: timelineMock },
        { provide: SmartNotificationEngineService, useValue: notificationEngineMock },
        { provide: FamilyDateService, useValue: familyDateMock },
        // PHASE D (GROWTH). `GrowthEventEmitter.emit` never throws by contract
        // (see its class docstring: analytics must never be able to fail a
        // reward, a habit or an AI answer), so a resolving double is a faithful
        // stand-in and these suites stay about the business path.
        { provide: GrowthEventEmitter, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = moduleRef.get(RewardsEngineService);
  });

  describe('processTriggerEvent', () => {
    it('SECURITY REGRESSION TEST: verifies ownership before touching any reward rule — previously this method had zero ownership check, letting an authenticated parent grant rewards to a child outside their own family', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockRejectedValue(new Error('not found'));

      await expect(
        service.processTriggerEvent(childId, familyId, { engine: 'faith', type: 't', payload: {} }),
      ).rejects.toThrow('not found');

      expect(repositoryMock.listActiveRewardRules).not.toHaveBeenCalled();
    });

    it('proceeds normally once ownership is verified', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockResolvedValue(undefined);
      repositoryMock.listActiveRewardRules.mockResolvedValue([]);

      const count = await service.processTriggerEvent(childId, familyId, { engine: 'faith', type: 't', payload: {} });

      expect(childrenServiceMock.assertChildBelongsToFamily).toHaveBeenCalledWith(childId, familyId);
      expect(count).toBe(0);
    });
  });

  describe('processTriggerEvent', () => {
    it('awards a badge exactly once even if triggered twice (award idempotency respected)', async () => {
      repositoryMock.listActiveRewardRules.mockResolvedValue([
        { id: 'r1', familyId: null, triggerEngine: 'faith', triggerCondition: { x: 1 }, rewardType: 'BADGE', rewardAmountOrBadgeId: 'badge-key', isActive: true },
      ]);
      repositoryMock.findBadgeByKey.mockResolvedValue({ id: 'b1', key: 'badge-key', title: 'Test Badge', description: '', criteria: {}, isGroupAchievement: false });
      repositoryMock.awardBadgeIfNotAlready.mockResolvedValue(false);

      await service.processTriggerEvent(childId, familyId, { engine: 'faith', type: 't', payload: { x: 1 } });

      expect(repositoryMock.applyEarn).not.toHaveBeenCalled();
      expect(timelineMock.record).not.toHaveBeenCalled();
    });

    it('grants and writes a Timeline event when a badge is newly awarded', async () => {
      repositoryMock.listActiveRewardRules.mockResolvedValue([
        { id: 'r1', familyId: null, triggerEngine: 'faith', triggerCondition: { x: 1 }, rewardType: 'BADGE', rewardAmountOrBadgeId: 'badge-key', isActive: true },
      ]);
      repositoryMock.findBadgeByKey.mockResolvedValue({ id: 'b1', key: 'badge-key', title: 'Test Badge', description: '', criteria: {}, isGroupAchievement: false });
      repositoryMock.awardBadgeIfNotAlready.mockResolvedValue(true);
      repositoryMock.applyEarn.mockResolvedValue(true);

      await service.processTriggerEvent(childId, familyId, { engine: 'faith', type: 't', payload: { x: 1 } });

      // B4: the trailing `undefined` is the CAP argument — this rule declares no maxPerDay/maxPerWeek.
      expect(repositoryMock.applyEarn).toHaveBeenCalledWith(childId, 'BADGE', 1, undefined, 'reward_rule:r1', undefined, undefined, '2026-08-14');
      expect(timelineMock.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'badge_awarded' }));
    });

    it('skips a rule referencing a badge key that no longer exists, without crashing', async () => {
      repositoryMock.listActiveRewardRules.mockResolvedValue([
        { id: 'r1', familyId: null, triggerEngine: 'faith', triggerCondition: {}, rewardType: 'BADGE', rewardAmountOrBadgeId: 'deleted-badge', isActive: true },
      ]);
      repositoryMock.findBadgeByKey.mockResolvedValue(null);

      await expect(service.processTriggerEvent(childId, familyId, { engine: 'faith', type: 't', payload: {} })).resolves.toBe(0);
      expect(repositoryMock.applyEarn).not.toHaveBeenCalled();
    });

    /**
     * UPDATED DELIBERATELY, and the old assertion is quoted so the change is
     * legible: this test used to read
     *
     *     expect(...).toHaveBeenCalledWith({ eventType: 'level_up', title: 'Reached Level 2' })
     *
     * `life_timeline_events` IS «سجل حياة الطفل» (CONTEXT §1), and an English
     * literal in it was the second defect `e2e-13` pinned. `TIMELINE_COPY_AR` is
     * now the only place a timeline title exists, so this asserts BOTH halves:
     * the row is byte-identical to what the copy module produces for this level,
     * AND it is really Arabic — a title assertion that only compared against the
     * module would pass just as happily if the module went back to English.
     */
    it('writes a level-up Timeline event only when XP crosses a threshold, titled in ARABIC from the copy module', async () => {
      repositoryMock.listActiveRewardRules.mockResolvedValue([
        { id: 'r2', familyId: null, triggerEngine: 'health', triggerCondition: {}, rewardType: 'XP', rewardAmountOrBadgeId: '100', isActive: true },
      ]);
      repositoryMock.getOrCreateAccount.mockResolvedValue({ id: 'a1', childId, xp: 50, coins: 0, stars: 0, level: 1 });
      repositoryMock.applyEarn.mockResolvedValue(true);

      await service.processTriggerEvent(childId, familyId, { engine: 'health', type: 't', payload: {} });

      expect(timelineMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'level_up', title: TIMELINE_COPY_AR.levelUp(2) }),
      );
      const levelUp = timelineTitleFor('level_up');
      expect(levelUp).toBe('وصل إلى المستوى ٢');
      expect(levelUp).toMatch(ARABIC_LETTERS);
      // Arabic prose with Latin numerals reads as a translation (`PF-E-002`).
      expect(levelUp).not.toMatch(/[0-9]/);
    });

    /**
     * THE REWARD ENTRY ITSELF — the row `e2e-13` pinned as `'Earned a reward'`.
     *
     * Here in its NEGATIVE half: a trigger that is NOT a parent-authored program
     * carries no `targetSummaryAr`, and the honest title is the general Arabic
     * sentence rather than an invented goal name. The positive half — the entry
     * naming «الآيات 1–5 من سورة الملك» — is asserted end-to-end in `e2e-13`
     * against the row PostgreSQL actually holds.
     */
    it('writes the reward Timeline entry in ARABIC, and names no goal when the trigger carries none', async () => {
      repositoryMock.listActiveRewardRules.mockResolvedValue([
        { id: 'r2', familyId: null, triggerEngine: 'health', triggerCondition: {}, rewardType: 'XP', rewardAmountOrBadgeId: '10', isActive: true },
      ]);
      repositoryMock.getOrCreateAccount.mockResolvedValue({ id: 'a1', childId, xp: 0, coins: 0, stars: 0, level: 1 });
      repositoryMock.applyEarn.mockResolvedValue(true);

      await service.processTriggerEvent(childId, familyId, { engine: 'health', type: 't', payload: {} });

      expect(timelineTitleFor('reward_granted')).toBe('حصل على مكافأة جديدة');
      expect(timelineTitleFor('reward_granted')).toMatch(ARABIC_LETTERS);
      expect(timelineTitleFor('reward_granted')).not.toMatch(/[A-Za-z]/);
    });

    /**
     * AND THE POSITIVE HALF AT THIS LEVEL: the summary the completion carried is
     * USED, and used VERBATIM. No Arabic is assembled from a surah number here —
     * `describeTargetSpec` derived that sentence once, at program creation,
     * precisely so this writer would not have to.
     */
    it('names the achievement in the Timeline entry, from the completion’s own targetSummaryAr', async () => {
      repositoryMock.listActiveRewardRules.mockResolvedValue([
        { id: 'r2', familyId: null, triggerEngine: 'reward-program', triggerCondition: {}, rewardType: 'XP', rewardAmountOrBadgeId: '20', isActive: true },
      ]);
      repositoryMock.getOrCreateAccount.mockResolvedValue({ id: 'a1', childId, xp: 0, coins: 0, stars: 0, level: 1 });
      repositoryMock.applyEarn.mockResolvedValue(true);

      await service.processTriggerEvent(childId, familyId, {
        engine: 'reward-program',
        type: 'ACHIEVEMENT_VERIFIED',
        payload: { metadata: { targetSummaryAr: 'الآيات 1–5 من سورة الملك' } },
      });

      expect(timelineTitleFor('reward_granted')).toBe('أكمل الآيات 1–5 من سورة الملك وحصل على مكافأة');
      expect(timelineTitleFor('reward_granted')).toContain('سورة الملك');
    });

    /**
     * THE GUARD THAT MAKES THE ONE ABOVE SAFE. `describeTargetSpec`'s last line
     * returns the raw ACTIVITY CODE for a spec it cannot describe, and that value
     * is persisted on the program like any other. A title reading «أكمل
     * QURAN_MEMORIZE_AYAH_RANGE» is the raw-enum leak this product forbids, so an
     * enum-shaped summary is treated as ABSENT and the general sentence wins.
     */
    it('refuses an ENUM-SHAPED summary rather than putting a database value on the timeline', async () => {
      repositoryMock.listActiveRewardRules.mockResolvedValue([
        { id: 'r2', familyId: null, triggerEngine: 'reward-program', triggerCondition: {}, rewardType: 'XP', rewardAmountOrBadgeId: '20', isActive: true },
      ]);
      repositoryMock.getOrCreateAccount.mockResolvedValue({ id: 'a1', childId, xp: 0, coins: 0, stars: 0, level: 1 });
      repositoryMock.applyEarn.mockResolvedValue(true);

      await service.processTriggerEvent(childId, familyId, {
        engine: 'reward-program',
        type: 'ACHIEVEMENT_VERIFIED',
        payload: { metadata: { targetSummaryAr: 'QURAN_MEMORIZE_AYAH_RANGE' } },
      });

      expect(timelineTitleFor('reward_granted')).toBe('حصل على مكافأة جديدة');
      expect(timelineTitleFor('reward_granted')).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
    });
  });

  describe('approveRedemption', () => {
    it('throws BadRequestException if the redemption is not in REQUESTED status', async () => {
      repositoryMock.findRedemptionById.mockResolvedValue({ id: 'red1', childId, rewardCatalogItemId: 'item1', status: 'APPROVED' });
      await expect(service.approveRedemption('red1', familyId, 'user1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if the child no longer has enough coins', async () => {
      repositoryMock.findRedemptionById.mockResolvedValue({ id: 'red1', childId, rewardCatalogItemId: 'item1', status: 'REQUESTED' });
      repositoryMock.findCatalogItemById.mockResolvedValue({ id: 'item1', familyId, title: 'Toy', costCoins: 500, isActive: true });
      repositoryMock.getOrCreateAccount.mockResolvedValue({ id: 'a1', childId, xp: 0, coins: 100, stars: 0, level: 1 });

      await expect(service.approveRedemption('red1', familyId, 'user1')).rejects.toThrow(BadRequestException);
      expect(repositoryMock.approveRedemption).not.toHaveBeenCalled();
    });

    it('approves atomically when the balance is sufficient', async () => {
      repositoryMock.findRedemptionById.mockResolvedValue({ id: 'red1', childId, rewardCatalogItemId: 'item1', status: 'REQUESTED' });
      repositoryMock.findCatalogItemById.mockResolvedValue({ id: 'item1', familyId, title: 'Toy', costCoins: 500, isActive: true });
      repositoryMock.getOrCreateAccount.mockResolvedValue({ id: 'a1', childId, xp: 0, coins: 600, stars: 0, level: 1 });

      await service.approveRedemption('red1', familyId, 'user1');

      expect(repositoryMock.approveRedemption).toHaveBeenCalledWith('red1', childId, 500, 'user1');
    });

    it('throws NotFoundException for a redemption that does not exist', async () => {
      repositoryMock.findRedemptionById.mockResolvedValue(null);
      await expect(service.approveRedemption('missing', familyId, 'user1')).rejects.toThrow(NotFoundException);
    });
  });
});
