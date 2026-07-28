import { Test } from '@nestjs/testing';
import { DataExportService } from '../../src/modules/compliance/application/services/data-export.service';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { ScreenTimeService } from '../../src/modules/screen-time/application/services/screen-time.service';
import { ConsentService } from '../../src/modules/compliance/application/services/consent.service';
import { ChildNotFoundException } from '../../src/modules/children/domain/child.errors';

describe('DataExportService', () => {
  const childrenServiceMock = { getChildOrThrow: jest.fn() };
  const screenTimeServiceMock = { getPolicy: jest.fn() };
  const consentServiceMock = { listConsents: jest.fn() };

  let service: DataExportService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        DataExportService,
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: ScreenTimeService, useValue: screenTimeServiceMock },
        { provide: ConsentService, useValue: consentServiceMock },
      ],
    }).compile();
    service = moduleRef.get(DataExportService);
  });

  it('propagates ChildNotFoundException from the ownership check', async () => {
    childrenServiceMock.getChildOrThrow.mockRejectedValue(new ChildNotFoundException('child-1'));

    await expect(service.exportChildData('child-1', 'family-1')).rejects.toBeInstanceOf(
      ChildNotFoundException,
    );
    expect(screenTimeServiceMock.getPolicy).not.toHaveBeenCalled();
    expect(consentServiceMock.listConsents).not.toHaveBeenCalled();
  });

  it('assembles child + policy + consents into one export, with activeScreenTimePolicy null when unset', async () => {
    childrenServiceMock.getChildOrThrow.mockResolvedValue({
      id: 'child-1',
      firstName: 'Yusuf',
      lastName: null,
      dateOfBirth: new Date('2016-01-01'),
      gender: null,
      isActive: true,
      createdAt: new Date('2026-01-01'),
    });
    screenTimeServiceMock.getPolicy.mockResolvedValue(null);
    consentServiceMock.listConsents.mockResolvedValue([
      {
        consentType: 'HEALTH_DATA',
        granted: true,
        grantedAt: new Date('2026-01-02'),
        revokedAt: null,
      },
    ]);

    const result = await service.exportChildData('child-1', 'family-1');

    expect(result.child.firstName).toBe('Yusuf');
    expect(result.activeScreenTimePolicy).toBeNull();
    expect(result.consents).toHaveLength(1);
    expect(result.consents[0].consentType).toBe('HEALTH_DATA');
    expect(result.exportedAt).toBeInstanceOf(Date);
  });

  it('includes the active screen time policy fields when one exists', async () => {
    childrenServiceMock.getChildOrThrow.mockResolvedValue({
      id: 'child-1',
      firstName: 'Sara',
      lastName: null,
      dateOfBirth: new Date('2018-01-01'),
      gender: null,
      isActive: true,
      createdAt: new Date('2026-01-01'),
    });
    screenTimeServiceMock.getPolicy.mockResolvedValue({
      dailyLimitMinutes: 90,
      bedtimeStart: '20:30',
      bedtimeEnd: '07:00',
      focusModeEnabled: true,
    });
    consentServiceMock.listConsents.mockResolvedValue([]);

    const result = await service.exportChildData('child-1', 'family-1');

    expect(result.activeScreenTimePolicy).toEqual({
      dailyLimitMinutes: 90,
      bedtimeStart: '20:30',
      bedtimeEnd: '07:00',
      focusModeEnabled: true,
    });
  });
});
