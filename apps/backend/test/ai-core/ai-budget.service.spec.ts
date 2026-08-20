import { Test } from '@nestjs/testing';

import { PrismaService } from '../../src/common/prisma/prisma.service';
import {
  AiBudgetService,
  FAMILY_MONTHLY_BUDGET_MICRO_CENTS,
} from '../../src/modules/ai-core/infrastructure/ai-budget.service';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';

/**
 * B8 — THE SPEND CUT-OFF (PA-B-028 closed).
 *
 * Phase A: «ضبط التكلفة رصدي فقط، لا سقف يوقف الإنفاق … لا فحص حصة قبل
 * complete() في أي مكان ⇒ هدف CONTEXT §6 (≤ $0.06/أسرة/شهر) غير قابل للفرض».
 * These tests are the difference between a report and a budget.
 */

describe('AiBudgetService — a cap that actually stops spending', () => {
  let service: AiBudgetService;
  const prisma = { aiUsageLog: { aggregate: jest.fn() } };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [AiBudgetService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(AiBudgetService);
  });

  const spend = (microCents: number): void => {
    prisma.aiUsageLog.aggregate.mockResolvedValue({ _sum: { estimatedCostMicroCents: microCents } });
  };

  it('the cap is $0.09/family/month — 150% of the $0.06 target, not equal to it', () => {
    // Equal to the target would cut off every family above the median, since
    // the target is an AVERAGE across families.
    expect(FAMILY_MONTHLY_BUDGET_MICRO_CENTS).toBe(9_000_000);
    expect(FAMILY_MONTHLY_BUDGET_MICRO_CENTS / 100_000_000).toBeCloseTo(0.09, 6);
  });

  it('reports spend in dollars and a remaining balance', async () => {
    spend(3_000_000);
    const status = await service.status(new Date('2026-08-15T10:00:00Z'));

    expect(status.spentUsd).toBeCloseTo(0.03, 6);
    expect(status.limitUsd).toBeCloseTo(0.09, 6);
    expect(status.remainingMicroCents).toBe(6_000_000);
    expect(status.exhausted).toBe(false);
  });

  it('is exhausted at exactly the cap, not one micro-cent later', async () => {
    spend(FAMILY_MONTHLY_BUDGET_MICRO_CENTS);
    expect((await service.status()).exhausted).toBe(true);
    expect(await service.hasBudget()).toBe(false);

    spend(FAMILY_MONTHLY_BUDGET_MICRO_CENTS - 1);
    expect(await service.hasBudget()).toBe(true);
  });

  it('a family with no spend at all has full budget', async () => {
    prisma.aiUsageLog.aggregate.mockResolvedValue({ _sum: { estimatedCostMicroCents: null } });
    const status = await service.status();
    expect(status.spentMicroCents).toBe(0);
    expect(status.exhausted).toBe(false);
  });

  it('the period is the CALENDAR MONTH — a billing window, not a family day', async () => {
    spend(0);
    await service.status(new Date('2026-08-15T23:59:00Z'));
    const where = prisma.aiUsageLog.aggregate.mock.calls[0][0].where;
    expect(where.createdAt.gte.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('does NOT filter by familyId itself — the tenant extension already does', async () => {
    // A second copy of a tenancy rule is a second copy free to drift. The
    // extension scopes `AiUsageLog` reads to the caller's family globally.
    spend(0);
    await service.status();
    const where = prisma.aiUsageLog.aggregate.mock.calls[0][0].where;
    expect(Object.keys(where)).toEqual(['createdAt']);
  });

  it('reports the caller’s family when there is a tenant context', async () => {
    spend(1_000);
    const status = await runWithTenant(
      { familyId: 'fam-1', actorType: 'USER', actorId: 'user-1' },
      () => service.status(),
    );
    expect(status.familyId).toBe('fam-1');
  });

  it('FAILS OPEN when the counter cannot be read — a DB hiccup is not a product outage', async () => {
    // The opposite choice is right for the SAFETY filter and wrong here, and
    // the two are different files for exactly this reason: the cap protects
    // $0.09, and refusing every AI call because a counter was unreadable
    // converts an infrastructure blip into a feature outage.
    prisma.aiUsageLog.aggregate.mockRejectedValue(new Error('connection reset'));
    expect(await service.hasBudget()).toBe(true);
    expect((await service.status()).spentMicroCents).toBe(0);
  });
});
