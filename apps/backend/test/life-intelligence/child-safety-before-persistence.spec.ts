/**
 * ============================================================================
 * `PG-001` — THE CHILD SAFETY POLICY DECIDES BEFORE STORAGE. LOCKED DOWN.
 * ============================================================================
 *
 * THE ARCHITECTURE, AS AN ORDER OF FOUR WORDS:
 *
 *     child message -> CHILD safety policy -> decision -> storage
 *
 * AND NEVER
 *
 *     child message -> PARENT safety policy -> rejected -> raw message stored
 *
 * THE DEFECT THAT EXISTED. `FamilyCommunicationService` is one of the two doors
 * to `child_messages`, and until `PG-001` the only filter behind it was
 * `SafetyEngineService` — the PARENT policy. That policy is six English regexes
 * about spyware plus a recommendation-type whitelist. It knows nothing about
 * age, length, shaming, sibling comparison, medical claims, religious rulings or
 * a phone number. `F6-005` closed the ENGINE's half of the hole with
 * `skipAiRephrase`; the report recorded that every OTHER caller was still
 * exposed, and this file is that hole closed and pinned.
 *
 * WHAT MAKES THESE TESTS REGRESSIONS RATHER THAN DECORATION. Each unsafe input
 * below is asserted TWICE:
 *
 *   1. the PARENT policy calls it SAFE — measured on the real
 *      `SafetyEngineService`, not asserted from the docs. That is the
 *      MEASUREMENT of the hole, and it is why «we already had a safety filter»
 *      was never an answer.
 *   2. the write does NOT happen — `createIfAbsent` is never called, so there is
 *      no row to be «raw stored anyway».
 *
 * Remove the gate from `family-communication.service.ts` and half of this file
 * goes red on line 2 of each test while line 1 stays green. That asymmetry IS
 * the defect, expressed as a test.
 */
import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';

