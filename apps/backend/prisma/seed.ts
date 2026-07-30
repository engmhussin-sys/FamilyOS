/**
 * Seeds `PlanDefinition` rows for all four `SubscriptionPlan` tiers.
 * PRICING IS PLACEHOLDER — flagged explicitly, not a real business
 * decision made on the project manager's behalf. Run via
 * `npx prisma db seed` after configuring `package.json`'s
 * `"prisma": { "seed": "ts-node prisma/seed.ts" }` (or run directly with
 * ts-node) once a real database is available \u2014 not run in this sandbox.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PLANS = [
  {
    tier: 'FREE' as const,
    name: 'Free',
    priceCents: 0,
    currency: 'USD',
    billingIntervalMonths: 1,
    features: ['multiple_children'],
  },
  {
    tier: 'PREMIUM' as const,
    name: 'Premium',
    priceCents: 999, // PLACEHOLDER \u2014 needs real pricing sign-off
    currency: 'USD',
    billingIntervalMonths: 1,
    features: [
      'multiple_children',
      'ai_diagnostics',
      'family_insights',
      'behavioral_trend_analysis',
    ],
  },
  {
    tier: 'FAMILY' as const,
    name: 'Family',
    priceCents: 1999, // PLACEHOLDER
    currency: 'USD',
    billingIntervalMonths: 1,
    features: [
      'multiple_children',
      'ai_diagnostics',
      'family_insights',
      'behavioral_trend_analysis',
      'unlimited_devices_per_child',
      'priority_support',
    ],
  },
  {
    tier: 'ENTERPRISE' as const,
    name: 'Enterprise',
    priceCents: 0, // PLACEHOLDER \u2014 enterprise pricing is typically custom/negotiated, not a flat rate
    currency: 'USD',
    billingIntervalMonths: 1,
    features: [
      'multiple_children',
      'ai_diagnostics',
      'family_insights',
      'behavioral_trend_analysis',
      'unlimited_devices_per_child',
      'priority_support',
    ],
  },
];

async function main() {
  for (const plan of PLANS) {
    await prisma.planDefinition.upsert({
      where: { tier: plan.tier },
      update: plan,
      create: plan,
    });
  }
  console.log(`Seeded ${PLANS.length} plan definitions.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
