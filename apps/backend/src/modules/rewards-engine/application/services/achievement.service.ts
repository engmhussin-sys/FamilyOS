/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { OutboxWriter } from '../../../events/application/outbox.writer';
import { computeCurrentStreak } from '../../../life-intelligence/application/services/streak-calculator';
import type { CompletionEvent } from '../../../../shared/events/completion-event';
import { composeIdempotencyKey } from '../../../../shared/events/idempotency';
import {
  CATEGORY_STREAK_KIND,
  type ProgramCategory,
} from '../../../../shared/rewards/program-taxonomy';
import {
  MAX_VERIFICATION_ATTEMPTS,
  type VerificationInput,
  type VerificationMethod,
  type VerificationOutcome,
} from '../../../../shared/rewards/verification';
import {
  BASE_MULTIPLIER_BPS,
  multiplierBpsForStreak,
} from '../../../../shared/rewards/streak-multiplier';
import { verify } from '../../domain/verification-strategies';
import {
  ageInYears,
  checkProgramEligibility,
  localDateString,
  weekWindow,
} from '../../domain/program-rules';
import { PrismaRewardProgramRepository } from '../../infrastructure/repositories/prisma-reward-program.repository';
import { QuizService } from './quiz.service';
import { AchievementEvidenceService } from './achievement-evidence.service';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import type { SubmitAchievementDto } from '../dto/reward-program.dto';

/**
 * THE ACHIEVEMENT LIFECYCLE — and the file where the sprint's security rule
 * lives:
 *
 *   A CHILD MAY REQUEST. A CHILD MAY SUBMIT EVIDENCE. A CHILD MAY NEVER GRANT.
 *
 * There is no method here that a child-authenticated route can reach which
 * writes `rewards_ledger_entries`, and there is no argument any caller can pass
 * that turns a submission into a verification. The three entry points are:
 *
 *   start(childId, programId)          child   -> REQUESTED/IN_PROGRESS
 *   submit(childId, achievementId, e)  child   -> the SERVER runs `verify()`
 *   decide(userId, achievementId, ok)  parent  -> VERIFIED | REJECTED
 *
 * and only `markVerified` (private) emits `ACHIEVEMENT_VERIFIED`, which is the
 * only event in the catalogue that reaches the Rewards Engine.
 *
 * WHY THE GRANT IS NOT HERE AT ALL. `markVerified` writes an outbox message and
 * stops. The grant happens later, in `RewardsCompletionConsumer` (F3,
 * unmodified), against the companion `RewardRule` rows this program
 * materialised. That indirection is what makes eight concurrent verifications
 * produce one grant: they collide on `domain_events (family_id,
 * idempotency_key)` and then again on `rewards_ledger_entries (child_id,
 * idempotency_key)` — two database constraints, no code check.
 */
@Injectable()
export class AchievementService {
  private readonly logger = new Logger(AchievementService.name);

  constructor(
    private readonly repo: PrismaRewardProgramRepository,
    private readonly outbox: OutboxWriter,
    private readonly familyDate: FamilyDateService,
    /** B5 (PA-B-017) — the ONLY producer of a quiz score in this backend. */
    private readonly quiz: QuizService,
    /** B5 (PA-B-019) — resolves a `submissionRef` to a real stored object. */
    private readonly evidence: AchievementEvidenceService,
  ) {}

  /**
   * B2 (PA-B-001). The family calendar this service decides days on.
   *
   * The tenant is read the same way the repository reads it — from the ambient
   * context established by `TenantContextInterceptor` from a verified
   * principal — so, exactly as the repository's own docstring puts it, there is
   * no call site that could pass the wrong one. `maxPerDay`, `maxPerWeek`, the
   * `AchievementRequest.localDate` column and the streak that freezes the
   * multiplier are all decided on it.
   */
  private timeZone(familyId: string): Promise<string> {
    return this.familyDate.timeZoneOf(familyId);
  }

  // --- child paths ----------------------------------------------------------

