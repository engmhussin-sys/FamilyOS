/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { OutboxWriter } from '../../../events/application/outbox.writer';
import { composeIdempotencyKey } from '../../../../shared/events/idempotency';
import {
  activityBelongsToCategory,
  isProgramActivity,
  isProgramCategory,
  type ProgramActivity,
  type ProgramCategory,
} from '../../../../shared/rewards/program-taxonomy';
import { describeTargetSpec, validateTargetSpec } from '../../../../shared/rewards/target-spec';
import { validateRewardSpec, type RewardSpec } from '../../../../shared/rewards/reward-spec';
import {
  SELF_CHECK_ALLOWED_CATEGORIES,
  VERIFICATION_MATRIX,
  isVerificationMethod,
} from '../../../../shared/rewards/verification';
import { PrismaRewardProgramRepository } from '../../infrastructure/repositories/prisma-reward-program.repository';
import type { CreateRewardProgramDto, UpdateRewardProgramDto } from '../dto/reward-program.dto';

/**
 * PROGRAM CRUD — the parent's authoring surface.
 *
 * Three things happen on create, in this order, and the order is the design:
 *
 *   1. VALIDATE against the domain, not against a shape. Category/activity
 *      pairing, the target spec against the REAL surah table, the reward spec
 *      including the screen-time ceiling, and the verification level against
 *      `VERIFICATION_MATRIX` (a low-trust method on a high-trust category is a
 *      400 here, not a note in a document).
 *   2. WRITE the program and MATERIALISE its companion `RewardRule` rows in ONE
 *      transaction, together with the `REWARD_PROGRAM_CREATED` outbox message.
 *      A program whose rules did not commit would be a program that can never
 *      pay, which is worse than a program that failed to be created.
 *   3. Return it.
 *
 * The tenant is never an argument: `PrismaRewardProgramRepository` stamps it
 * from the ambient context established by the verified session (F2).
 */
@Injectable()
export class RewardProgramService {
  private readonly logger = new Logger(RewardProgramService.name);

  constructor(
    private readonly repo: PrismaRewardProgramRepository,
    private readonly children: ChildrenService,
    private readonly outbox: OutboxWriter,
  ) {}

  async create(familyId: string, createdByUserId: string, dto: CreateRewardProgramDto): Promise<any> {
    if (dto.childId) {
      await this.children.assertChildBelongsToFamily(dto.childId, familyId);
    }

    const category = dto.category as ProgramCategory;
    const activity = dto.activity as ProgramActivity;

    if (!isProgramCategory(category) || !isProgramActivity(activity)) {
      throw new BadRequestException({ code: 'UNKNOWN_TAXONOMY', messageAr: 'التصنيف أو النشاط غير معروف.' });
    }
    if (!activityBelongsToCategory(category, activity)) {
      throw new BadRequestException({
        code: 'ACTIVITY_NOT_IN_CATEGORY',
        messageAr: 'هذا النشاط لا ينتمي إلى هذا التصنيف.',
      });
    }

    const targetErrors = validateTargetSpec(category, activity, dto.targetSpec);
    if (targetErrors.length > 0) {
      throw new BadRequestException({ code: 'TARGET_SPEC_INVALID', errors: targetErrors });
    }

    const rewardErrors = validateRewardSpec(dto.rewardSpec);
    if (rewardErrors.length > 0) {
      throw new BadRequestException({ code: 'REWARD_SPEC_INVALID', errors: rewardErrors });
    }

    if (!isVerificationMethod(dto.verificationLevel)) {
      throw new BadRequestException({
        code: 'VERIFICATION_METHOD_UNKNOWN',
        messageAr: 'مستوى التحقق غير معروف.',
      });
    }

    // THE LOW-TRUST GATE. `SELF_CHECK` on a Quran memorisation program would
    // make the flagship feature a self-service points button. This is where
    // that is stopped, by data (`lowTrustOnly` + the allowed-category set), not
    // by a hand-written condition per category.
    const spec = VERIFICATION_MATRIX[dto.verificationLevel];
    if (spec.lowTrustOnly && !SELF_CHECK_ALLOWED_CATEGORIES.has(category)) {
      throw new BadRequestException({
        code: 'VERIFICATION_TOO_WEAK_FOR_CATEGORY',
        messageAr: 'التأكيد الذاتي غير كافٍ لهذا النوع من الأنشطة. اختر تأكيد ولي الأمر أو تسميعًا.',
      });
    }

    const rewardSpec = dto.rewardSpec as unknown as RewardSpec;
    const ceilingBps = dto.streakMultiplierBps ?? 30000;

    const created = await this.repo.createProgram({
      childId: dto.childId ?? null,
      category,
      activity,
      targetSpec: dto.targetSpec,
      targetSummaryAr: describeTargetSpec(activity, dto.targetSpec as any),
      durationMinutes: dto.durationMinutes,
      verificationLevel: dto.verificationLevel,
      verificationConfig: dto.verificationConfig ?? {},
      rewardSpec: dto.rewardSpec,
      frequency: dto.frequency ?? 'DAILY',
      maxPerDay: dto.maxPerDay ?? 1,
      maxPerWeek: dto.maxPerWeek ?? 7,
      minAge: dto.minAge ?? 0,
      difficulty: dto.difficulty ?? 'MEDIUM',
      requiresParentApproval: dto.requiresParentApproval ?? false,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      streakMultiplierBps: ceilingBps,
      status: 'ACTIVE',
      createdByUserId,
    });

    // The REUSE seam: one companion RewardRule per multiplier tier, carrying
    // the already-multiplied amount. `RewardsEngineService` pays them with zero
    // lines changed in it.
    const ruleCount = await this.repo.materialiseProgramRules(created.id, rewardSpec, ceilingBps);

    await this.outbox.write({
      type: 'REWARD_PROGRAM_CREATED',
      aggregateType: 'RewardProgram',
      aggregateId: created.id,
      childId: dto.childId ?? null,
      deviceId: null,
      idempotencyKey: composeIdempotencyKey('REWARD_PROGRAM_CREATED', { sourceId: created.id }),
      clientEventId: null,
      occurredAt: new Date(),
      traceId: null,
      payload: {
        programId: created.id,
        category,
        activity,
        childId: dto.childId ?? null,
        rewardType: rewardSpec.type,
        rewardAmount: rewardSpec.amount,
        verificationLevel: dto.verificationLevel,
      },
    });

    this.logger.log(`reward_program.created id=${created.id} category=${category} rules=${ruleCount}`);
    return created;
  }

