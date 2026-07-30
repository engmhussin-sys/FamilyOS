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
});