  /**
   * "I am starting this program now." Enforces every program rule that is
   * decidable up front, then opens exactly one attempt for today.
   */
  async start(childId: string, programId: string, now = new Date()): Promise<any> {
    const program = await this.repo.findProgram(programId);
    if (!program) {
      throw new NotFoundException({ code: 'PROGRAM_NOT_FOUND', messageAr: 'البرنامج غير موجود.' });
    }

    const child = await this.repo.findChild(childId);
    if (!child) {
      throw new NotFoundException({ code: 'CHILD_NOT_FOUND', messageAr: 'الطفل غير موجود.' });
    }

    const timeZone = await this.timeZone(program.familyId);
    const today = localDateString(now, timeZone);
    const week = weekWindow(now, timeZone);

    const violation = checkProgramEligibility({
      program: {
        status: program.status,
        expiresAt: program.expiresAt ?? null,
        frequency: program.frequency,
        maxPerDay: program.maxPerDay,
        maxPerWeek: program.maxPerWeek,
        minAge: program.minAge,
        difficulty: program.difficulty,
        childId: program.childId ?? null,
      },
      childId,
      childAgeYears: ageInYears(new Date(child.dateOfBirth), now, timeZone),
      verifiedToday: await this.repo.countVerifiedBetween(programId, childId, today, today),
      verifiedThisWeek: await this.repo.countVerifiedBetween(programId, childId, week.from, week.to),
      openToday: await this.repo.countOpenOn(programId, childId, today),
      now,
    });

    if (violation) {
      // 409, not 403: none of these is an authorisation failure, they are all
      // "not right now". The message is the one the child sees.
      throw new ConflictException(violation);
    }

    const attemptNo = (await this.repo.maxAttemptNo(programId, childId, today)) + 1;

    let achievement: any;
    try {
      achievement = await this.repo.createAchievement({
        programId,
        childId,
        status: 'IN_PROGRESS',
        // The `@db.Date` storage convention: a business date is persisted at
        // UTC midnight and READ BACK as a family-local day. The calendar
        // decision happened above, in `localDateString`.
        localDate: FamilyDateService.toDateColumn(today),
        attemptNo,
        startedAt: now,
      });
    } catch (err) {
      // The unique index `(program_id, child_id, local_date, attempt_no)` is
      // the real serialisation point for two concurrent starts. One wins.
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException({
          code: 'ATTEMPT_ALREADY_OPEN',
          messageAr: 'لديك محاولة مفتوحة بالفعل لهذا البرنامج اليوم.',
        });
      }
      throw err;
    }

    await this.outbox.write({
      type: 'ACHIEVEMENT_REQUESTED',
      aggregateType: 'AchievementRequest',
      aggregateId: achievement.id,
      childId,
      deviceId: null,
      idempotencyKey: composeIdempotencyKey('ACHIEVEMENT_REQUESTED', {
        childId,
        sourceId: achievement.id,
        milestone: attemptNo,
      }),
      clientEventId: null,
      occurredAt: now,
      traceId: null,
      payload: { achievementId: achievement.id, programId, childId, attemptNo },
    });

