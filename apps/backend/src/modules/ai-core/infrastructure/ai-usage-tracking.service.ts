import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { AiCostCalculator } from './ai-cost-calculator';

export interface IAiUsageSummary {
  windowDays: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byFeature: Record<string, { calls: number; costUsd: number }>;
}

/**
 * AUTHORIZED PARTIAL AI-CORE UNFREEZE (explicit user permission,
 * scoped to AI Cost Tracking only). CLOSES A REAL GAP:
 * AnthropicAIProvider's own trackCost() logged real per-call token
 * usage but only to structured logs — this is the queryable-storage
 * follow-up that same method's own docstring already flagged as
 * needed. Write path only touches this NEW table; zero change to any
 * AI decision-making logic anywhere in ai-core.
 */
@Injectable()
export class AiUsageTrackingService {
  private readonly logger = new Logger(AiUsageTrackingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly costCalculator: AiCostCalculator,
  ) {}

  /** A failure to WRITE the usage log must never fail the underlying
   * AI call itself (called after the real response is already on its
   * way back to the caller) — caught and logged, not propagated. */
  async record(model: string, inputTokens: number, outputTokens: number, sourceFeature?: string): Promise<void> {
    try {
      const estimatedCostMicroCents = this.costCalculator.calculateCostMicroCents(model, inputTokens, outputTokens);
      await this.prisma.aiUsageLog.create({
        data: { model, inputTokens, outputTokens, estimatedCostMicroCents, sourceFeature },
      });
    } catch (err) {
      this.logger.warn('Failed to write AI usage log — the AI call itself still succeeded.', err instanceof Error ? err.message : err);
    }
  }

  /** Real, queryable cost attribution — the exact capability
   * AnthropicAIProvider's own comment flagged as the missing
   * follow-up. Read-only, never touches ai-core's decision-making. */
  async getSummary(windowDays: number): Promise<IAiUsageSummary> {
    const since = new Date();
    since.setDate(since.getDate() - windowDays);

    const rows = await this.prisma.aiUsageLog.findMany({
      where: { createdAt: { gte: since } },
      select: { inputTokens: true, outputTokens: true, estimatedCostMicroCents: true, sourceFeature: true },
    });

    const byFeature: Record<string, { calls: number; costMicroCents: number }> = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostMicroCents = 0;

    for (const row of rows) {
      totalInputTokens += row.inputTokens;
      totalOutputTokens += row.outputTokens;
      totalCostMicroCents += row.estimatedCostMicroCents;

      const key = row.sourceFeature ?? 'unattributed';
      byFeature[key] ??= { calls: 0, costMicroCents: 0 };
      byFeature[key].calls += 1;
      byFeature[key].costMicroCents += row.estimatedCostMicroCents;
    }

    return {
      windowDays,
      totalCalls: rows.length,
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd: totalCostMicroCents / 100_000_000,
      byFeature: Object.fromEntries(
        Object.entries(byFeature).map(([key, v]) => [key, { calls: v.calls, costUsd: v.costMicroCents / 100_000_000 }]),
      ),
    };
  }
}
