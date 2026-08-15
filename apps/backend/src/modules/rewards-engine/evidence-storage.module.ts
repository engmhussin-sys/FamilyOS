import { Module } from '@nestjs/common';

import { EVIDENCE_STORAGE } from './application/ports/evidence-storage.port';
import { LocalDiskEvidenceStorage } from './infrastructure/storage/local-disk-evidence.storage';

/**
 * B5 (PA-B-019) — THE ONE PLACE THE STORAGE BACKEND IS CHOSEN.
 *
 * A separate, dependency-free module rather than a provider inside
 * `RewardsEngineModule`, because `EVIDENCE_STORAGE` genuinely has two
 * consumers with nothing else in common: the reward engine WRITES and READS
 * evidence, and `DataRetentionEnforcementService` DELETES it. Duplicating the
 * provider in both would give the process two storage instances and, the day
 * the S3 adapter lands with a connection pool, two pools — the classic
 * "registering a second bus" mistake this repository already warns about in
 * `RewardsEngineModule`'s own docstring.
 *
 * SWAPPING THE BACKEND IS THIS FILE AND NOTHING ELSE: replace
 * `LocalDiskEvidenceStorage` with an S3-compatible adapter implementing the
 * same four verbs. No service, controller, DTO or test changes, because no
 * caller anywhere holds a path.
 */
@Module({
  providers: [{ provide: EVIDENCE_STORAGE, useClass: LocalDiskEvidenceStorage }],
  exports: [EVIDENCE_STORAGE],
})
export class EvidenceStorageModule {}
