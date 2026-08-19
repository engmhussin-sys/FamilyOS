import { Test } from '@nestjs/testing';
import { AiContextManagerService } from '../../src/modules/ai-core/application/services/ai-context-manager.service';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { ScreenTimeService } from '../../src/modules/screen-time/application/services/screen-time.service';
import { ChildNotFoundException } from '../../src/modules/children/domain/child.errors';
import { FamilyDateService } from '../../src/common/time/family-date.service';

describe('AiContextManagerService', () => {
  const childrenServiceMock = { getChildOrThrow: jest.fn() };
  const screenTimeServiceMock = { getPolicy: jest.fn() };

  let service: AiContextManagerService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AiContextManagerService,
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: ScreenTimeService, useValue: screenTimeServiceMock },
        // The child's age is no longer computed from the container clock — it is
        // the family's own calendar age, so the service asks FamilyDateService
        // rather than a free function. Pinned here so the age under test is a
        // fixture, not whatever timezone the runner happens to sit in.
        { provide: FamilyDateService, useValue: { ageInYears: jest.fn().mockResolvedValue(9) } },
      ],
    }).compile();
    service = moduleRef.get(AiContextManagerService);
  });

  it('propagates ChildNotFoundException from the ownership check', async () => {
    childrenServiceMock.getChildOrThrow.mockRejectedValue(new ChildNotFoundException('child-1'));

    await expect(service.buildChildContext('child-1', 'family-1')).rejects.toBeInstanceOf(
      ChildNotFoundException,
    );
    expect(screenTimeServiceMock.getPolicy).not.toHaveBeenCalled();
  });

  it('builds a context with real screen-time policy fields when one exists', async () => {
    childrenServiceMock.getChildOrThrow.mockResolvedValue({
      firstName: 'Yusuf',
      dateOfBirth: new Date('2016-01-01'),
    });
    screenTimeServiceMock.getPolicy.mockResolvedValue({
      dailyLimitMinutes: 90,
      focusModeEnabled: true,
    });

    const context = await service.buildChildContext('child-1', 'family-1');

    expect(context.firstName).toBe('Yusuf');
    expect(context.screenTime).toEqual({ dailyLimitMinutes: 90, focusModeEnabled: true });
  });

  it('defaults screenTime fields sensibly when no policy exists yet', async () => {
    childrenServiceMock.getChildOrThrow.mockResolvedValue({
      firstName: 'Sara',
      dateOfBirth: new Date('2018-01-01'),
    });
    screenTimeServiceMock.getPolicy.mockResolvedValue(null);

    const context = await service.buildChildContext('child-2', 'family-1');

    expect(context.screenTime).toEqual({ dailyLimitMinutes: null, focusModeEnabled: false });
  });
});
