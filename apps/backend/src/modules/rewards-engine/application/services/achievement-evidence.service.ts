import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaRewardProgramRepository } from '../../infrastructure/repositories/prisma-reward-program.repository';
import {
  EVIDENCE_RETENTION_DAYS,
  evidenceKindForMethod,
  inspectEvidence,
  type EvidenceKind,
} from '../../../../shared/rewards/evidence';
import { EVIDENCE_STORAGE, type IEvidenceStorage } from '../ports/evidence-storage.port';

/**
 * B5 (PA-B-019) — THE UPLOAD PATH THAT DID NOT EXIST.
 *
 * `RECITATION_SUBMISSION` and `COMPLETION_ARTIFACT` are the product's two
 * STRONG-evidence methods. Both need `submission.submissionRef`. Before B5 no
 * route in this backend could produce one — no multipart handler, no storage
 * abstraction, no file model — so every Quran memorisation program, the
 * flagship journey the F4 e2e suite is named after, could only ever return
 * `RECITATION_MISSING` from a real client.
 *
 * WHAT A SUBMISSION REF IS NOW: the id of an `achievement_evidence` row. It is
 * an opaque uuid, it is scoped to one achievement, and `AchievementService`
 * accepts it only after this service has confirmed it belongs to the same
 * attempt — so a child cannot point at another child's recording, and cannot
 * re-point last week's recording at today's program.
 *
 * WHAT IS NOT BUILT, restated because the verification matrix already promised
 * it and must keep the promise: NO audio ML. Nothing here listens to the file.
 * The parent still confirms, `canAutoApprove` stays `false` for both methods,
 * and the only thing the server asserts about the bytes is that they are a
 * plausible, in-policy, correctly-typed media file of a sane size.
 */
@Injectable()
export class AchievementEvidenceService {
  constructor(
    private readonly repo: PrismaRewardProgramRepository,
    @Inject(EVIDENCE_STORAGE) private readonly storage: IEvidenceStorage,
  ) {}

