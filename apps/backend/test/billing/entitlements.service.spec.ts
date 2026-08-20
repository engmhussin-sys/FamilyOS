import { Test } from '@nestjs/testing';
import { EntitlementsService } from '../../src/modules/billing/application/services/entitlements.service';
import { EntitlementService } from '../../src/modules/billing/application/services/entitlement.service';
import { BILLING_REPOSITORY } from '../../src/modules/billing/application/ports/billing.repository.port';
import { PAYMENT_REPOSITORY } from '../../src/modules/billing/application/ports/payment.repository.port';

/**
 * ============================================================================
 * SPRINT F1 (P0) — THE MERGED ANSWER, THROUGH THE OLD SYMBOL.
 * ============================================================================
 *
 * `EntitlementsService` used to own a second `hasFeature` with its own
 * `{TRIALING, ACTIVE}` status set. It is now a zero-logic delegate to
 * `EntitlementService`, so this suite wires the REAL survivor behind it — no
 * mock of `hasFeature` anywhere — and asserts what four call sites see.
 *
 * EVERY ORIGINAL ASSERTION IS KEPT VERBATIM. The six cases below marked
 * REGRESSION PIN are the Sprint 8 suite's own, unchanged, because the point of
 * a merge is that the common cases do not move: no-subscription, ACTIVE,
 * TRIALING, PAST_DUE, CANCELED and missing-plan must answer exactly what they
 * answered before. The cases marked THE DEFECT are the two that were wrong.
 */
