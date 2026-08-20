import { Test } from '@nestjs/testing';

import { AppCatalogService } from '../../src/modules/screen-time/application/services/app-catalog.service';
import { APP_CATALOG_REPOSITORY } from '../../src/modules/screen-time/application/ports/screen-time.repository.port';
import { APP_CATALOG_PARENT_RESULT_CAP } from '../../src/modules/screen-time/domain/app-catalog.types';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { ChildNotFoundException } from '../../src/modules/children/domain/child.errors';

/**
 * The two decisions `AppCatalogService` makes that are worth pinning without a
 * database — the clamp and the de-duplication — plus the ownership gate the
 * rest of this module already tests the same way (`screen-time.service.spec.ts`
 * is the template, deliberately: same mock-the-port shape, same assertions
 * about what is NOT called).
 *
 * The isolation, idempotency and response-shape claims are NOT made here.
 * They are properties of the database and the HTTP pipeline, and they are
 * proven against both in `app-catalog.e2e.spec.ts`.
 */
describe('AppCatalogService', () => {
  const repositoryMock = {
    listForChild: jest.fn(),
    upsertDeviceInventory: jest.fn(),
  };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };

  let service: AppCatalogService;

  beforeEach(async () => {
    jest.clearAllMocks();
    repositoryMock.upsertDeviceInventory.mockImplementation(
      async (_deviceId: string, apps: unknown[]) => apps.length,
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppCatalogService,
        { provide: APP_CATALOG_REPOSITORY, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
      ],
    }).compile();
    service = moduleRef.get(AppCatalogService);
  });

  describe('listAppsForChild', () => {
    it("rejects before reading a single row when the child is not in the caller's family", async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockRejectedValue(
        new ChildNotFoundException('child-1'),
      );

      await expect(service.listAppsForChild('child-1', 'family-1')).rejects.toBeInstanceOf(
        ChildNotFoundException,
      );
      expect(repositoryMock.listForChild).not.toHaveBeenCalled();
    });

    it('passes the EXPLICIT cap down — the repository is never asked for "all rows"', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockResolvedValue(undefined);
      repositoryMock.listForChild.mockResolvedValue([]);

      const result = await service.listAppsForChild('child-1', 'family-1');

      expect(repositoryMock.listForChild).toHaveBeenCalledWith('child-1', APP_CATALOG_PARENT_RESULT_CAP);
      expect(result).toEqual({ items: [] });
    });
  });

  describe('reportDeviceInventory', () => {
    const now = new Date('2026-08-19T12:00:00.000Z');

    it('clamps a future lastUsedAt to the server clock — the device clock never wins', async () => {
      const future = new Date(now.getTime() + 4 * 60 * 1000); // inside the DTO's skew window

      await service.reportDeviceInventory(
        'device-1',
        [{ packageName: 'com.example.app', appName: 'Example', lastUsedAt: future }],
        now,
      );

      const [, apps] = repositoryMock.upsertDeviceInventory.mock.calls[0];
      expect(apps[0].lastUsedAt).toEqual(now);
    });

    it('leaves a past lastUsedAt exactly as reported — clamping is not rewriting', async () => {
      const past = new Date(now.getTime() - 60 * 60 * 1000);

      await service.reportDeviceInventory(
        'device-1',
        [{ packageName: 'com.example.app', appName: 'Example', lastUsedAt: past }],
        now,
      );

      const [, apps] = repositoryMock.upsertDeviceInventory.mock.calls[0];
      expect(apps[0].lastUsedAt).toEqual(past);
    });

    it('keeps an absent lastUsedAt absent rather than inventing "now" for an app nobody opened', async () => {
      await service.reportDeviceInventory('device-1', [{ packageName: 'com.example.app', appName: 'Example' }], now);

      const [, apps] = repositoryMock.upsertDeviceInventory.mock.calls[0];
      expect(apps[0].lastUsedAt).toBeUndefined();
    });

    it('collapses a package listed twice in one report, last occurrence winning', async () => {
      const result = await service.reportDeviceInventory(
        'device-1',
        [
          { packageName: 'com.example.app', appName: 'First' },
          { packageName: 'com.example.other', appName: 'Other' },
          { packageName: 'com.example.app', appName: 'Second' },
        ],
        now,
      );

      const [, apps] = repositoryMock.upsertDeviceInventory.mock.calls[0];
      expect(apps).toHaveLength(2);
      expect(apps.find((a: { packageName: string }) => a.packageName === 'com.example.app').appName).toBe('Second');
      // The count answers for ROWS, not for how many lines the device sent.
      expect(result).toEqual({ upserted: 2 });
    });

    it('writes to the deviceId it was given and to no other — there is no other channel', async () => {
      await service.reportDeviceInventory('device-1', [{ packageName: 'com.example.app', appName: 'Example' }], now);

      expect(repositoryMock.upsertDeviceInventory).toHaveBeenCalledTimes(1);
      expect(repositoryMock.upsertDeviceInventory.mock.calls[0][0]).toBe('device-1');
    });
  });
});
