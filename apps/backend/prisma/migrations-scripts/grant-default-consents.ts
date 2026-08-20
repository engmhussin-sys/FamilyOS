/**
 * Sprint 1 (Consent Enforcement, Option C) — ONE-TIME migration
 * script. CRITICAL, run this ONCE before deploying the enforcement
 * changes in this same sprint: without it, every EXISTING child
 * (every real family already in the database, none of whom have any
 * explicit consent row) would immediately start failing every
 * DigitalWellbeingEngineService.recordDailySummary() call with a 403
 * once the enforcement check goes live — data that was flowing
 * successfully yesterday would silently stop today.
 *
 * Idempotent (uses the same upsert ConsentService.grantDefaults()
 * itself uses) — safe to run more than once by accident.
 *
 * Run with: npx ts-node prisma/migrations-scripts/grant-default-consents.ts
 * NOT run in this sandbox — no real database available here (the
 * same standing environment limitation documented throughout this
 * project since Sprint 13).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const BASELINE_CONSENT_TYPES = ['DATA_COLLECTION', 'LOCATION_TRACKING', 'APP_USAGE_MONITORING', 'AI_BEHAVIOR_ANALYSIS'] as const;

async function main() {
  const children = await prisma.child.findMany({
    select: { id: true, familyId: true },
  });

  console.log(`Found ${children.length} existing child(ren). Granting baseline consents...`);

  let grantedCount = 0;
  for (const child of children) {
    // Attributed to the family OWNER, matching how a real registration-time
    // grant would be attributed — a genuine owner lookup per family
    // (not a placeholder), since grantedByUserId is meant to be a real
    // accountable person, not a system actor.
    const owner = await prisma.familyMember.findFirst({
      where: { familyId: child.familyId, role: 'OWNER', deletedAt: null },
    });
    if (!owner) {
      console.warn(`  Skipping child ${child.id} — no OWNER found for family ${child.familyId}.`);
      continue;
    }

    for (const consentType of BASELINE_CONSENT_TYPES) {
      const existing = await prisma.parentalConsent.findUnique({
        where: { childId_consentType: { childId: child.id, consentType } },
      });
      // Deliberately does NOT touch an existing row — if a parent
      // already explicitly set (or revoked) this consent type for
      // this child, this migration must never overwrite it. Only
      // fills in rows that don't exist yet.
      if (existing) continue;

      await prisma.parentalConsent.create({
        data: {
          // This is a maintenance script running outside any request, so the
          // tenant comes from the row being backfilled — server-derived, never
          // from an operator-supplied argument.
          familyId: child.familyId,
          childId: child.id,
          consentType,
          granted: true,
          grantedByUserId: owner.userId,
          grantedAt: new Date(),
        },
      });
    }
    grantedCount++;
  }

  console.log(`Done. Granted baseline consents for ${grantedCount}/${children.length} child(ren).`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