describe('EntitlementsService (delegate) — the one entitlement answer', () => {
  const billingMock = { findSubscriptionByFamily: jest.fn(), findPlanByTier: jest.fn() };
  const paymentsMock = { findEntitlement: jest.fn() };
  let service: EntitlementsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // No materialised entitlement row unless a test says otherwise — the state
    // every pre-Phase-D family and every `SubscriptionService.subscribe`
    // household is in.
    paymentsMock.findEntitlement.mockResolvedValue(null);
    const moduleRef = await Test.createTestingModule({
      providers: [
        EntitlementsService,
        EntitlementService,
        { provide: BILLING_REPOSITORY, useValue: billingMock },
        { provide: PAYMENT_REPOSITORY, useValue: paymentsMock },
      ],
    }).compile();
    service = moduleRef.get(EntitlementsService);
  });

  it('REGRESSION PIN — treats a family with no subscription row as FREE tier', async () => {
    billingMock.findSubscriptionByFamily.mockResolvedValue(null);
    billingMock.findPlanByTier.mockResolvedValue({ features: ['multiple_children'] });

    const result = await service.hasFeature('family-1', 'multiple_children');

    expect(billingMock.findPlanByTier).toHaveBeenCalledWith('FREE');
    expect(result).toBe(true);
  });

  it('REGRESSION PIN — grants a feature present in an ACTIVE PREMIUM plan', async () => {
    billingMock.findSubscriptionByFamily.mockResolvedValue({ planTier: 'PREMIUM', status: 'ACTIVE' });
    billingMock.findPlanByTier.mockResolvedValue({ features: ['ai_diagnostics'] });

    const result = await service.hasFeature('family-1', 'ai_diagnostics');

    expect(billingMock.findPlanByTier).toHaveBeenCalledWith('PREMIUM');
    expect(result).toBe(true);
  });

  it('REGRESSION PIN — grants features while TRIALING, same as ACTIVE', async () => {
    billingMock.findSubscriptionByFamily.mockResolvedValue({ planTier: 'PREMIUM', status: 'TRIALING' });
    billingMock.findPlanByTier.mockResolvedValue({ features: ['ai_diagnostics'] });

    const result = await service.hasFeature('family-1', 'ai_diagnostics');

    expect(result).toBe(true);
  });

  it('REGRESSION PIN — falls back to FREE features when the subscription is PAST_DUE', async () => {
    billingMock.findSubscriptionByFamily.mockResolvedValue({ planTier: 'PREMIUM', status: 'PAST_DUE' });
    billingMock.findPlanByTier.mockResolvedValue({ features: ['multiple_children'] });

    const result = await service.hasFeature('family-1', 'ai_diagnostics');

    expect(billingMock.findPlanByTier).toHaveBeenCalledWith('FREE');
    expect(result).toBe(false);
  });

  it('REGRESSION PIN — falls back to FREE features when the subscription is CANCELED', async () => {
    billingMock.findSubscriptionByFamily.mockResolvedValue({ planTier: 'FAMILY', status: 'CANCELED' });
    billingMock.findPlanByTier.mockResolvedValue({ features: [] });

    const result = await service.hasFeature('family-1', 'unlimited_devices_per_child');

    expect(billingMock.findPlanByTier).toHaveBeenCalledWith('FREE');
    expect(result).toBe(false);
  });

  it('REGRESSION PIN — returns false when the plan definition itself is missing (defensive default)', async () => {
    billingMock.findSubscriptionByFamily.mockResolvedValue(null);
    billingMock.findPlanByTier.mockResolvedValue(null);

    const result = await service.hasFeature('family-1', 'ai_diagnostics');

    expect(result).toBe(false);
  });

  /**
   * THE DEFECT, DIRECTION 1 — a household that HAS PAID was refused. This
   * returned `false` before the merge, against schema.prisma's own promise of
   * full access for the seven-day window.
   */
  it('THE DEFECT — a GRACE_PERIOD household keeps its plan features', async () => {
    billingMock.findSubscriptionByFamily.mockResolvedValue({ planTier: 'FAMILY', status: 'GRACE_PERIOD' });
    billingMock.findPlanByTier.mockResolvedValue({ features: ['multiple_children'] });

    const result = await service.hasFeature('family-1', 'multiple_children');

    expect(billingMock.findPlanByTier).toHaveBeenCalledWith('FAMILY');
    expect(result).toBe(true);
  });

  /**
   * THE DEFECT, DIRECTION 2 — a refunded household kept access. The revoked
   * row is now read, and it does NOT fall through to the subscription
   * computation: the `subscriptions` row here still says ACTIVE, which is
   * exactly the state `PaymentWebhookService` leaves behind when a stale,
   * out-of-order refund event is dropped by `applySubscriptionStateIfNewer`
   * and `revokeAll` runs anyway.
   */
  it('THE DEFECT — a REVOKED entitlement row refuses, even while the subscription still says ACTIVE', async () => {
    paymentsMock.findEntitlement.mockResolvedValue({
      status: 'REVOKED',
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validUntil: null,
      revokedAt: new Date('2026-02-01T00:00:00.000Z'),
      revokedReason: 'refund',
    });
    billingMock.findSubscriptionByFamily.mockResolvedValue({ planTier: 'FAMILY', status: 'ACTIVE' });
    billingMock.findPlanByTier.mockResolvedValue({ features: ['multiple_children'] });

    const result = await service.hasFeature('family-1', 'multiple_children');

    expect(result).toBe(false);
    // The revocation is the answer. Nothing was inferred from `subscriptions`.
    expect(billingMock.findSubscriptionByFamily).not.toHaveBeenCalled();
  });

  it('a LIVE entitlement row grants the feature with no subscription lookup at all', async () => {
    paymentsMock.findEntitlement.mockResolvedValue({
      status: 'ACTIVE',
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validUntil: new Date('2099-01-01T00:00:00.000Z'),
    });

    expect(await service.hasFeature('family-1', 'priority_support')).toBe(true);
    expect(billingMock.findSubscriptionByFamily).not.toHaveBeenCalled();
  });

  /**
   * THE MERGE ITSELF. The delegate must not have an opinion: whatever the
   * survivor answers is what four call sites see, byte for byte.
   */
  it('is a pure delegate — the survivor is asked, and its answer is returned unchanged', async () => {
    const survivor = (service as unknown as { entitlements: EntitlementService }).entitlements;
    const spy = jest.spyOn(survivor, 'hasFeature').mockResolvedValue(true);

    await expect(service.hasFeature('family-1', 'family_insights')).resolves.toBe(true);
    expect(spy).toHaveBeenCalledWith('family-1', 'family_insights');

    spy.mockResolvedValue(false);
    await expect(service.hasFeature('family-1', 'family_insights')).resolves.toBe(false);
    spy.mockRestore();
  });
});