    return achievement;
  }

  /**
   * "Here is my evidence." The SERVER measures elapsed time, runs the strategy,
   * writes an append-only `VerificationAttempt`, and then does one of exactly
   * three things — grant path, retry, or a parent's queue. It never returns a
   * reward.
   */
  async submit(
    childId: string,
    achievementId: string,
    dto: SubmitAchievementDto,
    now = new Date(),
  ): Promise<{ status: string; outcome: VerificationOutcome; attemptsLeft: number }> {
    const achievement = await this.repo.findAchievement(achievementId);
    if (!achievement) {
      throw new NotFoundException({ code: 'ACHIEVEMENT_NOT_FOUND', messageAr: 'المحاولة غير موجودة.' });
    }
    if (achievement.childId !== childId) {
      // A child submitting to another child's attempt inside the same family.
      // The tenant extension cannot catch this one — same tenant — so it is
      // checked here explicitly.
      throw new ForbiddenException({ code: 'NOT_YOUR_ACHIEVEMENT', messageAr: 'هذه ليست محاولتك.' });
    }
    if (!['REQUESTED', 'IN_PROGRESS'].includes(achievement.status)) {
      throw new ConflictException({
        code: 'ACHIEVEMENT_NOT_SUBMITTABLE',
        messageAr: 'هذه المحاولة لم تعد قابلة للإرسال.',
      });
    }

    const program = await this.repo.findProgram(achievement.programId);
    if (!program) {
      throw new NotFoundException({ code: 'PROGRAM_NOT_FOUND', messageAr: 'البرنامج غير موجود.' });
    }

    /**
     * B5 (PA-B-019) — `submissionRef` IS NO LONGER A FREE STRING.
     *
     * The DTO validates its shape and its length and always did. What it could
     * not check is whether it POINTS AT ANYTHING: before B5 there was no
     * upload path at all, so `{"submissionRef": "upload://abc"}` was as valid
     * as any real reference, and `RECITATION_SUBMISSION` would happily escalate
     * a recitation with no recording to a parent's queue. Now the ref must
     * resolve to an `achievement_evidence` row belonging to THIS achievement —
     * so a ref that is invented, or valid but for a different attempt, is a
     * 400 with a non-punitive message telling the child to upload and retry.
     */
    if (dto.submissionRef) {
      await this.evidence.assertBelongsToAchievement(dto.submissionRef, achievementId);
    }

    const attemptNumber = (await this.repo.countAttempts(achievementId)) + 1;
    if (attemptNumber > MAX_VERIFICATION_ATTEMPTS) {
      // NON-PUNITIVE (principle 7): running out of automatic attempts escalates
      // to a human. It never says "you failed" and it never closes the door.
      await this.repo.updateAchievement(achievementId, { status: 'PENDING_PARENT', submittedAt: now });
      return {
        status: 'PENDING_PARENT',
        outcome: {
          result: 'ESCALATED',
          scorePercent: null,
          reasonCode: 'ATTEMPTS_EXHAUSTED',
          messageAr: 'أرسلنا محاولتك إلى ولي الأمر ليطّلع عليها.',
        },
        attemptsLeft: 0,
      };
    }

    // SERVER-MEASURED. `startedAt` was written by the server on `start`.
    const startedAt: Date = achievement.startedAt ? new Date(achievement.startedAt) : now;
    const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 60000));

    const method = program.verificationLevel as VerificationMethod;
    const config = (program.verificationConfig ?? {}) as { passScorePercent?: number; subject?: string };

    /**
     * B5 (PA-B-017) — THE PROVENANCE FIX, IN ONE PLACE.
     *
     * `quizCorrect`/`quizTotal` used to be read straight off `dto`. They are
     * now produced by `QuizService.grade`, which reads the question set the
     * SERVER recorded in `quiz_assignments` and the answer key the SERVER
     * holds in `quiz_questions`, and compares them against the answer sheet
     * the child sent. The pure strategy below is untouched and its unit tests
     * are untouched — it always compared the count correctly; the count is
     * simply no longer the child's to choose.
     *
     * `null` (no served assignment) leaves both fields undefined, which makes
     * `quizScore()` return null, which the strategy already reports as
     * `QUIZ_NOT_SUBMITTED`. Answering a quiz that was never opened is not a
     * crash and it is not a zero — it is «you have not taken it yet».
     */
    const grade =
      method === 'QUIZ' || method === 'DURATION_PLUS_QUIZ'
        ? await this.quiz.grade(achievementId, attemptNumber, dto.quizAnswers ?? [], now)
        : null;

    const input: VerificationInput = {
      method,
      requiredDurationMinutes: program.durationMinutes,
      passScorePercent: Number(config.passScorePercent ?? 0),
      elapsedMinutes,
      foregroundMinutes: dto.foregroundMinutes ?? null,
      submission: {
        selfConfirmed: dto.selfConfirmed,
        // SERVER-PRODUCED. Not a DTO field any more — see `grade` above.
        quizCorrect: grade?.correct,
        quizTotal: grade?.total,
        submissionRef: dto.submissionRef,
        testsPassed: dto.testsPassed,
        testsTotal: dto.testsTotal,
        note: dto.note,
      },
      assessmentScorePercent:
        method === 'ASSESSMENT_SCORE'
          ? await this.repo.latestAssessmentScore(childId, String(config.subject ?? program.category))
          : null,
      requiresParentApproval: program.requiresParentApproval === true,
    };

    const outcome = verify(input);

    await this.repo.createAttempt({
      achievementId,
      childId,
      method,
      result: outcome.result,
      scorePercent: outcome.scorePercent,
      reasonCode: outcome.reasonCode,
      evidenceRef: dto.submissionRef ?? null,
      attemptNumber,
      verifierType: 'SYSTEM',
      verifierUserId: null,
    });

    if (outcome.result === 'PASSED') {
      await this.repo.updateAchievement(achievementId, { submittedAt: now, elapsedMinutes });
      await this.markVerified(achievement, program, 'SYSTEM', null, now);
      return { status: 'VERIFIED', outcome, attemptsLeft: MAX_VERIFICATION_ATTEMPTS - attemptNumber };
    }

    if (outcome.result === 'ESCALATED') {
      await this.repo.updateAchievement(achievementId, {
        status: 'PENDING_PARENT',
        submittedAt: now,
        elapsedMinutes,
      });
      return {
        status: 'PENDING_PARENT',
        outcome,
        attemptsLeft: MAX_VERIFICATION_ATTEMPTS - attemptNumber,
      };
    }

    // FAILED. The attempt stays open so the child can re-submit under the
    // policy. NO grant, NO event, therefore NO notification — the absence is
    // structural: nothing was written to the outbox.
    await this.repo.updateAchievement(achievementId, { status: 'IN_PROGRESS' });
    return { status: 'IN_PROGRESS', outcome, attemptsLeft: MAX_VERIFICATION_ATTEMPTS - attemptNumber };
  }

  // --- parent paths ---------------------------------------------------------

  /**
   * The parent's decision on an escalated achievement. This is the ONLY caller
   * that can turn a `PENDING_PARENT` row into `VERIFIED`, and it takes the
   * deciding user id so the attempt row records WHO decided — a `SYSTEM`
   * decision and a `PARENT` decision are distinguishable forever.
   */
  async decide(
    userId: string,
    achievementId: string,
    approve: boolean,
    note?: string,
    now = new Date(),
  ): Promise<any> {
    const achievement = await this.repo.findAchievement(achievementId);
    if (!achievement) {
      throw new NotFoundException({ code: 'ACHIEVEMENT_NOT_FOUND', messageAr: 'المحاولة غير موجودة.' });
    }
    if (!['SUBMITTED', 'PENDING_PARENT'].includes(achievement.status)) {
      throw new ConflictException({
        code: 'ACHIEVEMENT_NOT_DECIDABLE',
        messageAr: 'هذه المحاولة ليست بانتظار قرار.',
      });
    }

    const program = await this.repo.findProgram(achievement.programId);
    if (!program) {
      throw new NotFoundException({ code: 'PROGRAM_NOT_FOUND', messageAr: 'البرنامج غير موجود.' });
    }

    const attemptNumber = (await this.repo.countAttempts(achievementId)) + 1;
    await this.repo.createAttempt({
      achievementId,
      childId: achievement.childId,
      method: program.verificationLevel,
      result: approve ? 'PASSED' : 'FAILED',
      scorePercent: null,
      reasonCode: approve ? 'PARENT_APPROVED' : 'PARENT_REJECTED',
      evidenceRef: note ?? null,
      attemptNumber,
      verifierType: 'PARENT',
      verifierUserId: userId,
    });

    if (!approve) {
      await this.repo.updateAchievement(achievementId, {
        status: 'REJECTED',
        decidedAt: now,
        decidedByUserId: userId,
      });

      await this.outbox.write({
        type: 'ACHIEVEMENT_REJECTED',
        aggregateType: 'AchievementRequest',
        aggregateId: achievementId,
        childId: achievement.childId,
        deviceId: null,
        idempotencyKey: composeIdempotencyKey('ACHIEVEMENT_REJECTED', {
          childId: achievement.childId,
          sourceId: achievementId,
          milestone: achievement.attemptNo,
        }),
        clientEventId: null,
        occurredAt: now,
        traceId: null,
        payload: {
          achievementId,
          programId: achievement.programId,
          childId: achievement.childId,
          /**
           * `F1-002` — WHAT THE ATTEMPT WAS ABOUT, IN ARABIC, DERIVED ONCE.
           *
           * `RewardProgram.targetSummaryAr` («الآيات 1–5 من سورة الملك»),
           * carried on the event exactly as `ACHIEVEMENT_VERIFIED` carries it,
           * so the consumer that names the goal needs no reward-program
           * repository and learns nothing about what a surah is.
           *
           * THE PARENT'S `note` IS DELIBERATELY NOT HERE. It is free text a
           * human wrote about a child's work, and the one sentence this event
           * produces is read BY that child. Putting a reason on the wire is how
           * a reason ends up in a sentence, and CONTEXT §3 principle 7 forbids
           * the product blaming a child for an outcome. The note stays on the
           * attempt row, where the parent can see it and the child cannot.
           */
          targetSummaryAr: program.targetSummaryAr ?? null,
        },
      });

      /**
       * ======================================================================
       * `F1-002` — THE CONTRADICTION THAT WAS HERE, AND HOW IT IS RESOLVED.
       * ======================================================================
       *
       * WHAT THIS COMMENT SAID, VERBATIM:
       *
       *     // `ACHIEVEMENT_REJECTED` has NO consumer, deliberately
       *     // (principle 7): a rejection does not push a notification at a
       *     // child.
       *
       * And `COPY_CATALOGUE.ACHIEVEMENT_REJECTED` has carried a child-facing
       * sentence — in four tone bands, in Arabic and English — the whole time,
       * with a quiet-hours class, two scoring rows and a deep-link destination.
       * Production and the catalogue said opposite things about the same key,
       * and the contradiction is the finding.
       *
       * IT IS RESOLVED IN FAVOUR OF TELLING THE CHILD, for three reasons.
       *
       *   1. NON-PUNITIVE IS NOT THE SAME AS SILENT, and principle 7 asks for
       *      the first. Read the sentence the catalogue actually holds: «يحتاج
       *      {goalTitle} مراجعة بسيطة مع أهلك» — it names no fault, states no
       *      reason, uses none of the punitive vocabulary the child-safety
       *      filter screens for, and its next step is a CONVERSATION. What
       *      principle 7 forbids is a product that punishes; a product that
       *      answers is not punishment.
       *   2. SILENCE AFTER A SUBMISSION IS ITSELF A FAILURE. The child pressed
       *      submit, uploaded evidence and waited. Under the old behaviour the
       *      VERIFIED branch replied and the REJECTED branch never did, so the
       *      honest reading of the product was «the app answers you when you are
       *      right». The attempt also stays open under
       *      `MAX_VERIFICATION_ATTEMPTS` — the child is expected to try again,
       *      and cannot if nothing told them to.
       *   3. THE PRODUCT ALREADY ARGUED THIS, one table over.
       *      `notification-class.ts`'s own `ACHIEVEMENT_REJECTED` row says it is
       *      DEFERRED rather than suppressed «BECAUSE it is the unwelcome one:
       *      dropping only the negative outcome would make the notification
       *      stream a systematically optimistic view of the child's week», and
       *      `GOAL_STALLED_PARENT` cites that argument by name. A quiet-hours
       *      class written for a producer that was forbidden to exist was the
       *      shape of the contradiction.
       *
       * THE REASON NEVER TRAVELS — see the payload above. The child is told
       * WHICH goal needs another look and WHO to look at it with, and nothing
       * about why it was not accepted.
       *
       * THE PRODUCER IS `NotificationAchievementConsumer` (events), through the
       * same single door — `handleEvent` -> decision -> dedup -> safety ->
       * persistence — as every other notification in this product. Nothing here
       * writes a row.
       */
      return this.repo.findAchievement(achievementId);
    }

    return this.markVerified(achievement, program, 'PARENT', userId, now);
  }

  // --- the one verification write path -------------------------------------

  /**
   * FREEZES THE MULTIPLIER AND EMITS. Both halves matter.
   *
   * The streak is recomputed here from the child's real VERIFIED rows (never
   * incremented — a counter is wrong the first time a message is redelivered),
   * the resulting multiplier is CLAMPED to the program's ceiling, and it is then
   * WRITTEN ONTO THE ROW. Every later reader — including the idempotency key —
   * reads the frozen value rather than recomputing "the streak as of now". If it
   * were recomputed, the same achievement redelivered tomorrow would produce a
   * different key and therefore a SECOND grant.
   */
  private async markVerified(
    achievement: any,
    program: any,
    verifier: 'SYSTEM' | 'PARENT',
    userId: string | null,
    now: Date,
  ): Promise<any> {
    const streakKind = CATEGORY_STREAK_KIND[program.category as ProgramCategory] ?? 'learning';
    // The stored `localDate` is already a business date at UTC midnight (see
    // `start`), so it is read back as the day it is — NOT re-derived through a
    // timezone, which would shift it by one for every family east of UTC.
    const localDate = new Date(achievement.localDate).toISOString().slice(0, 10);

    // Recompute from the rows: the same input rows always give the same streak.
    const siblingPrograms = await this.repo.listPrograms({ category: program.category });
    const dates = await this.repo.verifiedDates(
      achievement.childId,
      siblingPrograms.map((p: any) => p.id),
    );
    const streakDays = computeCurrentStreak([...dates, localDate], localDate);

    const rawBps = multiplierBpsForStreak(streakDays);
    const multiplierBps = Math.min(rawBps, program.streakMultiplierBps ?? BASE_MULTIPLIER_BPS);

    await this.repo.updateAchievement(achievement.id, {
      status: 'VERIFIED',
      decidedAt: now,
      decidedByUserId: userId,
      appliedMultiplierBps: multiplierBps,
      streakDaysAtVerification: streakDays,
    });

    const idempotencyKey = composeIdempotencyKey('ACHIEVEMENT_VERIFIED', {
      childId: achievement.childId,
      sourceId: achievement.id,
      milestone: multiplierBps,
    });

    /**
     * The payload is a `CompletionEvent` PLUS `programId` and `multiplierBps`.
     * Those two extra top-level keys are exactly what the companion
     * `RewardRule.triggerCondition` (`{ programId, multiplierBps }`) is
     * subset-matched against by the untouched `evaluateRewardRules`. That is
     * how one program with a 3-tier ladder pays the right tier without the
     * Rewards Engine knowing what a program is.
     */
    const completion: CompletionEvent & { programId: string; multiplierBps: number } = {
      schemaVersion: 1,
      completionKind: 'ACHIEVEMENT',
      childId: achievement.childId,
      deviceId: null,
      sourceType: 'AchievementRequest',
      sourceId: achievement.id,
      localDate,
      occurredAt: now.toISOString(),
      idempotencyKey,
      pointsHint: null,
      verifiedBy: verifier,
      metadata: {
        programId: program.id,
        category: program.category,
        activity: program.activity,
        streakKind,
        streakDays,
        multiplierBps,
        verificationMethod: program.verificationLevel,
        /**
         * WHAT WAS ACHIEVED, IN ARABIC, DERIVED ONCE — «الآيات 1–5 من سورة
         * الملك».
         *
         * `metadata` already carries `activity` and `category`, and both are
         * MACHINE values: a consumer that wanted to tell a parent what their
         * child finished had to turn `QURAN_MEMORIZE_AYAH_RANGE` and a surah
         * number back into a sentence, which is exactly the re-derivation
         * `RewardProgram.targetSummaryAr` was introduced to stop. Carrying the
         * already-derived sentence is what lets the reward notification and the
         * life timeline both NAME the achievement without either of them
         * learning what a surah is.
         *
         * It is a fact about the PROGRAM, not about the child: no name, no id,
         * no free text a client wrote. `describeTargetSpec` composed it from the
         * parent's own form and the Quran table, server-side.
         */
        targetSummaryAr: program.targetSummaryAr ?? '',
      },
      programId: program.id,
      multiplierBps,
    };

    await this.outbox.write({
      type: 'ACHIEVEMENT_VERIFIED',
      aggregateType: 'AchievementRequest',
      aggregateId: achievement.id,
      childId: achievement.childId,
      deviceId: null,
      idempotencyKey,
      clientEventId: null,
      occurredAt: now,
      traceId: null,
      payload: { ...completion },
    });

    this.logger.log(
      `achievement.verified id=${achievement.id} by=${verifier} streak=${streakDays} x${multiplierBps}`,
    );

    return this.repo.findAchievement(achievement.id);
  }

  // --- reads ----------------------------------------------------------------

  listPending(): Promise<any[]> {
    return this.repo.listAchievements({ status: { in: ['SUBMITTED', 'PENDING_PARENT'] } });
  }

  listForChild(childId: string): Promise<any[]> {
    return this.repo.listAchievements({ childId });
  }

  async attemptsOf(achievementId: string): Promise<any[]> {
    const achievement = await this.repo.findAchievement(achievementId);
    if (!achievement) {
      throw new NotFoundException({ code: 'ACHIEVEMENT_NOT_FOUND', messageAr: 'المحاولة غير موجودة.' });
    }
    return this.repo.listAttempts(achievementId);
  }

  /** Today's programs for a child, with the reason any of them is unavailable —
   * so the child app can grey a card out instead of failing on tap. */
  async todayForChild(childId: string, now = new Date()): Promise<any[]> {
    const child = await this.repo.findChild(childId);
    if (!child) {
      throw new NotFoundException({ code: 'CHILD_NOT_FOUND', messageAr: 'الطفل غير موجود.' });
    }
    const programs = await this.repo.listProgramsForChild(childId);
    const timeZone = await this.timeZone(child.familyId);
    const today = localDateString(now, timeZone);
    const week = weekWindow(now, timeZone);
    const age = ageInYears(new Date(child.dateOfBirth), now, timeZone);

    const out: any[] = [];
    for (const p of programs) {
      const violation = checkProgramEligibility({
        program: {
          status: p.status,
          expiresAt: p.expiresAt ?? null,
          frequency: p.frequency,
          maxPerDay: p.maxPerDay,
          maxPerWeek: p.maxPerWeek,
          minAge: p.minAge,
          difficulty: p.difficulty,
          childId: p.childId ?? null,
        },
        childId,
        childAgeYears: age,
        verifiedToday: await this.repo.countVerifiedBetween(p.id, childId, today, today),
        verifiedThisWeek: await this.repo.countVerifiedBetween(p.id, childId, week.from, week.to),
        openToday: await this.repo.countOpenOn(p.id, childId, today),
        now,
      });
      out.push({
        id: p.id,
        category: p.category,
        activity: p.activity,
        targetSummaryAr: p.targetSummaryAr,
        durationMinutes: p.durationMinutes,
        rewardSpec: p.rewardSpec,
        verificationLevel: p.verificationLevel,
        available: violation === null,
        unavailableReason: violation,
      });
    }
    return out;
  }

  /** Per-kind streaks, RECOMPUTED from verified rows. There is no streak table
   * and deliberately so — see `streak-multiplier.ts`. */
  async streaksForChild(childId: string, now = new Date()): Promise<Record<string, number>> {
    const child = await this.repo.findChild(childId);
    if (!child) {
      throw new NotFoundException({ code: 'CHILD_NOT_FOUND', messageAr: 'الطفل غير موجود.' });
    }
    const timeZone = await this.timeZone(child.familyId);
    const programs = await this.repo.listPrograms({});
    const byKind = new Map<string, string[]>();
    for (const p of programs) {
      const kind = CATEGORY_STREAK_KIND[p.category as ProgramCategory] ?? 'learning';
      const list = byKind.get(kind) ?? [];
      list.push(p.id);
      byKind.set(kind, list);
    }

    const today = localDateString(now, timeZone);
    const out: Record<string, number> = {};
    for (const [kind, ids] of byKind) {
      const dates = await this.repo.verifiedDates(childId, ids);
      out[kind] = computeCurrentStreak(dates, today);
    }
    return out;
  }
}
