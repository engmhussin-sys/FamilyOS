/**
 * Database schema integrity tests.
 *
 * These are integration tests, not unit tests: they run against a real
 * (throwaway) Postgres instance via Prisma Client, because referential
 * integrity, cascade behavior, and unique constraints are enforced by the
 * database engine itself and cannot be meaningfully verified with mocks.
 *
 * Prerequisites to run locally / in CI:
 *   1. `docker compose up -d postgres` (see /docker-compose.yml)
 *   2. `DATABASE_URL` pointing at that instance (see .env.example)
 *   3. `npx prisma migrate deploy`
 *   4. `npx jest test/database/schema.spec.ts`
 *
 * Each test cleans up strictly after itself in `afterEach` so tests can run
 * in any order and in parallel-safe isolation within a single test DB.
 */

import { createTestPrisma } from '../tenancy/prisma-test-client';

// F2: built through the shared test factory rather than `new PrismaClient()`.
// Same client, same assertions — but the factory also knows how to open a real
// connection in the environment where the native Prisma engine binary cannot be
// downloaded (binaries.prisma.sh answers 403), so these four tests stop being
// permanently red there. `.raw` is the UN-extended client: this suite is about
// referential integrity, not tenancy, and must not be scoped.
const handle = createTestPrisma();
const prisma = handle.raw;

describe('Database schema integrity', () => {
  afterAll(async () => {
    await handle.disconnect();
  });

  describe('Family → User → Child cascade chain', () => {
    let familyId: string;
    let userId: string;
    let childId: string;

    afterEach(async () => {
      // Deleting the Family cascades to FamilyMember and Child by design
      // (see @relation(..., onDelete: Cascade) in schema.prisma).
      await prisma.family.deleteMany({ where: { id: familyId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    });

    it('creates a full Family → FamilyMember → Child graph', async () => {
      const user = await prisma.user.create({
        data: {
          email: `parent+${Date.now()}@example.com`,
          passwordHash: 'test-hash-not-a-real-password',
          fullName: 'Test Parent',
        },
      });
      userId = user.id;

      const family = await prisma.family.create({
        data: {
          name: 'Test Family',
          members: {
            create: { userId: user.id, role: 'OWNER' },
          },
        },
      });
      familyId = family.id;

      const child = await prisma.child.create({
        data: {
          familyId: family.id,
          firstName: 'Test',
          dateOfBirth: new Date('2015-01-01'),
        },
      });
      childId = child.id;

      const loaded = await prisma.family.findUniqueOrThrow({
        where: { id: family.id },
        include: { members: true, children: true },
      });

      expect(loaded.members).toHaveLength(1);
      expect(loaded.children).toHaveLength(1);
      expect(loaded.children[0].id).toBe(childId);
    });

    it('cascades delete: removing a Family removes its Children', async () => {
      const user = await prisma.user.create({
        data: {
          email: `parent+${Date.now()}@example.com`,
          passwordHash: 'test-hash-not-a-real-password',
          fullName: 'Test Parent',
        },
      });
      userId = user.id;

      const family = await prisma.family.create({
        data: { name: 'Cascade Test Family' },
      });
      familyId = family.id;

      const child = await prisma.child.create({
        data: {
          familyId: family.id,
          firstName: 'Cascade',
          dateOfBirth: new Date('2016-06-01'),
        },
      });
      childId = child.id;

      await prisma.family.delete({ where: { id: family.id } });

      const found = await prisma.child.findUnique({ where: { id: child.id } });
      expect(found).toBeNull();
    });
  });

  describe('ParentalConsent uniqueness', () => {
    it('rejects a duplicate (childId, consentType) pair', async () => {
      const user = await prisma.user.create({
        data: {
          email: `parent+${Date.now()}@example.com`,
          passwordHash: 'test-hash-not-a-real-password',
          fullName: 'Consent Test Parent',
        },
      });
      const family = await prisma.family.create({ data: { name: 'Consent Family' } });
      const child = await prisma.child.create({
        data: {
          familyId: family.id,
          firstName: 'Consent Kid',
          dateOfBirth: new Date('2014-03-01'),
        },
      });

      await prisma.parentalConsent.create({
        data: {
          familyId: family.id,
          childId: child.id,
          consentType: 'LOCATION_TRACKING',
          grantedByUserId: user.id,
        },
      });

      await expect(
        prisma.parentalConsent.create({
          data: {
            familyId: family.id,
            childId: child.id,
            consentType: 'LOCATION_TRACKING',
            grantedByUserId: user.id,
          },
        }),
      ).rejects.toThrow();

      // cleanup
      await prisma.family.delete({ where: { id: family.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });
  });

  describe('AppUsageLog uniqueness (child, device, package, date)', () => {
    it('allows one row per (childId, deviceId, packageName, usageDate)', async () => {
      const family = await prisma.family.create({ data: { name: 'Usage Family' } });
      const child = await prisma.child.create({
        data: {
          familyId: family.id,
          firstName: 'Usage Kid',
          dateOfBirth: new Date('2013-09-01'),
        },
      });
      const device = await prisma.device.create({
        data: {
          familyId: family.id,
          childId: child.id,
          ownerType: 'CHILD',
          platform: 'ANDROID',
        },
      });

      const usageDate = new Date('2026-07-01');

      await prisma.appUsageLog.create({
        data: {
          familyId: family.id,
          childId: child.id,
          deviceId: device.id,
          packageName: 'com.example.game',
          usageDate,
          usageMinutes: 30,
        },
      });

      await expect(
        prisma.appUsageLog.create({
          data: {
            familyId: family.id,
            childId: child.id,
            deviceId: device.id,
            packageName: 'com.example.game',
            usageDate,
            usageMinutes: 15,
          },
        }),
      ).rejects.toThrow();

      await prisma.family.delete({ where: { id: family.id } });
    });
  });
});
