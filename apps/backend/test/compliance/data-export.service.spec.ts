import { Test } from '@nestjs/testing';
import { DataExportService } from '../../src/modules/compliance/application/services/data-export.service';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { ScreenTimeService } from '../../src/modules/screen-time/application/services/screen-time.service';
import { ConsentService } from '../../src/modules/compliance/application/services/consent.service';
import { DigitalWellbeingEngineService } from '../../src/modules/life-intelligence/application/services/digital-wellbeing-engine.service';
import { CHILD_EXPORT_REPOSITORY } from '../../src/modules/compliance/application/ports/child-export.repository.port';
import type { IChildDataExportRecords } from '../../src/modules/compliance/domain/compliance.types';
import { ChildNotFoundException } from '../../src/modules/children/domain/child.errors';

/** An empty-but-shaped records payload: every category present, nothing in it.
 * The export is a CONTRACT, so a child with no history still gets every key —
 * a missing key and an empty one say different things to whoever reads the
 * file. */
const EMPTY_RECORDS: IChildDataExportRecords = {
  messages: { total: 0, returned: 0, truncated: false, limit: 500, items: [] },
  rewards: {
    account: null,
    balancesFromLedger: {},
    ledger: { total: 0, returned: 0, truncated: false, limit: 500, items: [] },
  },
  habits: {
    definitions: [],
    completions: { total: 0, returned: 0, truncated: false, limit: 500, items: [] },
  },
  health: {
    nutrition: { total: 0, returned: 0, truncated: false, limit: 500, items: [] },
    hydration: { total: 0, returned: 0, truncated: false, limit: 500, items: [] },
    sleep: { total: 0, returned: 0, truncated: false, limit: 500, items: [] },
    activity: { total: 0, returned: 0, truncated: false, limit: 500, items: [] },
    measurements: { total: 0, returned: 0, truncated: false, limit: 500, items: [] },
    dailyScores: { total: 0, returned: 0, truncated: false, limit: 500, items: [] },
  },
  learning: {
    goals: [],
    sessions: { total: 0, returned: 0, truncated: false, limit: 500, items: [] },
    assessments: { total: 0, returned: 0, truncated: false, limit: 500, items: [] },
  },
  location: null,
};

