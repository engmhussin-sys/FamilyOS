import { Inject, Injectable } from '@nestjs/common';

import {
  AI_MEMORY_REPOSITORY,
  type IAiMemoryRepository,
} from '../../domain/memory.types';

const VIOLATION_LOOKBACK_DAYS = 30;

/**
 * Sprint 7's Memory Engine. "The AI must learn from FamilyOS data, not
 * from external models" — concretely: every category here is written
 * FROM FamilyOS's own signals (Risk/Trust/Runtime), never from an LLM's
 * output being treated as ground truth. An LLM is never the source of
 * a memory entry — RecommendationEngineService.record() call sites
 * always pass structured, locally-derived data.
 */
@Injectable()
export class MemoryEngineService {
  constructor(
    @Inject(AI_MEMORY_REPOSITORY) private readonly repository: IAiMemoryRepository,
  ) {}

  async recordViolation(childId: string, violationType: string, details: Record<string, unknown>): Promise<void> {
    await this.repository.record(childId, 'VIOLATION', { violationType, ...details });
  }

  async getRecentViolationCount(childId: string, days: number = VIOLATION_LOOKBACK_DAYS): Promise<number> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return this.repository.countByCategorySince(childId, 'VIOLATION', since);
  }

  async recordRecommendation(childId: string, recommendation: Record<string, unknown>): Promise<void> {
    await this.repository.record(childId, 'RECOMMENDATION', recommendation);
  }

  async getRecommendationHistory(childId: string) {
    return this.repository.findAllByCategory(childId, 'RECOMMENDATION');
  }

  /** Sprint 8 — AI Decision History. Same underlying data as
   * getRecommendationHistory (RECOMMENDATION category rows), named
   * distinctly because the read intent differs: this is "show me every
   * decision and why," not "what have we recommended." Both accessors
   * are kept since existing callers of the former shouldn't need to
   * change meaning. */
  async getDecisionHistory(childId: string, limit: number = 20) {
    const history = await this.repository.findAllByCategory(childId, 'RECOMMENDATION');
    return history.slice(0, limit);
  }

  async setPreference(childId: string, key: string, value: Record<string, unknown>): Promise<void> {
    await this.repository.upsert(childId, 'PREFERENCE', key, value);
  }

  async getPreference(childId: string, key: string) {
    return this.repository.find(childId, 'PREFERENCE', key);
  }

  async setConfidenceScore(childId: string, engineKey: string, confidence: number): Promise<void> {
    await this.repository.upsert(childId, 'CONFIDENCE', engineKey, { confidence, recordedAt: new Date().toISOString() });
  }
}
