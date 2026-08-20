import { CountryCatalogueService } from '../../src/modules/settings/application/country-catalogue.service';
import { GrowthSettingsService } from '../../src/modules/analytics/application/growth-settings.service';
import type { PrismaService } from '../../src/common/prisma/prisma.service';

/**
 * F1 test support, built the same way `family-date.testing.ts` is and for the
 * same reason: this is the REAL `CountryCatalogueService` over a fake
 * `countries` table and a fake settings reader — NOT a stub of its decisions.
 *
 * That distinction is the whole value. The interesting behaviour of this
 * service is the country/timezone rule and the "inactive is as refused as
 * absent" rule; a hand-written double would let every unit suite below agree
 * with a fiction of those rules instead of exercising them. Only the two I/O
 * calls are faked, and both are faked with the real launch data (EG/SA active,
 * Africa/Cairo and Asia/Riyadh from the real `GROWTH_SETTING_SCHEMAS`
 * defaults).
 *
 * `catalogue` is a mutable array so a test can close a market — that is exactly
 * the `is_active = false` case the suites need to reach.
 */
export function testCountryCatalogue(
  catalogue: Array<{ code: string; isActive: boolean }> = [
    { code: 'EG', isActive: true },
    { code: 'SA', isActive: true },
  ],
): CountryCatalogueService {
  const prisma = {
    country: {
      findUnique: async ({ where }: { where: { code: string } }) =>
        catalogue.find((c) => c.code === where.code) ?? null,
    },
  } as unknown as PrismaService;

  // The real settings service over an EMPTY growth_settings table, so every
  // read resolves to the documented default in `growth-settings.ts` — which is
  // where `reporting.timezone.EG = Africa/Cairo` actually lives.
  const growthSettings = new GrowthSettingsService({
    growthSetting: { findMany: async () => [] },
  } as unknown as PrismaService);

  return new CountryCatalogueService(prisma, growthSettings);
}

/** Drop-in Nest provider: `providers: [..., countryCatalogueProvider()]`. */
export function countryCatalogueProvider(
  catalogue?: Array<{ code: string; isActive: boolean }>,
): { provide: typeof CountryCatalogueService; useValue: CountryCatalogueService } {
  return { provide: CountryCatalogueService, useValue: testCountryCatalogue(catalogue) };
}