  async list(familyId: string, childId?: string): Promise<any[]> {
    if (childId) await this.children.assertChildBelongsToFamily(childId, familyId);
    return this.repo.listPrograms(childId ? { OR: [{ childId }, { childId: null }] } : {});
  }

  async get(programId: string): Promise<any> {
    const program = await this.repo.findProgram(programId);
    // Cross-tenant reads never reach here: the F2 extension scopes the query,
    // so another family's program is simply NOT FOUND — never "forbidden",
    // which would confirm it exists.
    if (!program) throw new NotFoundException({ code: 'PROGRAM_NOT_FOUND', messageAr: 'البرنامج غير موجود.' });
    return program;
  }

  async update(programId: string, dto: UpdateRewardProgramDto): Promise<any> {
    const program = await this.get(programId);

    const data: Record<string, unknown> = {};
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.maxPerDay !== undefined) data.maxPerDay = dto.maxPerDay;
    if (dto.maxPerWeek !== undefined) data.maxPerWeek = dto.maxPerWeek;
    if (dto.requiresParentApproval !== undefined) data.requiresParentApproval = dto.requiresParentApproval;
    if (dto.difficulty !== undefined) data.difficulty = dto.difficulty;
    if (dto.expiresAt !== undefined) data.expiresAt = new Date(dto.expiresAt);
    if (dto.status === 'ARCHIVED') data.archivedAt = new Date();

    const updated = await this.repo.updateProgram(program.id, data);

    // Archiving or pausing a program must stop it paying. Deactivating the
    // companion rules is what actually does that — the engine only evaluates
    // `isActive` rules, so this is one write instead of a new check in a hot
    // path.
    if (dto.status === 'ARCHIVED' || dto.status === 'PAUSED') {
      await this.repo.deactivateProgramRules(program.id);
    }

    return updated;
  }

  async remove(programId: string): Promise<{ archived: true }> {
    const program = await this.get(programId);
    await this.repo.updateProgram(program.id, { status: 'ARCHIVED', archivedAt: new Date() });
    await this.repo.deactivateProgramRules(program.id);
    // ARCHIVED, never deleted: a deleted program would orphan the ledger rows
    // that reference it, and the ledger is append-only evidence.
    return { archived: true };
  }
}