import { FamilyCommunicationService } from '../../src/modules/life-intelligence/application/services/family-communication.service';
import { PrismaCommunicationRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-communication.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { PairingOrchestratorService } from '../../src/modules/pairing/application/services/pairing-orchestrator.service';
import { SafetyEngineService } from '../../src/modules/ai-core/application/services/safety-engine.service';
import { ChildSafetyFilterService } from '../../src/modules/ai-core/application/services/child-safety-filter.service';
import { AI_PROVIDER } from '../../src/modules/ai-core/domain/ai-provider.port';
import { FamilyDateService } from '../../src/common/time/family-date.service';
import { NOTIFICATION_CLASSES } from '../../src/shared/notifications/notification-class';
import { ageBandFor, profileForAge } from '../../src/modules/ai-core/domain/age-band';

const dobForAge = (years: number): string =>
  new Date(Date.now() - years * 365.25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/**
 * THE SENTENCES THE PARENT POLICY WAVES THROUGH.
 *
 * Every one of these is a real phrasing this product has decided a child will
 * never be sent (`child-safety-filter.service.ts` RULES, sourced from CONTEXT §3
 * principle 7 and `07-AI-Architecture.md §11.3`). The first entry is the exact
 * sentence a model returned during `F6-005`'s execution and the exact sentence
 * that was written into `child_messages` verbatim.
 */
const UNSAFE_FOR_A_CHILD: ReadonlyArray<{
  readonly reason: string;
  readonly body: string;
  readonly note: string;
}> = Object.freeze([
  {
    reason: 'SHAMING',
    body: 'أنت كسول ولم تنجز شيئًا اليوم',
    note: 'THE MEASURED ONE — `F6-005` watched this land in child_messages verbatim.',
  },
  {
    reason: 'SHAMING',
    body: 'You are lazy and a failure today',
    note: 'The English half of the same list — an English-speaking household is not less protected.',
  },
  {
    reason: 'THREAT',
    body: 'سيتم حظرك من الجهاز الآن',
    note: 'CONTEXT §3 principle 7 forbids «تم حظرك» to a child by name.',
  },
  {
    reason: 'COMPARISON',
    body: 'أخوك أنجز أكثر منك بكثير',
    note: 'Sibling comparison — the mechanic that makes a child delete the app.',
  },
  {
    reason: 'MEDICAL_CLAIM',
    body: 'لديك حالة فرط الحركة وتحتاج تشخيصًا',
    note: 'A diagnosis addressed to a child. Not a notification.',
  },
  {
    reason: 'RELIGIOUS_RULING',
    body: 'ما فعلته حرام وإثم كبير',
    note: 'A فتوى is not this product’s to issue, least of all to a child.',
  },
  {
    reason: 'EXTERNAL_ACTION',
    body: 'اذهب إلى https://example.com الآن',
    note: 'A link in a child’s inbox is an exit from the product’s safety surface.',
  },
  {
    reason: 'ASKS_CHILD_FOR_INFO',
    body: 'ما هو عنوانك بالتحديد؟',
    note: 'The product never asks a child for PII, whatever composed the sentence.',
  },
  {
    reason: 'PARENT_DATA_LEAK',
    body: 'اشتراك والدك سينتهي قريبًا',
    note: 'The billing relationship is the parent’s; the child is not a collections channel.',
  },
  {
    reason: 'PII_LEAK',
    body: 'راسلنا على coach@example.com بسرعة',
    note: 'An address in the body is an off-platform contact channel.',
  },
]);

describe('`PG-001` — unsafe child-directed content cannot be persisted through a rejected path', () => {
  const repositoryMock = {
    create: jest.fn(),
    createIfAbsent: jest.fn(),
    findById: jest.fn(),
    approveAndDeliver: jest.fn(),
    reject: jest.fn(),
    listDeliveredForChild: jest.fn(),
    acknowledge: jest.fn(),
    listPendingForFamily: jest.fn(),
  };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn(), getChildOrThrow: jest.fn() };
  const pairingOrchestratorMock = { getChildIdForDevice: jest.fn() };
  const aiProviderMock = { complete: jest.fn() };
  const familyDateMock = { timeZoneOf: jest.fn() };

  let service: FamilyCommunicationService;
  /** THE REAL PARENT POLICY, so «it says safe» is measured and not claimed. */
  let parentPolicy: SafetyEngineService;

  const childId = '11111111-1111-4111-8111-111111111111';
  const familyId = '22222222-2222-4222-8222-222222222222';

  const buildFor = async (ageYears: number): Promise<void> => {
    childrenServiceMock.getChildOrThrow.mockResolvedValue({
      id: childId,
      familyId,
      firstName: 'محمد',
      dateOfBirth: dobForAge(ageYears),
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        FamilyCommunicationService,
        { provide: PrismaCommunicationRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: PairingOrchestratorService, useValue: pairingOrchestratorMock },
        // BOTH POLICIES REAL. A mocked filter is how `PE-N-001` survived four
        // audit phases; this file exists to compare the two, so faking either
        // would delete the comparison.
        SafetyEngineService,
        ChildSafetyFilterService,
        { provide: AI_PROVIDER, useValue: aiProviderMock },
        { provide: FamilyDateService, useValue: familyDateMock },
      ],
    }).compile();
    service = moduleRef.get(FamilyCommunicationService);
    parentPolicy = moduleRef.get(SafetyEngineService);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    repositoryMock.createIfAbsent.mockImplementation((...args: unknown[]) =>
      (repositoryMock.create as jest.Mock)(...args),
    );
    repositoryMock.create.mockImplementation(() => ({ id: 'written' }));
    familyDateMock.timeZoneOf.mockResolvedValue('Africa/Cairo');
    // No provider by default: the seed IS the text, which is the harder case —
    // it removes «the AI did it» as an explanation for anything below.
    aiProviderMock.complete.mockRejectedValue(new Error('no provider in this test'));
    await buildFor(12);
  });

  /**
   * ========================================================================
   * ACT I — THE SEED PATH. Nothing rephrased anything; the caller's own text is
   * unsafe for a child and the PARENT policy cannot tell.
   * ========================================================================
   */
  describe('ACT I — the caller’s own text, no AI involved', () => {
    it.each(UNSAFE_FOR_A_CHILD)(
      '$reason — the PARENT policy calls it safe, and it is STILL not persisted ($note)',
      async ({ body }) => {
        // 1. THE MEASUREMENT: this is what the only pre-`PG-001` filter said.
        expect(parentPolicy.validate(null, 'عنوان', body).isSafe).toBe(true);

        // 2. THE RULE.
        await expect(
          service.draftAiMessageIfAbsent(
            childId,
            familyId,
            'BADGE_EARNED',
            'عنوان',
            body,
            'evt:pg-001:seed:child',
            'CHILD_MESSAGE',
          ),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(repositoryMock.createIfAbsent).not.toHaveBeenCalled();
        expect(repositoryMock.create).not.toHaveBeenCalled();
      },
    );

    it('the refusal names the CHILD policy and its closed reason set, and says nothing was written', async () => {
      const attempt = service.draftAiMessageIfAbsent(
        childId,
        familyId,
        'BADGE_EARNED',
        'عنوان',
        'أنت كسول ولم تنجز شيئًا اليوم',
        'evt:pg-001:reason:child',
        'CHILD_MESSAGE',
      );
      await expect(attempt).rejects.toThrow(/PG-001/);
      await expect(attempt).rejects.toThrow(/SHAMING/);
      await expect(attempt).rejects.toThrow(/child_messages/);
    });

    it('THE TEXT IS NOT IN THE ERROR — a rejected child-facing string is itself the thing that tripped the filter', async () => {
      const shaming = 'أنت كسول ولم تنجز شيئًا اليوم';
      await expect(
        service.draftAiMessageIfAbsent(
          childId,
          familyId,
          'BADGE_EARNED',
          'عنوان',
          shaming,
          'evt:pg-001:noleak:child',
          'CHILD_MESSAGE',
        ),
      ).rejects.toThrow(expect.not.stringContaining('كسول') as unknown as string);
    });

    it('AND THE TITLE IS GATED TOO, not only the body — a shaming headline is a shaming message', async () => {
      await expect(
        service.draftAiMessageIfAbsent(
          childId,
          familyId,
          'BADGE_EARNED',
          'أنت فاشل',
          'أحسنت اليوم، واصل',
          'evt:pg-001:title:child',
          'CHILD_MESSAGE',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repositoryMock.createIfAbsent).not.toHaveBeenCalled();
    });

    it('CONTROL — safe, in-band Arabic copy IS persisted, so the gate is a gate and not a wall', async () => {
      await expect(
        service.draftAiMessageIfAbsent(
          childId,
          familyId,
          'BADGE_EARNED',
          'شارة جديدة',
          'أحسنت! حصلت على شارة القارئ',
          'evt:pg-001:control:child',
          'CHILD_MESSAGE',
        ),
      ).resolves.not.toBeNull();
      expect(repositoryMock.createIfAbsent).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * ========================================================================
   * ACT II — THE OTHER CALLERS. This is the residual hole the Phase F report
   * flagged as still open, and the reason it was still open is that `F6-005`'s
   * fix was a FLAG, so it protected only the caller that passed it.
   * ========================================================================
   */
  describe('ACT II — every other caller of FamilyCommunicationService, one at a time', () => {
    const SHAMING_REPHRASE = 'أنت كسول ولم تنجز شيئًا اليوم';

    it('THE `F6-005` DEFECT ITSELF — the AI rephrase returns shaming, the PARENT re-check passes it, and NOTHING is stored', async () => {
      aiProviderMock.complete.mockResolvedValue(SHAMING_REPHRASE);

      // 1. THE MEASUREMENT. `tryPhraseWithAI` re-validates with the PARENT
      //    policy and this is the answer it gets — which is why the rephrased
      //    text was ACCEPTED and used, not discarded.
      expect(parentPolicy.validate(null, 'عنوان', SHAMING_REPHRASE).isSafe).toBe(true);

      // 2. THE RULE. The rephrase reaches the gate on the exact bytes that
      //    would have been persisted.
      await expect(
        service.draftAiMessageIfAbsent(
          childId,
          familyId,
          'BADGE_EARNED',
          'عنوان',
          'أحسنت! حصلت على شارة القارئ',
          'evt:pg-001:rephrase:child',
          'CHILD_MESSAGE',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(aiProviderMock.complete).toHaveBeenCalledTimes(1);
      expect(repositoryMock.createIfAbsent).not.toHaveBeenCalled();
    });

    it('`draftAiMessage` — the PARENT HTTP draft route (POST /children/:childId/messages/draft) is gated identically', async () => {
      aiProviderMock.complete.mockResolvedValue(SHAMING_REPHRASE);
      await expect(
        service.draftAiMessage(childId, familyId, 'SET_SCREEN_TIME_POLICY', 'A note', 'You did well today'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repositoryMock.createIfAbsent).not.toHaveBeenCalled();
    });

    it('`skipAiRephrase = true` — the ENGINE path is gated too; «already validated» is a claim, not a licence', async () => {
      // The engine composes AND validates, so this branch is unreachable in
      // production — which is exactly why it must assert rather than trust. A
      // producer that sets the flag and hands over unsafe text is a producer
      // whose composer broke, and the child is not the right place to find out.
      await expect(
        service.draftAiMessageIfAbsent(
          childId,
          familyId,
          'BADGE_EARNED',
          'عنوان',
          SHAMING_REPHRASE,
          'evt:pg-001:precomposed:child',
          'CHILD_MESSAGE',
          true,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(aiProviderMock.complete).not.toHaveBeenCalled();
      expect(repositoryMock.createIfAbsent).not.toHaveBeenCalled();
    });

    it('the gate is the LAST statement before the write — the idempotency key never reaches the table on a refusal', async () => {
      // A refused message must not consume its `source_event_id`: if it did, a
      // later corrected delivery for the same cause would collide with a row
      // that does not exist and be reported as «already notified».
      await expect(
        service.draftAiMessageIfAbsent(
          childId,
          familyId,
          'BADGE_EARNED',
          'عنوان',
          SHAMING_REPHRASE,
          'evt:pg-001:key:child',
          'CHILD_MESSAGE',
          true,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repositoryMock.createIfAbsent).not.toHaveBeenCalled();

      // And the same cause, composed safely, still lands.
      await expect(
        service.draftAiMessageIfAbsent(
          childId,
          familyId,
          'BADGE_EARNED',
          'شارة جديدة',
          'أحسنت! حصلت على شارة القارئ',
          'evt:pg-001:key:child',
          'CHILD_MESSAGE',
          true,
        ),
      ).resolves.not.toBeNull();
      expect(repositoryMock.createIfAbsent).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * ========================================================================
   * ACT III — THE BAND IS THE CHILD'S OWN. A ceiling that is not per-child is
   * not a ceiling; §11.3 fixes four bands and the FAMILY'S calendar decides
   * which one this child is in.
   * ========================================================================
   */
  describe('ACT III — the ceiling belongs to this child, not to the producer', () => {
    /** 14 words / 78 chars: inside `15-17`, outside `6-8`. */
    const LONG_BUT_KIND = 'أحسنت اليوم يا صديقي، لقد أكملت كل مهامك بجدارة واستحقاق ونحن سعيدون بك';

    it('a fifteen-year-old receives it', async () => {
      await buildFor(15);
      await expect(
        service.draftAiMessageIfAbsent(
          childId,
          familyId,
          'BADGE_EARNED',
          'أحسنت',
          LONG_BUT_KIND,
          'evt:pg-001:band15:child',
          'CHILD_MESSAGE',
          true,
        ),
      ).resolves.not.toBeNull();
    });

    it('THE SAME SENTENCE is refused for a seven-year-old — TOO_LONG, and nothing is stored', async () => {
      await buildFor(7);
      // The fixture is honest about which side of the ceiling it is on, read
      // from `age-band.ts` rather than restated.
      expect(LONG_BUT_KIND.length).toBeGreaterThan(profileForAge(7).maxChars - 20);
      await expect(
        service.draftAiMessageIfAbsent(
          childId,
          familyId,
          'BADGE_EARNED',
          'أحسنت',
          LONG_BUT_KIND,
          'evt:pg-001:band7:child',
          'CHILD_MESSAGE',
          true,
        ),
      ).rejects.toThrow(/TOO_LONG/);
      expect(repositoryMock.createIfAbsent).not.toHaveBeenCalled();
    });

    it('the band in the refusal is the band the family calendar puts this child in', async () => {
      await buildFor(7);
      await expect(
        service.draftAiMessageIfAbsent(
          childId,
          familyId,
          'BADGE_EARNED',
          'أحسنت',
          LONG_BUT_KIND,
          'evt:pg-001:bandname:child',
          'CHILD_MESSAGE',
          true,
        ),
      ).rejects.toThrow(new RegExp(ageBandFor(7)));
      expect(familyDateMock.timeZoneOf).toHaveBeenCalledWith(familyId);
    });
  });

  /**
   * ========================================================================
   * ACT IV — `PE-N-001`, THE VOCABULARY TRAP. A validator handed the wrong TYPE
   * FAMILY must fail LOUDLY.
   *
   * `PE-N-001` was not a wrong answer, it was a CATEGORY ERROR wearing a wrong
   * answer's clothes: a NOTIFICATION type was handed to a whitelist of
   * RECOMMENDATION types, the whitelist correctly said «unknown», and the child
   * half of the notification surface was dead for months with no signal
   * distinguishable from an unlucky household. The failure mode to forbid is not
   * «rejects» — it is «rejects QUIETLY, and then something gets stored anyway».
   * ========================================================================
   */
  describe('ACT IV — `PE-N-001`: the wrong type family fails loudly, never silently', () => {
    const childFacingTypes = Object.entries(NOTIFICATION_CLASSES)
      .filter(([, entry]) => entry.audience === 'CHILD' || entry.audience === 'BOTH')
      .map(([type]) => type);

    it('there are child-facing notification types to be confused in the first place', () => {
      expect(childFacingTypes.length).toBeGreaterThan(5);
    });

    it.each(childFacingTypes)(
      '%s under the RECOMMENDATION vocabulary throws a message NAMING the confusion — and writes nothing',
      async (type) => {
        const attempt = service.draftAiMessageIfAbsent(
          childId,
          familyId,
          type,
          'شارة جديدة',
          'أحسنت! حصلت على شارة القارئ',
          `evt:pe-n-001:${type}:child`,
          'AI_RECOMMENDATION',
        );
        await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
        // LOUDLY: the sentence says which two vocabularies were confused and
        // what the caller must pass. A bare «Unknown recommendation type» is the
        // defect, not the fix.
        await expect(attempt).rejects.toThrow(/PE-N-001/);
        await expect(attempt).rejects.toThrow(/NOTIFICATION TYPE/);
        await expect(attempt).rejects.toThrow(/CHILD_MESSAGE/);
        expect(repositoryMock.createIfAbsent).not.toHaveBeenCalled();
      },
    );

    it('the two vocabularies are still DISJOINT, so the trap is still a trap', () => {
      for (const type of childFacingTypes) {
        // Under the recommendation vocabulary the real parent policy refuses
        // every one of them. The day this stops being true, the assertion above
        // stops meaning anything and this fails first.
        expect(`${type}:${parentPolicy.validate(type, 'عنوان', 'نص').isSafe}`).toBe(`${type}:false`);
      }
    });

    it('NOT SILENT-THEN-STORED — the same category under the CORRECT vocabulary is accepted and stored, so the throw is about the confusion and nothing else', async () => {
      await expect(
        service.draftAiMessageIfAbsent(
          childId,
          familyId,
          'BADGE_EARNED',
          'شارة جديدة',
          'أحسنت! حصلت على شارة القارئ',
          'evt:pe-n-001:correct:child',
          'CHILD_MESSAGE',
        ),
      ).resolves.not.toBeNull();
      expect(repositoryMock.createIfAbsent).toHaveBeenCalledTimes(1);
    });

    it('AND THE CHILD GATE RUNS AFTER THE VOCABULARY CHECK, not instead of it — a correctly-addressed unsafe message is still refused', async () => {
      await expect(
        service.draftAiMessageIfAbsent(
          childId,
          familyId,
          'BADGE_EARNED',
          'عنوان',
          'أنت كسول ولم تنجز شيئًا اليوم',
          'evt:pe-n-001:both:child',
          'CHILD_MESSAGE',
        ),
      ).rejects.toThrow(/PG-001/);
      expect(repositoryMock.createIfAbsent).not.toHaveBeenCalled();
    });
  });
});