  /**
   * THE CHILD'S UPLOAD. Order of checks is deliberate and is the security
   * design, not a style choice:
   *
   *   1. OWNERSHIP FIRST. The achievement must exist and belong to THIS child.
   *      Same-family sibling access is invisible to the tenant extension (same
   *      `family_id`), so it is checked here explicitly, exactly as
   *      `AchievementService.submit` checks it.
   *   2. WHAT KIND OF EVIDENCE THE PROGRAM ACTUALLY WANTS, derived from the
   *      program's verification method by the SERVER. A client never states a
   *      kind; if it could, the type check in step 4 would be checking a
   *      claim against a claim.
   *   3. STATE. An attempt that is already decided does not accept new
   *      evidence — otherwise the audit trail behind a granted reward could be
   *      edited after the fact.
   *   4. THE BYTES. Size, then magic-byte signature, then whether that
   *      signature is legal for the kind from step 2. The declared
   *      `Content-Type` is used for nothing.
   *   5. STORE, then RECORD. Bytes first so a database row never references an
   *      object that is not there; a stored object with no row is merely
   *      garbage the retention sweep will never see, which is the strictly
   *      better failure.
   */
  async upload(input: {
    childId: string;
    achievementId: string;
    bytes: Buffer;
    originalFilename?: string;
    now?: Date;
  }): Promise<{ submissionRef: string; kind: EvidenceKind; mimeType: string; byteSize: number }> {
    const now = input.now ?? new Date();

    const achievement = await this.repo.findAchievement(input.achievementId);
    if (!achievement) {
      throw new NotFoundException({ code: 'ACHIEVEMENT_NOT_FOUND', messageAr: 'المحاولة غير موجودة.' });
    }
    if (achievement.childId !== input.childId) {
      throw new ForbiddenException({ code: 'NOT_YOUR_ACHIEVEMENT', messageAr: 'هذه ليست محاولتك.' });
    }
    if (!['REQUESTED', 'IN_PROGRESS'].includes(String(achievement.status))) {
      throw new ConflictException({
        code: 'ACHIEVEMENT_NOT_SUBMITTABLE',
        messageAr: 'هذه المحاولة لم تعد قابلة للإرسال.',
      });
    }

    const program = await this.repo.findProgram(achievement.programId);
    if (!program) {
      throw new NotFoundException({ code: 'PROGRAM_NOT_FOUND', messageAr: 'البرنامج غير موجود.' });
    }

    const kind = evidenceKindForMethod(String(program.verificationLevel));
    if (!kind) {
      throw new ConflictException({
        code: 'PROGRAM_TAKES_NO_EVIDENCE',
        messageAr: 'هذا البرنامج لا يحتاج رفع ملف.',
      });
    }

    const inspection = inspectEvidence(input.bytes, kind);
    if (!inspection.ok) {
      throw new BadRequestException({ code: inspection.code, messageAr: inspection.messageAr });
    }

    // CONTENT-ADDRESSED IDEMPOTENCY. A mobile client that retries a 15 MB
    // upload over a flaky connection must not create two rows and two objects
    // for one recording. The hash is computed here and the uniqueness is
    // enforced by `achievement_evidence (achievement_id, sha256)` — the check
    // below is the fast path, the index is the guarantee, the same
    // relationship every other dedupe in this codebase now has after B9.
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const existing = await this.repo.findEvidenceByHash(input.achievementId, sha256);
    if (existing) {
      return {
        submissionRef: String(existing.id),
        kind: existing.kind as EvidenceKind,
        mimeType: String(existing.mimeType),
        byteSize: Number(existing.byteSize),
      };
    }

    const id = randomUUID();
    // TENANT-PREFIXED, so a bucket policy or a filesystem ACL can be written
    // against the prefix once and apply to every object a family ever stores.
    const storageKey = `${achievement.familyId}/${input.childId}/${input.achievementId}/${id}.${inspection.extension}`;

    await this.storage.put(storageKey, input.bytes, inspection.mimeType);

    try {
      const row = await this.repo.createEvidence({
        id,
        achievementId: input.achievementId,
        childId: input.childId,
        kind,
        storageKey,
        mimeType: inspection.mimeType,
        byteSize: input.bytes.length,
        sha256,
        originalFilename: input.originalFilename?.slice(0, 255) ?? null,
        // THE RETENTION HOOK, set at write time rather than computed at sweep
        // time: a policy change must not silently re-date objects that were
        // stored under the old one.
        retainUntil: new Date(now.getTime() + EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000),
      });
      return {
        submissionRef: String(row.id),
        kind,
        mimeType: inspection.mimeType,
        byteSize: input.bytes.length,
      };
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        // Two concurrent uploads of the same bytes; the loser drops its object
        // and returns the winner's row, so the caller sees one ref either way.
        await this.storage.delete(storageKey);
        const winner = await this.repo.findEvidenceByHash(input.achievementId, sha256);
        if (winner) {
          return {
            submissionRef: String(winner.id),
            kind,
            mimeType: String(winner.mimeType),
            byteSize: Number(winner.byteSize),
          };
        }
      }
      throw err;
    }
  }

  /**
   * THE PARENT'S REVIEW READ. Tenant scoping comes from the F2 Prisma
   * extension (`AchievementEvidence` is STRICT), so a parent in family B
   * receives a 404 for family A's evidence rather than a 403 — the project's
   * own "don't reveal what you don't own" rule, unchanged.
   *
   * Returns the bytes, not a URL. See `evidence-storage.port.ts` for why a
   * signed URL was rejected.
   */
  async read(evidenceId: string): Promise<{ bytes: Buffer; mimeType: string; byteSize: number }> {
    const row = await this.repo.findEvidence(evidenceId);
    if (!row) {
      throw new NotFoundException({ code: 'EVIDENCE_NOT_FOUND', messageAr: 'الملف غير موجود.' });
    }
    const bytes = await this.storage.get(String(row.storageKey));
    if (!bytes) {
      // The row outlived the object — a retention sweep, or a storage backend
      // swapped without a migration. A 404 with a real code, not a 500: the
      // client can say «انتهت مدة حفظ هذا الملف» instead of «حدث خطأ».
      throw new NotFoundException({ code: 'EVIDENCE_EXPIRED', messageAr: 'انتهت مدة حفظ هذا الملف.' });
    }
    return { bytes, mimeType: String(row.mimeType), byteSize: Number(row.byteSize) };
  }

  /** What the parent's review screen lists. Never includes `storageKey`. */
  list(achievementId: string): Promise<unknown[]> {
    return this.repo.listEvidence(achievementId);
  }

  /**
   * THE `submissionRef` VALIDATOR, called by `AchievementService.submit`.
   *
   * Without it, `submissionRef` would be a free string again and the whole
   * upload path would be decorative: a child could submit
   * `{"submissionRef": "anything"}` and `RECITATION_SUBMISSION` would escalate
   * to a parent with no recording attached. It resolves the ref against THIS
   * achievement, so a valid ref for a different attempt is as invalid as a
   * made-up one.
   */
  async assertBelongsToAchievement(submissionRef: string, achievementId: string): Promise<void> {
    const row = await this.repo.findEvidence(submissionRef);
    if (!row || String(row.achievementId) !== achievementId) {
      throw new BadRequestException({
        code: 'EVIDENCE_REF_INVALID',
        messageAr: 'الملف المرفق غير مرتبط بهذه المحاولة. ارفع الملف ثم أعد الإرسال.',
      });
    }
  }
}