describe('DataExportService', () => {
  const childrenServiceMock = { getChildOrThrow: jest.fn() };
  const screenTimeServiceMock = { getPolicy: jest.fn() };
  const consentServiceMock = { listConsents: jest.fn() };
  const digitalWellbeingMock = { getBehavioralSnapshotSummary: jest.fn() };
  const childExportRepositoryMock = { loadRecords: jest.fn() };

  let service: DataExportService;

  beforeEach(async () => {
    jest.clearAllMocks();
    childExportRepositoryMock.loadRecords.mockResolvedValue(EMPTY_RECORDS);
    const moduleRef = await Test.createTestingModule({
      providers: [
        DataExportService,
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: ScreenTimeService, useValue: screenTimeServiceMock },
        { provide: ConsentService, useValue: consentServiceMock },
        { provide: DigitalWellbeingEngineService, useValue: digitalWellbeingMock },
        { provide: CHILD_EXPORT_REPOSITORY, useValue: childExportRepositoryMock },
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
    expect(digitalWellbeingMock.getBehavioralSnapshotSummary).not.toHaveBeenCalled();
    // The ownership check still gates EVERYTHING, including the new
    // repository — a child that is not this family's is never queried for.
    expect(childExportRepositoryMock.loadRecords).not.toHaveBeenCalled();
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
    digitalWellbeingMock.getBehavioralSnapshotSummary.mockResolvedValue(null);

    const result = await service.exportChildData('child-1', 'family-1');

    expect(result.child.firstName).toBe('Yusuf');
    expect(result.activeScreenTimePolicy).toBeNull();
    expect(result.consents).toHaveLength(1);
    expect(result.consents[0].consentType).toBe('HEALTH_DATA');
    expect(result.exportedAt).toBeInstanceOf(Date);
    expect(result.digitalWellbeing).toBeNull();
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
    digitalWellbeingMock.getBehavioralSnapshotSummary.mockResolvedValue(null);

    const result = await service.exportChildData('child-1', 'family-1');

    expect(result.activeScreenTimePolicy).toEqual({
      dailyLimitMinutes: 90,
      bedtimeStart: '20:30',
      bedtimeEnd: '07:00',
      focusModeEnabled: true,
    });
  });

  it('CLOSES A REAL GAP (proactive compliance review): includes Digital Wellbeing data in the export when it exists', async () => {
    childrenServiceMock.getChildOrThrow.mockResolvedValue({
      id: 'child-1',
      firstName: 'Layla',
      lastName: null,
      dateOfBirth: new Date('2015-01-01'),
      gender: null,
      isActive: true,
      createdAt: new Date('2026-01-01'),
    });
    screenTimeServiceMock.getPolicy.mockResolvedValue(null);
    consentServiceMock.listConsents.mockResolvedValue([]);
    digitalWellbeingMock.getBehavioralSnapshotSummary.mockResolvedValue({
      windowDays: 30,
      averageDailyScreenMinutes: 120,
      averagePickups: 25,
      averageNightUsageMinutes: 5,
      totalBlockedAttempts: 2,
      daysWithData: 10,
    });

    const result = await service.exportChildData('child-1', 'family-1');

    expect(digitalWellbeingMock.getBehavioralSnapshotSummary).toHaveBeenCalledWith('child-1', 'family-1');
    expect(result.digitalWellbeing).toEqual({
      windowDays: 30,
      averageDailyScreenMinutes: 120,
      averagePickups: 25,
      averageNightUsageMinutes: 5,
      totalBlockedAttempts: 2,
      daysWithData: 10,
    });
  });
});

describe('DataExportService — the categories a subject-access export was missing', () => {
  const childrenServiceMock = { getChildOrThrow: jest.fn() };
  const screenTimeServiceMock = { getPolicy: jest.fn() };
  const consentServiceMock = { listConsents: jest.fn() };
  const digitalWellbeingMock = { getBehavioralSnapshotSummary: jest.fn() };
  const childExportRepositoryMock = { loadRecords: jest.fn() };

  let service: DataExportService;

  beforeEach(async () => {
    jest.clearAllMocks();
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
    consentServiceMock.listConsents.mockResolvedValue([]);
    digitalWellbeingMock.getBehavioralSnapshotSummary.mockResolvedValue(null);
    childExportRepositoryMock.loadRecords.mockResolvedValue(EMPTY_RECORDS);

    const moduleRef = await Test.createTestingModule({
      providers: [
        DataExportService,
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: ScreenTimeService, useValue: screenTimeServiceMock },
        { provide: ConsentService, useValue: consentServiceMock },
        { provide: DigitalWellbeingEngineService, useValue: digitalWellbeingMock },
        { provide: CHILD_EXPORT_REPOSITORY, useValue: childExportRepositoryMock },
      ],
    }).compile();
    service = moduleRef.get(DataExportService);
  });

  it('carries every category, present and empty, for a child with no history — a missing key and an empty one are different claims', async () => {
    const result = await service.exportChildData('child-1', 'family-1');

    expect(childExportRepositoryMock.loadRecords).toHaveBeenCalledWith('child-1');
    expect(Object.keys(result.records).sort()).toEqual([
      'habits',
      'health',
      'learning',
      'location',
      'messages',
      'rewards',
    ]);
    expect(Object.keys(result.records.health).sort()).toEqual([
      'activity',
      'dailyScores',
      'hydration',
      'measurements',
      'nutrition',
      'sleep',
    ]);
    // No location history held at all -> null, NOT a summary of zeroes.
    expect(result.records.location).toBeNull();
  });

  it('passes the bounded sets through untouched, truncation flag and true total included', async () => {
    childExportRepositoryMock.loadRecords.mockResolvedValue({
      ...EMPTY_RECORDS,
      messages: {
        total: 4210,
        returned: 500,
        truncated: true,
        limit: 500,
        items: [
          {
            createdAt: new Date('2026-05-01'),
            authorType: 'PARENT',
            approvalStatus: 'NOT_REQUIRED',
            category: 'ENCOURAGEMENT',
            title: 'أحسنت',
            body: 'أحسنت يا يوسف',
            deliveredAt: new Date('2026-05-01'),
            acknowledgedAt: null,
          },
        ],
      },
    });

    const result = await service.exportChildData('child-1', 'family-1');

    expect(result.records.messages.total).toBe(4210);
    expect(result.records.messages.truncated).toBe(true);
    expect(result.records.messages.limit).toBe(500);
    // The message is the child's data and is exported. The PARENT who wrote it
    // is a third party, so `authorType` is present and no user id is.
    expect(result.records.messages.items[0].authorType).toBe('PARENT');
    expect(result.records.messages.items[0]).not.toHaveProperty('fromUserId');
  });

  it('reports a location SUMMARY and never a coordinate', async () => {
    childExportRepositoryMock.loadRecords.mockResolvedValue({
      ...EMPTY_RECORDS,
      location: {
        totalEvents: 182_400,
        eventCounts: { ENTER_ZONE: 900, EXIT_ZONE: 890, PERIODIC: 180_610 },
        firstRecordedAt: new Date('2025-01-01'),
        lastRecordedAt: new Date('2026-08-01'),
        safeZoneNames: ['المدرسة', 'البيت'],
        earliestExpiresAt: new Date('2026-09-01'),
      },
    });

    const result = await service.exportChildData('child-1', 'family-1');

    expect(result.records.location?.totalEvents).toBe(182_400);
    expect(result.records.location?.safeZoneNames).toEqual(['المدرسة', 'البيت']);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('latitude');
    expect(serialised).not.toContain('longitude');
  });
});
