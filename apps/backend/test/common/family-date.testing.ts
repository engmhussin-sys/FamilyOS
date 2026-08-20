import { FamilyDateService } from '../../src/common/time/family-date.service';
import type { PrismaService } from '../../src/common/prisma/prisma.service';

/**
 * B2 test support. NOT a mock of the date logic — the REAL `FamilyDateService`
 * over a one-row fake Prisma, so every unit suite below exercises the real
 * `Intl`-backed calendar and only the database read is stubbed.
 *
 * Mocking `getBusinessDate` here would have made every one of these suites
 * agree with a fiction. The default is `'UTC'`, which is what the schema
 * default is and what these suites implicitly assumed before B2 — so the
 * existing assertions keep testing the behaviour they always tested.
 */
export function testFamilyDateService(timeZone = 'UTC'): FamilyDateService {
  const prisma = {
    family: { findFirst: async () => ({ timezone: timeZone }) },
  } as unknown as PrismaService;
  return new FamilyDateService(prisma);
}

/** Drop-in Nest provider: `providers: [..., familyDateProvider()]`. */
export function familyDateProvider(timeZone = 'UTC'): {
  provide: typeof FamilyDateService;
  useValue: FamilyDateService;
} {
  return { provide: FamilyDateService, useValue: testFamilyDateService(timeZone) };
}
