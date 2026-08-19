import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { CHILD_REPOSITORY } from '../../src/modules/children/application/ports/child.repository.port';
import { ChildNotFoundException } from '../../src/modules/children/domain/child.errors';
import { EntitlementsService } from '../../src/modules/billing/application/services/entitlements.service';
import { GrowthEventEmitter } from '../../src/modules/analytics/application/growth-event-emitter.service';

describe('ChildrenService', () => {
  const childRepositoryMock = {
    create: jest.fn(),
    findManyByFamily: jest.fn(),
    findOneScopedToFamily: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
  };
  const entitlementsMock = { hasFeature: jest.fn() };

  let service: ChildrenService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChildrenService,
        { provide: CHILD_REPOSITORY, useValue: childRepositoryMock },
        { provide: EntitlementsService, useValue: entitlementsMock },
        // PHASE D (GROWTH). `emit` never throws by contract (see the emitter's
        // class docstring), so a double that resolves is a faithful stand-in —
        // and these suites are about the business path, not about telemetry.
        { provide: GrowthEventEmitter, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = moduleRef.get(ChildrenService);
  });

  describe('createChild (proactive business/code audit — multiple_children enforcement)', () => {
    it('allows creating the FIRST child on any tier, without even checking entitlements', async () => {
      childRepositoryMock.findManyByFamily.mockResolvedValue([]);
      childRepositoryMock.create.mockResolvedValue({ id: 'child-1' });

      const result = await service.createChild('family-1', { firstName: 'Ahmed', dateOfBirth: '2015-01-01' });

      expect(result).toEqual({ id: 'child-1' });
      expect(entitlementsMock.hasFeature).not.toHaveBeenCalled();
    });

    it('blocks a SECOND child when multiple_children is not entitled', async () => {
      childRepositoryMock.findManyByFamily.mockResolvedValue([{ id: 'child-1' }]);
      entitlementsMock.hasFeature.mockResolvedValue(false);

      await expect(
        service.createChild('family-1', { firstName: 'Sara', dateOfBirth: '2017-01-01' }),
      ).rejects.toThrow(ForbiddenException);

      expect(entitlementsMock.hasFeature).toHaveBeenCalledWith('family-1', 'multiple_children');
      expect(childRepositoryMock.create).not.toHaveBeenCalled();
    });

    /**
     * ===================================================================
     * F1 — THE PAYWALL IS THE SENTENCE THAT DECIDES A PURCHASE, AND IT
     * NAMED A DATABASE ROW, IN ENGLISH.
     * ===================================================================
     *
     * What was thrown was the bare string «Adding more than one child
     * requires a plan with the multiple_children feature.» The parent app
     * resolves `messageAr ?? message`, so with no `messageAr` that exact
     * sentence — internal feature key and all — rendered on the Arabic
     * add-child screen at the one moment the parent is being asked to pay.
     *
     * The assertions below are the three separate things that were wrong:
     * the shape (no `code` for the app to route on), the language, and the
     * leak of an internal identifier.
     */
    it('refuses with the B3 contract — a code and an Arabic upsell sentence, naming no feature flag', async () => {
      childRepositoryMock.findManyByFamily.mockResolvedValue([{ id: 'child-1' }]);
      entitlementsMock.hasFeature.mockResolvedValue(false);

      const error: ForbiddenException = await service
        .createChild('family-1', { firstName: 'Sara', dateOfBirth: '2017-01-01' })
        .then(
          () => {
            throw new Error('createChild resolved — the entitlement gate did not fire.');
          },
          (e: unknown) => e as ForbiddenException,
        );

      const body = error.getResponse() as { code: string; message: string; messageAr: string };

      expect(error.getStatus()).toBe(403);
      expect(body.code).toBe('PLAN_UPGRADE_REQUIRED');
      expect(body.messageAr).toBe(
        'باقتك الحالية تكفي لطفل واحد. طوّر باقتك لتضيف بقية أطفالك وتتابعهم جميعًا من مكان واحد.',
      );

      // THE LEAK: no internal identifier, in ANY field of the thrown body.
      const whole = JSON.stringify(body);
      expect(whole).not.toContain('multiple_children');
      expect(whole).not.toContain('feature');

      // THE LANGUAGE: what the app actually renders carries no Latin at all.
      expect(body.messageAr).not.toMatch(/[A-Za-z0-9]/);
    });

    it('allows a SECOND child when multiple_children IS entitled', async () => {
      childRepositoryMock.findManyByFamily.mockResolvedValue([{ id: 'child-1' }]);
      entitlementsMock.hasFeature.mockResolvedValue(true);
      childRepositoryMock.create.mockResolvedValue({ id: 'child-2' });

      const result = await service.createChild('family-1', { firstName: 'Sara', dateOfBirth: '2017-01-01' });

      expect(result).toEqual({ id: 'child-2' });
    });
  });

  describe('getChildOrThrow', () => {
    it('returns the child when it belongs to the given family', async () => {
      childRepositoryMock.findOneScopedToFamily.mockResolvedValue({ id: 'child-1' });

      const result = await service.getChildOrThrow('child-1', 'family-1');

      expect(result).toEqual({ id: 'child-1' });
      expect(childRepositoryMock.findOneScopedToFamily).toHaveBeenCalledWith('child-1', 'family-1');
    });

    it('throws ChildNotFoundException when the repository returns null (wrong family or missing)', async () => {
      childRepositoryMock.findOneScopedToFamily.mockResolvedValue(null);

      await expect(service.getChildOrThrow('child-1', 'family-1')).rejects.toBeInstanceOf(
        ChildNotFoundException,
      );
    });
  });

  describe('assertChildBelongsToFamily', () => {
    it('resolves silently for a valid child/family pair', async () => {
      childRepositoryMock.findOneScopedToFamily.mockResolvedValue({ id: 'child-1' });
      await expect(
        service.assertChildBelongsToFamily('child-1', 'family-1'),
      ).resolves.toBeUndefined();
    });

    it('rejects for a child belonging to a different family — this is what PairingService relies on', async () => {
      childRepositoryMock.findOneScopedToFamily.mockResolvedValue(null);
      await expect(
        service.assertChildBelongsToFamily('child-1', 'someone-elses-family'),
      ).rejects.toBeInstanceOf(ChildNotFoundException);
    });
  });

  describe('updateChild / deleteChild', () => {
    it('verifies ownership before updating, not after', async () => {
      childRepositoryMock.findOneScopedToFamily.mockResolvedValue(null);

      await expect(
        service.updateChild('child-1', 'family-1', { firstName: 'New Name' }),
      ).rejects.toBeInstanceOf(ChildNotFoundException);

      expect(childRepositoryMock.update).not.toHaveBeenCalled();
    });

    it('verifies ownership before soft-deleting', async () => {
      childRepositoryMock.findOneScopedToFamily.mockResolvedValue(null);

      await expect(service.deleteChild('child-1', 'family-1')).rejects.toBeInstanceOf(
        ChildNotFoundException,
      );

      expect(childRepositoryMock.softDelete).not.toHaveBeenCalled();
    });

    it('proceeds to soft-delete once ownership is confirmed', async () => {
      childRepositoryMock.findOneScopedToFamily.mockResolvedValue({ id: 'child-1' });

      await service.deleteChild('child-1', 'family-1');

      expect(childRepositoryMock.softDelete).toHaveBeenCalledWith('child-1');
    });
  });
});
