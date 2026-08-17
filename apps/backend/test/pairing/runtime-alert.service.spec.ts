import { Test } from '@nestjs/testing';
import { RuntimeAlertService } from '../../src/modules/pairing/application/services/runtime-alert.service';
import { RUNTIME_ALERT_REPOSITORY } from '../../src/modules/pairing/application/ports/runtime-alert.repository.port';

describe('RuntimeAlertService', () => {
  const runtimeAlertRepositoryMock = { createForFamilyOwner: jest.fn() };
  let service: RuntimeAlertService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        RuntimeAlertService,
        { provide: RUNTIME_ALERT_REPOSITORY, useValue: runtimeAlertRepositoryMock },
      ],
    }).compile();
    service = moduleRef.get(RuntimeAlertService);
  });

  it('creates an alert on a true -> false transition', async () => {
    await service.evaluateTransition({
      familyId: 'family-1',
      childId: 'child-1',
      previousAccessibilityEnabled: true,
      currentAccessibilityEnabled: false,
    });

    expect(runtimeAlertRepositoryMock.createForFamilyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: 'family-1', childId: 'child-1' }),
    );
  });

  it('does NOT alert when it was already false (no spam every heartbeat)', async () => {
    await service.evaluateTransition({
      familyId: 'family-1',
      childId: 'child-1',
      previousAccessibilityEnabled: false,
      currentAccessibilityEnabled: false,
    });

    expect(runtimeAlertRepositoryMock.createForFamilyOwner).not.toHaveBeenCalled();
  });

  it('does NOT alert on recovery (false -> true)', async () => {
    await service.evaluateTransition({
      familyId: 'family-1',
      childId: 'child-1',
      previousAccessibilityEnabled: false,
      currentAccessibilityEnabled: true,
    });

    expect(runtimeAlertRepositoryMock.createForFamilyOwner).not.toHaveBeenCalled();
  });

  it('does NOT alert on the very first report (null -> false) — nothing to transition FROM', async () => {
    await service.evaluateTransition({
      familyId: 'family-1',
      childId: 'child-1',
      previousAccessibilityEnabled: null,
      currentAccessibilityEnabled: false,
    });

    expect(runtimeAlertRepositoryMock.createForFamilyOwner).not.toHaveBeenCalled();
  });

  describe('deviceRevoked', () => {
    it('tells the family owner, with the device and the reason the parent gave', async () => {
      await service.deviceRevoked({
        familyId: 'family-1',
        childId: 'child-1',
        deviceId: 'device-1',
        reason: 'code entered on the wrong phone',
      });

      expect(runtimeAlertRepositoryMock.createForFamilyOwner).toHaveBeenCalledWith(
        expect.objectContaining({
          familyId: 'family-1',
          childId: 'child-1',
          priority: 'HIGH',
          data: {
            alertType: 'DEVICE_REVOKED',
            deviceId: 'device-1',
            reason: 'code entered on the wrong phone',
          },
        }),
      );
    });

    it('is HIGH and not CRITICAL — a parent did this on purpose, so it must not bypass quiet hours', async () => {
      // The accessibility alert above IS CRITICAL because the enforcement
      // surface is off and something may be being defeated. Nothing is being
      // defeated here, and the generic RUNTIME_ALERT type is already classified
      // DEFER/SYSTEM, so this cannot wake a household at 03:00.
      await service.deviceRevoked({ familyId: 'f', childId: 'c', deviceId: 'd' });

      const call = runtimeAlertRepositoryMock.createForFamilyOwner.mock.calls[0][0];
      expect(call.priority).toBe('HIGH');
      expect(call.type).toBeUndefined(); // i.e. the default, RUNTIME_ALERT
      expect(call.data.reason).toBeUndefined();
    });

    it('keys the notification on (child, device) so a duplicate is refused by the unique index', async () => {
      await service.deviceRevoked({ familyId: 'f', childId: 'child-1', deviceId: 'device-1' });

      // `forEntity`, not `forRecurringSignal`: a device can be revoked exactly
      // once, so this key is eternal rather than bucketed — recomputing it a
      // week later still collides.
      expect(runtimeAlertRepositoryMock.createForFamilyOwner.mock.calls[0][0].sourceEventId).toBe(
        'runtime:child-1:device-1:DEVICE_REVOKED',
      );
    });
  });
});
