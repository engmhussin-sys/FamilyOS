/**
 * Seeds `PlanDefinition` rows for all four `SubscriptionPlan` tiers.
 * PRICING IS PLACEHOLDER — flagged explicitly, not a real business
 * decision made on the project manager's behalf.
 *
 * HOW TO RUN IT, AS OF PRISMA 7:
 *
 *     DATABASE_URL=... npx tsx prisma/seed.ts
 *
 * The instruction that used to be here — configure `package.json`'s
 * `"prisma": { "seed": "ts-node prisma/seed.ts" }` and run `npx prisma db
 * seed` — no longer works, and is corrected rather than left as a trap for the
 * next person: Prisma 7 STOPPED READING the `prisma` key in `package.json`
 * (configuration moved to `prisma.config.ts`), and `ts-node` was removed from
 * this repository when the toolchain moved to TypeScript 7, which it does not
 * support. `tsx` is what `seed:demo` already uses.
 *
 * CURRENCY: CLOSES A REAL GAP found during a proactive business
 * review — every plan was hardcoded USD despite this project's own
 * documentation repeatedly naming the Gulf/Saudi market as the
 * primary target. Switched to SAR (Saudi Riyal), matching that
 * documented market directly. The price VALUES below are still
 * placeholders, not a precise USD-to-SAR conversion (converting a
 * guessed number is still guessing, just with extra steps) — real
 * SAR pricing needs the same sign-off any pricing does. A real
 * multi-currency system (per-family currency selection, live FX,
 * localized pricing per Gulf country — SAR/AED/etc.) is a genuine
 * future product investment, not attempted here.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

// PRISMA 7: a client cannot be constructed without an adapter — `new PrismaClient()`
// throws "A driver adapter is required". The connection no longer comes from
// `datasource.url` in the schema; it comes from here.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set.');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const PLANS = [
  {
    tier: 'FREE' as const,
    name: 'Free',
    priceCents: 0,
    currency: 'SAR',
    billingIntervalMonths: 1,
    features: ['multiple_children'],
  },
  {
    tier: 'PREMIUM' as const,
    name: 'Premium',
    priceCents: 3999, // PLACEHOLDER — needs real pricing sign-off (SAR)
    currency: 'SAR',
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
    priceCents: 7999, // PLACEHOLDER (SAR)
    currency: 'SAR',
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
    priceCents: 0, // PLACEHOLDER — enterprise pricing is typically custom/negotiated, not a flat rate
    currency: 'SAR',
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
