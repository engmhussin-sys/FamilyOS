#!/usr/bin/env ts-node
/**
 * ============================================================================
 * `npm run seed:demo` — A DEMO DATABASE THE OWNER CAN ACTUALLY LOOK AT.
 * ============================================================================
 *
 * THE PROBLEM THIS SOLVES. On a freshly migrated database the admin dashboard
 * is entirely «لا توجد بيانات بعد». That is correct and honest — nothing has
 * registered, converted or paid — but it means nobody can tell whether the
 * panels work, and nobody can be shown the product. This script fills a LOCAL
 * database with a realistic, clearly-labelled synthetic dataset so every panel
 * renders a real number computed by the real code.
 *
 * ── FOUR RULES THIS FILE OBEYS WITHOUT EXCEPTION ────────────────────────────
 *
 * 1. IT IS IMPOSSIBLE TO MISTAKE THIS DATA FOR REAL DATA. Every machine-
 *    readable identifier carries the `demo` marker: emails end in
 *    `@demo-seed.invalid` (`.invalid` is reserved by RFC 2606 and can never be
 *    a real domain), family names begin `DEMO-EG-01 ·`, children carry the
 *    surname `DEMO`, devices carry the fingerprint `demo-seed:…`, campaigns are
 *    named `DEMO — …`. The Arabic given names are real Arabic names because a
 *    demo of an Arabic-first product with `Test User 1` in it demonstrates
 *    nothing — but no row is findable without also finding the word `demo`.
 *
 * 2. IT REFUSES TO RUN AGAINST ANYTHING THAT IS NOT OBVIOUSLY LOCAL.
 *    `DATABASE_URL` must point at `localhost` / `127.0.0.1` / `::1` / a UNIX
 *    socket / a `docker-compose` service name, or the script exits BEFORE it
 *    opens a connection. `--force-non-local` exists for the one person who
 *    genuinely needs it and it must be typed out in full. Seeding a production
 *    database by accident is the single unrecoverable mistake available here,
 *    so the default is refusal.
 *
 * 3. IT IS RE-RUNNABLE. Running it twice does NOT produce a second copy and
 *    does NOT crash. There is deliberately NO delete phase: four tables in this
 *    schema are append-only by DATABASE PRIVILEGE (`rewards_ledger_entries`,
 *    `verification_attempts`, `audit_logs`, `device_pairing_events` — `abny_app`
 *    holds no UPDATE or DELETE on them) and two more are protected by
 *    no-delete TRIGGERS (`payment_transactions`, `invoices`). A cleanup phase
 *    would therefore either fail or need privileges a seed must not assume. So
 *    every step instead LOOKS THE DEMO ROW UP BY ITS DEMO IDENTIFIER and either
 *    reuses it or upserts it. Nothing outside the demo namespace is ever read
 *    for writing, and no `TRUNCATE` appears anywhere in this file.
 *
 * 4. IT USES THE REAL SERVICES. Households are created by `AuthService.register`
 *    (so attribution, the pilot gate and the audit record happen the way they
 *    happen in production), children by `ChildrenService`, programs by
 *    `RewardProgramService` (so the taxonomy, the verification matrix and the
 *    companion `RewardRule` materialisation all run), attempts by
 *    `AchievementService`, and then the OUTBOX RELAY IS TICKED — so the reward
 *    ledger entries, the timeline rows, the activation facts and the
 *    notification decisions are produced by the same consumers a real
 *    completion wakes. A reward that appears in the ledger got there the way a
 *    real one does. Finally `GrowthAggregationService` closes one reporting day
 *    at a time across the whole history window, exactly as the scheduled job
 *    does, so `growth_daily_metrics` is computed rather than invented.
 *
 *    WHERE A SERVICE IS NOT USED, IT IS BECAUSE ONE DOES NOT EXIST FOR THE
 *    JOB and the reason is stated at the call site: the commercial rows
 *    (`subscriptions`, `payment_transactions`, `entitlements`, `invoices`,
 *    `trials`) are written with Prisma because the only production path into
 *    them is a signed provider webhook, and forging one would be inventing a
 *    Paymob payload rather than exercising a domain rule. Those writes honour
 *    every invariant the schema states: money is INTEGER MINOR UNITS, VAT is
 *    computed from `countries.vat_basis_points` in basis points, a currency is
 *    never mixed with another, and no row is left orphaned or NULL where the
 *    product means something else.
 *
 * ── MONEY ───────────────────────────────────────────────────────────────────
 * EGP for Egypt, SAR for Saudi Arabia, always in minor units, never summed
 * together and never a float. The PRICE LIST this script seeds is a
 * PLACEHOLDER — see `DEMO_PRICE_LIST` — and it is flagged as such in the
 * script's own output, because real pricing is a business decision and not a
 * seed script's to make.
 *
 * ── TENANCY ─────────────────────────────────────────────────────────────────
 * The tenant guard is real and this script crosses households deliberately, so
 * every write runs under the sanctioned escape: `runWithTenant` when acting AS
 * a household, and `runAsSystemAsync('TEST_FIXTURE', …)` — the reason whose
 * documented purpose is «test harnesses and seed scripts only» — for the
 * cross-tenant bookkeeping. `npm run ci:tenant-guard` scans `src/` and is
 * unaffected by this file; the discipline is kept anyway because the extension
 * enforces it at runtime.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { createTenantExtension } from '../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../src/common/tenancy/system-context';
import { runWithTenant } from '../src/common/tenancy/tenant-context';
import { AuthService } from '../src/modules/auth/application/services/auth.service';
import { ChildrenService } from '../src/modules/children/application/services/children.service';
import { RewardProgramService } from '../src/modules/rewards-engine/application/services/reward-program.service';
import { AchievementService } from '../src/modules/rewards-engine/application/services/achievement.service';
import { OutboxRelay } from '../src/modules/events/application/outbox.relay';
import { RewardsEngineService } from '../src/modules/life-intelligence/application/services/rewards-engine.service';
import { QuietHoursReleaseService } from '../src/modules/life-intelligence/application/services/quiet-hours-release.service';
import { CampaignService } from '../src/modules/analytics/application/campaign.service';
import { ForecastService } from '../src/modules/analytics/application/forecast.service';
import { GrowthAggregationService } from '../src/modules/analytics/application/growth-aggregation.service';
import { GrowthAlertsService } from '../src/modules/analytics/application/growth-alerts.service';
import { PilotEnrollmentService } from '../src/modules/analytics/application/pilot-enrollment.service';
import { ReferralService } from '../src/modules/analytics/application/referral.service';
import { ReferralRewardService } from '../src/modules/analytics/application/referral-reward.service';

// ---------------------------------------------------------------------------
// 0. THE DEMO NAMESPACE. Everything this script writes is findable by these.
// ---------------------------------------------------------------------------

/** The one string that marks a row as synthetic. Grep for it to find everything. */
const DEMO = 'demo';
/** RFC 2606 reserves `.invalid`; no mail can ever be delivered to these. */
const EMAIL_DOMAIN = 'demo-seed.invalid';
/** Every demo password is the same and is useless — these accounts are local. */
const DEMO_PASSWORD = 'DemoSeed!2026';
const DEMO_PILOT_COHORT = 'demo-pilot-2026';
const DAY_MS = 24 * 60 * 60 * 1000;

/** How many reporting days of history the demo covers. */
const HISTORY_DAYS = 98;

const demoEmail = (slug: string, kind: string): string => `${DEMO}.${slug}.${kind}@${EMAIL_DOMAIN}`;

// ---------------------------------------------------------------------------
// 1. THE REFUSAL. Runs before a connection is opened, and before Nest boots.
// ---------------------------------------------------------------------------

/**
 * A `DATABASE_URL` is accepted only when its host is unambiguously a local
 * development database. Anything else — a managed host, an IP that is not
 * loopback, a hostname with a dot in it — is refused, and the refusal names
 * what it saw so the mistake is obvious rather than mysterious.
 *
 * `docker-compose` service names (`postgres`, `db`, `postgres-1`, …) are
 * allowed because `apps/admin-dashboard/RUN.md` step 1 tells the owner to run
 * PostgreSQL exactly that way; they contain no dot and resolve only inside a
 * compose network.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '']);

function assertLocalDatabase(force: boolean): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    fail(
      'DATABASE_URL is not set.',
      'Run this from `apps/backend` with a `.env` in place — see apps/admin-dashboard/RUN.md step 2.',
    );
  }

  let host: string;
  let database: string;
  try {
    const parsed = new URL(url as string);
    host = decodeURIComponent(parsed.hostname);
    database = parsed.pathname.replace(/^\//, '') || '(none)';
  } catch {
    fail(`DATABASE_URL is not a URL this script can read: ${redact(url as string)}`, 'Refusing.');
    throw new Error('unreachable');
  }

  const isLoopback = LOCAL_HOSTS.has(host);
  // A compose service name: no dots, not an IP literal.
  const isComposeService = !host.includes('.') && !host.includes(':') && !/^\d+$/.test(host);
  const local = isLoopback || isComposeService;

  if (local) return `${host}/${database}`;

  if (force) {
    console.warn(
      [
        '',
        '  ⚠  --force-non-local WAS PASSED.',
        `     Host        : ${host}`,
        `     Database    : ${database}`,
        '     This script is about to write ~5,000 synthetic rows into a database that is',
        '     NOT local. If that database has real households in it, they now share it with',
        '     demo households forever. There is no undo.',
        '',
      ].join('\n'),
    );
    return `${host}/${database}`;
  }

  fail(
    `REFUSING: DATABASE_URL points at "${host}", which is not a local development database.`,
    [
      'This seed writes fabricated households, subscriptions and payments. Running it against',
      'a shared or production database is not recoverable.',
      '',
      'If the host really is a throwaway database you own, re-run with:',
      '    npm run seed:demo -- --force-non-local',
    ].join('\n'),
  );
  throw new Error('unreachable');
}

function redact(url: string): string {
  return url.replace(/:\/\/[^@]*@/, '://***@');
}

function fail(headline: string, detail: string): never {
  console.error(`\n  ✗ ${headline}\n\n${detail.replace(/^/gm, '    ')}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. THE PRISMA CLIENT. Same two modes the repository's own test harness uses.
// ---------------------------------------------------------------------------

/**
 * `PrismaService`'s constructor calls `new PrismaClient()` with no arguments,
 * which is right for the application and cannot express the driver-adapter mode
 * this repository needs where the native query engine cannot be downloaded
 * (`scripts/regen-prisma-client-offline.sh` documents that in full). So the
 * client is built here — with the SAME tenant extension the real service
 * applies, so every write below is guarded exactly as production is — and
 * substituted for `PrismaService` in the DI container.
 *
 * On a normal developer machine (`PRISMA_DRIVER_ADAPTER` unset) this is a plain
 * `new PrismaClient()` on the native engine and behaves identically.
 */
function buildPrismaSubstitute(): { service: any; close: () => Promise<void> } {
  const url = process.env.DATABASE_URL as string;

  if (process.env.PRISMA_DRIVER_ADAPTER === 'pg') {
    const { PrismaClient } = require('@prisma/client');
    const { PrismaPg } = require('@prisma/adapter-pg');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url });
    const raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    const service = raw.$extends(createTenantExtension());
    service.onModuleInit = async (): Promise<void> => undefined;
    service.onModuleDestroy = async (): Promise<void> => undefined;
    return {
      service,
      close: async () => {
        await raw.$disconnect();
        await pool.end();
      },
    };
  }

  const { PrismaClient } = require('@prisma/client');
  const raw = new PrismaClient({
    // PRISMA 7: `datasources` was removed; the adapter is the connection.
    adapter: new (require('@prisma/adapter-pg').PrismaPg)(
      new (require('pg').Pool)({ connectionString: url }),
    ),
  });
  const service = raw.$extends(createTenantExtension());
  service.onModuleInit = async (): Promise<void> => {
    await raw.$connect();
  };
  service.onModuleDestroy = async (): Promise<void> => undefined;
  return { service, close: () => raw.$disconnect() };
}

/**
 * Cross-tenant bookkeeping the seed does on its own behalf.
 *
 * THE `await` INSIDE IS THE ENTIRE POINT, and it is the same trap
 * `analytics/application/system-scope.ts` exists to close: a `PrismaPromise` is
 * LAZY — it executes when `.then` is attached, not when it is constructed — so
 * `runAsSystemAsync(r, j, () => db.x.create(...))` BUILDS the query inside the
 * AsyncLocalStorage scope and EXECUTES it outside, where the extension finds no
 * context and denies by default. Do not "simplify" this to a bare pass-through.
 */
// `Promise<any>` rather than a generic: the Prisma client here is deliberately
// untyped (`db: any`, because it is built at runtime in one of two modes), and a
// generic would infer `unknown` from it and force a cast at all 60 call sites.
function sys(what: string, fn: () => any): Promise<any> {
  return runAsSystemAsync('TEST_FIXTURE', `Demo seed: ${what}.`, async () => await fn());
}

/** The tenant-scoped counterpart, with the same `await`-inside discipline. */
function asFamily(fam: { familyId: string; ownerUserId: string }, fn: () => any): Promise<any> {
  return runWithTenant(
    { familyId: fam.familyId, actorType: 'USER', actorId: fam.ownerUserId },
    async () => await fn(),
  );
}

// ---------------------------------------------------------------------------
// 3. THE DATASET. Deterministic, so two runs describe the same households.
// ---------------------------------------------------------------------------

type Market = 'EG' | 'SA' | null;
type SubStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'GRACE_PERIOD' | 'CANCELED' | 'EXPIRED';
type Tier = 'BASIC' | 'PREMIUM' | 'FAMILY';
type Period = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';

interface ChildSpec {
  readonly given: string;
  /** Chosen to land in one of the four copy bands: 6-8 / 9-11 / 12-14 / 15-17. */
  readonly age: number;
  readonly gender: 'male' | 'female';
}

interface FamilySpec {
  readonly slug: string;
  readonly market: Market;
  readonly surname: string;
  readonly parents: readonly string[];
  readonly children: readonly ChildSpec[];
  readonly registeredDaysAgo: number;
  readonly channel: string;
  readonly campaign: string | null;
  readonly platform: 'ANDROID' | 'IOS';
  /** Days since the newest device heartbeat. `null` = never seen (unpaired). */
  readonly lastSeenDaysAgo: number | null;
  readonly subscription: { status: SubStatus; tier: Tier; period: Period } | null;
  /** A household that started a trial, whether or not it converted. */
  readonly trial: 'CONVERTED' | 'LAPSED' | 'RUNNING' | null;
  /** Whether this household was let in through a pilot invitation. */
  readonly pilot: boolean;
  /** Quiet hours: `NARROW` so a demo run at any hour still delivers. */
  readonly quietHours: 'NARROW' | 'DEFAULT';
}

/**
 * Thirty households: fifteen Egyptian, twelve Saudi, and three with NO country
 * at all.
 *
 * THE REGISTRATION DATES ARE NOT DECORATION. Retention is a COHORT measure —
 * `RETENTION_D7` counts households registered exactly seven reporting days ago
 * that were seen again today — so a dataset whose registrations are scattered
 * at random produces empty cohorts and a retention grid full of «—». Each
 * market therefore has a PAIR of households at exactly 1, 7, 30 and 90 days
 * ago: one whose device was seen today and one whose was not, which is what
 * makes D1/D7/D30/D90 land on a real, non-trivial fraction rather than on
 * nothing or on a suspicious 100%.
 *
 * THE THREE COUNTRY-LESS HOUSEHOLDS ARE THE POINT OF THEIR OWN ROW. The
 * dashboard treats a household the server has no market for as UNATTRIBUTABLE:
 * excluded from «مصر» and from «السعودية», included in the platform total, so
 * `platform − (EG + SA)` is the unattributable population. That behaviour is
 * worth SEEING, and it cannot be seen on a dataset where every family has a
 * country. They are given attribution with no `countryCode` and no
 * subscription, which is what makes them genuinely unattributable rather than
 * merely unlabelled.
 */
const FAMILIES: readonly FamilySpec[] = [
  // ---- EGYPT (EGP) --------------------------------------------------------
  {
    slug: 'eg-01', market: 'EG', surname: 'النجار',
    parents: ['أحمد', 'فاطمة'],
    children: [{ given: 'يوسف', age: 13, gender: 'male' }, { given: 'مريم', age: 9, gender: 'female' }],
    registeredDaysAgo: 90, channel: 'TIKTOK', campaign: 'eg-launch', platform: 'ANDROID',
    lastSeenDaysAgo: 0, subscription: { status: 'ACTIVE', tier: 'PREMIUM', period: 'MONTHLY' },
    trial: 'CONVERTED', pilot: true, quietHours: 'NARROW',
  },
  {
    slug: 'eg-02', market: 'EG', surname: 'الشريف',
    parents: ['محمد'],
    children: [{ given: 'عبدالرحمن', age: 7, gender: 'male' }],
    registeredDaysAgo: 90, channel: 'FACEBOOK', campaign: 'eg-launch', platform: 'ANDROID',
    lastSeenDaysAgo: 12, subscription: { status: 'ACTIVE', tier: 'FAMILY', period: 'ANNUAL' },
    trial: 'CONVERTED', pilot: true, quietHours: 'NARROW',
  },
  {
    slug: 'eg-03', market: 'EG', surname: 'المغربي',
    parents: ['خالد', 'هدى'],
    children: [
      { given: 'لينا', age: 16, gender: 'female' },
      { given: 'زياد', age: 11, gender: 'male' },
      { given: 'جنى', age: 6, gender: 'female' },
    ],
    registeredDaysAgo: 78, channel: 'INSTAGRAM', campaign: 'eg-launch', platform: 'IOS',
    lastSeenDaysAgo: 0, subscription: { status: 'ACTIVE', tier: 'PREMIUM', period: 'QUARTERLY' },
    trial: 'CONVERTED', pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'eg-04', market: 'EG', surname: 'الحسيني',
    parents: ['عمر'],
    children: [{ given: 'آدم', age: 10, gender: 'male' }],
    registeredDaysAgo: 66, channel: 'ORGANIC', campaign: null, platform: 'ANDROID',
    lastSeenDaysAgo: 2, subscription: { status: 'PAST_DUE', tier: 'BASIC', period: 'MONTHLY' },
    trial: 'CONVERTED', pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'eg-05', market: 'EG', surname: 'بدران',
    parents: ['سعيد', 'سارة'],
    children: [{ given: 'سلمى', age: 14, gender: 'female' }, { given: 'حمزة', age: 8, gender: 'male' }],
    registeredDaysAgo: 52, channel: 'TIKTOK', campaign: 'eg-ramadan', platform: 'ANDROID',
    lastSeenDaysAgo: 0, subscription: { status: 'GRACE_PERIOD', tier: 'PREMIUM', period: 'MONTHLY' },
    trial: 'CONVERTED', pilot: false, quietHours: 'DEFAULT',
  },
  {
    slug: 'eg-06', market: 'EG', surname: 'السقا',
    parents: ['طارق'],
    children: [{ given: 'ريتال', age: 12, gender: 'female' }],
    registeredDaysAgo: 44, channel: 'REFERRAL', campaign: null, platform: 'ANDROID',
    lastSeenDaysAgo: 5, subscription: { status: 'CANCELED', tier: 'PREMIUM', period: 'MONTHLY' },
    trial: 'CONVERTED', pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'eg-07', market: 'EG', surname: 'الفقي',
    parents: ['ماجد', 'ليلى'],
    children: [{ given: 'كريم', age: 15, gender: 'male' }, { given: 'ملك', age: 9, gender: 'female' }],
    registeredDaysAgo: 35, channel: 'INFLUENCER', campaign: 'eg-ramadan', platform: 'IOS',
    lastSeenDaysAgo: 6, subscription: { status: 'EXPIRED', tier: 'BASIC', period: 'MONTHLY' },
    trial: 'LAPSED', pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'eg-08', market: 'EG', surname: 'زهران',
    parents: ['هشام'],
    children: [{ given: 'تميم', age: 6, gender: 'male' }],
    registeredDaysAgo: 30, channel: 'ORGANIC', campaign: null, platform: 'ANDROID',
    lastSeenDaysAgo: 0, subscription: { status: 'ACTIVE', tier: 'PREMIUM', period: 'MONTHLY' },
    trial: 'CONVERTED', pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'eg-09', market: 'EG', surname: 'العطار',
    parents: ['وليد', 'أمل'],
    children: [{ given: 'هند', age: 17, gender: 'female' }, { given: 'عمر', age: 11, gender: 'male' }],
    registeredDaysAgo: 30, channel: 'GOOGLE', campaign: 'eg-ramadan', platform: 'ANDROID',
    lastSeenDaysAgo: 9, subscription: null, trial: 'LAPSED', pilot: false, quietHours: 'DEFAULT',
  },
  {
    slug: 'eg-10', market: 'EG', surname: 'مرسي',
    parents: ['فهد'],
    children: [{ given: 'رقية', age: 8, gender: 'female' }],
    registeredDaysAgo: 21, channel: 'PARENT_COMMUNITY', campaign: null, platform: 'ANDROID',
    lastSeenDaysAgo: 3, subscription: { status: 'ACTIVE', tier: 'FAMILY', period: 'MONTHLY' },
    trial: 'CONVERTED', pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'eg-11', market: 'EG', surname: 'شلبي',
    parents: ['بندر', 'رانيا'],
    children: [{ given: 'جودي', age: 10, gender: 'female' }, { given: 'ياسين', age: 13, gender: 'male' }],
    registeredDaysAgo: 14, channel: 'APP_STORE', campaign: null, platform: 'IOS',
    lastSeenDaysAgo: 1, subscription: null, trial: null, pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'eg-12', market: 'EG', surname: 'عبدالرحمن',
    parents: ['إبراهيم'],
    children: [{ given: 'نور', age: 12, gender: 'female' }],
    registeredDaysAgo: 7, channel: 'REFERRAL', campaign: null, platform: 'ANDROID',
    lastSeenDaysAgo: 0, subscription: { status: 'TRIALING', tier: 'PREMIUM', period: 'MONTHLY' },
    trial: 'RUNNING', pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'eg-13', market: 'EG', surname: 'الجندي',
    parents: ['مصطفى'],
    children: [{ given: 'سيف', age: 9, gender: 'male' }],
    registeredDaysAgo: 7, channel: 'SCHOOL', campaign: null, platform: 'ANDROID',
    lastSeenDaysAgo: 4, subscription: null, trial: null, pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'eg-14', market: 'EG', surname: 'رشدي',
    parents: ['أيمن', 'دينا'],
    children: [{ given: 'ليان', age: 15, gender: 'female' }, { given: 'مالك', age: 7, gender: 'male' }],
    registeredDaysAgo: 1, channel: 'TIKTOK', campaign: 'eg-ramadan', platform: 'ANDROID',
    lastSeenDaysAgo: 0, subscription: { status: 'TRIALING', tier: 'BASIC', period: 'MONTHLY' },
    trial: 'RUNNING', pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'eg-15', market: 'EG', surname: 'قنديل',
    parents: ['شريف'],
    children: [{ given: 'حور', age: 6, gender: 'female' }],
    registeredDaysAgo: 1, channel: 'ORGANIC', campaign: null, platform: 'IOS',
    lastSeenDaysAgo: 1, subscription: null, trial: null, pilot: false, quietHours: 'NARROW',
  },

  // ---- SAUDI ARABIA (SAR) -------------------------------------------------
  {
    slug: 'sa-01', market: 'SA', surname: 'القحطاني',
    parents: ['عبدالله', 'نورة'],
    children: [{ given: 'سلطان', age: 14, gender: 'male' }, { given: 'ريما', age: 7, gender: 'female' }],
    registeredDaysAgo: 90, channel: 'TIKTOK', campaign: 'sa-launch', platform: 'IOS',
    lastSeenDaysAgo: 0, subscription: { status: 'ACTIVE', tier: 'FAMILY', period: 'ANNUAL' },
    trial: 'CONVERTED', pilot: true, quietHours: 'NARROW',
  },
  {
    slug: 'sa-02', market: 'SA', surname: 'الغامدي',
    parents: ['فيصل'],
    children: [{ given: 'لمى', age: 9, gender: 'female' }],
    registeredDaysAgo: 90, channel: 'INSTAGRAM', campaign: 'sa-launch', platform: 'IOS',
    lastSeenDaysAgo: 15, subscription: { status: 'ACTIVE', tier: 'PREMIUM', period: 'MONTHLY' },
    trial: 'CONVERTED', pilot: true, quietHours: 'NARROW',
  },
  {
    slug: 'sa-03', market: 'SA', surname: 'الشهري',
    parents: ['سلمان', 'الجوهرة'],
    children: [
      { given: 'تركي', age: 16, gender: 'male' },
      { given: 'دانة', age: 11, gender: 'female' },
    ],
    registeredDaysAgo: 70, channel: 'YOUTUBE', campaign: 'sa-launch', platform: 'ANDROID',
    lastSeenDaysAgo: 0, subscription: { status: 'PAST_DUE', tier: 'PREMIUM', period: 'MONTHLY' },
    trial: 'CONVERTED', pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'sa-04', market: 'SA', surname: 'العتيبي',
    parents: ['ناصر'],
    children: [{ given: 'ريان', age: 6, gender: 'male' }],
    registeredDaysAgo: 55, channel: 'REFERRAL', campaign: null, platform: 'IOS',
    lastSeenDaysAgo: 2, subscription: { status: 'GRACE_PERIOD', tier: 'FAMILY', period: 'QUARTERLY' },
    trial: 'CONVERTED', pilot: false, quietHours: 'DEFAULT',
  },
  {
    slug: 'sa-05', market: 'SA', surname: 'الدوسري',
    parents: ['مشعل', 'العنود'],
    children: [{ given: 'جواهر', age: 12, gender: 'female' }, { given: 'بدر', age: 8, gender: 'male' }],
    registeredDaysAgo: 40, channel: 'INFLUENCER', campaign: 'sa-back-to-school', platform: 'IOS',
    lastSeenDaysAgo: 0, subscription: { status: 'CANCELED', tier: 'PREMIUM', period: 'MONTHLY' },
    trial: 'CONVERTED', pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'sa-06', market: 'SA', surname: 'الحربي',
    parents: ['ياسر'],
    children: [{ given: 'شهد', age: 15, gender: 'female' }],
    registeredDaysAgo: 30, channel: 'GOOGLE', campaign: 'sa-back-to-school', platform: 'ANDROID',
    lastSeenDaysAgo: 0, subscription: { status: 'ACTIVE', tier: 'PREMIUM', period: 'MONTHLY' },
    trial: 'CONVERTED', pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'sa-07', market: 'SA', surname: 'الزهراني',
    parents: ['بدر', 'منيرة'],
    children: [{ given: 'فهد', age: 10, gender: 'male' }, { given: 'رغد', age: 13, gender: 'female' }],
    registeredDaysAgo: 30, channel: 'ORGANIC', campaign: null, platform: 'ANDROID',
    lastSeenDaysAgo: 11, subscription: { status: 'EXPIRED', tier: 'BASIC', period: 'MONTHLY' },
    trial: 'LAPSED', pilot: false, quietHours: 'DEFAULT',
  },
  {
    slug: 'sa-08', market: 'SA', surname: 'السبيعي',
    parents: ['راكان'],
    children: [{ given: 'ألين', age: 7, gender: 'female' }],
    registeredDaysAgo: 16, channel: 'APP_STORE', campaign: 'sa-back-to-school', platform: 'IOS',
    lastSeenDaysAgo: 1, subscription: { status: 'ACTIVE', tier: 'BASIC', period: 'MONTHLY' },
    trial: 'CONVERTED', pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'sa-09', market: 'SA', surname: 'المطيري',
    parents: ['تركي', 'لطيفة'],
    children: [{ given: 'نايف', age: 11, gender: 'male' }, { given: 'جود', age: 17, gender: 'female' }],
    registeredDaysAgo: 7, channel: 'REFERRAL', campaign: null, platform: 'IOS',
    lastSeenDaysAgo: 0, subscription: { status: 'TRIALING', tier: 'PREMIUM', period: 'MONTHLY' },
    trial: 'RUNNING', pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'sa-10', market: 'SA', surname: 'الرشيدي',
    parents: ['عادل'],
    children: [{ given: 'وليد', age: 8, gender: 'male' }],
    registeredDaysAgo: 7, channel: 'ORGANIC', campaign: null, platform: 'ANDROID',
    lastSeenDaysAgo: 5, subscription: null, trial: null, pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'sa-11', market: 'SA', surname: 'العنزي',
    parents: ['سعود', 'أروى'],
    children: [{ given: 'خالد', age: 12, gender: 'male' }, { given: 'رهف', age: 9, gender: 'female' }],
    registeredDaysAgo: 1, channel: 'TIKTOK', campaign: 'sa-launch', platform: 'IOS',
    lastSeenDaysAgo: 0, subscription: { status: 'TRIALING', tier: 'FAMILY', period: 'MONTHLY' },
    trial: 'RUNNING', pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'sa-12', market: 'SA', surname: 'البقمي',
    parents: ['فواز'],
    children: [{ given: 'دلال', age: 14, gender: 'female' }],
    registeredDaysAgo: 1, channel: 'PARENT_COMMUNITY', campaign: null, platform: 'ANDROID',
    lastSeenDaysAgo: 1, subscription: null, trial: null, pilot: false, quietHours: 'NARROW',
  },

  // ---- NO COUNTRY (deliberately unattributable) ---------------------------
  {
    slug: 'xx-01', market: null, surname: 'الأمين',
    parents: ['مصطفى'],
    children: [{ given: 'حسن', age: 11, gender: 'male' }],
    registeredDaysAgo: 60, channel: 'ORGANIC', campaign: null, platform: 'ANDROID',
    lastSeenDaysAgo: 1, subscription: null, trial: null, pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'xx-02', market: null, surname: 'الرشيد',
    parents: ['سامي', 'دعاء'],
    children: [{ given: 'تالا', age: 9, gender: 'female' }, { given: 'زين', age: 16, gender: 'male' }],
    registeredDaysAgo: 25, channel: 'OTHER', campaign: null, platform: 'IOS',
    lastSeenDaysAgo: 5, subscription: null, trial: null, pilot: false, quietHours: 'NARROW',
  },
  {
    slug: 'xx-03', market: null, surname: 'عبدالله',
    parents: ['كريم'],
    children: [{ given: 'ليان', age: 6, gender: 'female' }],
    registeredDaysAgo: 5, channel: 'ORGANIC', campaign: null, platform: 'ANDROID',
    lastSeenDaysAgo: 30, subscription: null, trial: null, pilot: false, quietHours: 'DEFAULT',
  },
];

/**
 * THE PROGRAM CATALOGUE THE DEMO DRAWS FROM. Category/activity pairs are taken
 * from `src/shared/rewards/program-taxonomy.ts` and the verification level from
 * `src/shared/rewards/verification.ts` — `RewardProgramService.create` rejects
 * an invalid pairing, and that rejection is a feature: if this list ever drifts
 * from the taxonomy the seed fails loudly instead of writing nonsense.
 *
 * `SELF_CHECK` appears only on the low-trust categories the matrix allows it on
 * (`HOUSEWORK`, `HABITS`, `SPORT`, `HEALTH`), which is why those attempts can
 * be auto-verified and therefore actually pay out; the rest go through a parent.
 */
interface ProgramSpec {
  readonly category: string;
  readonly activity: string;
  readonly targetSpec: Record<string, unknown>;
  readonly verificationLevel: 'SELF_CHECK' | 'PARENT_CONFIRMATION';
  readonly rewardSpec: { type: string; amount: number; description?: string; expiresInHours?: number };
  readonly durationMinutes: number;
  readonly difficulty: 'EASY' | 'MEDIUM' | 'HARD';
}

const PROGRAM_CATALOGUE: readonly ProgramSpec[] = [
  {
    category: 'QURAN', activity: 'QURAN_MEMORIZE_AYAH_RANGE',
    targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 5 },
    verificationLevel: 'PARENT_CONFIRMATION',
    rewardSpec: { type: 'POINTS', amount: 60 }, durationMinutes: 20, difficulty: 'MEDIUM',
  },
  {
    category: 'QURAN', activity: 'QURAN_REVIEW',
    targetSpec: { surahNumber: 78, fromAyah: 1, toAyah: 10, isReview: true },
    verificationLevel: 'PARENT_CONFIRMATION',
    rewardSpec: { type: 'POINTS', amount: 40 }, durationMinutes: 15, difficulty: 'EASY',
  },
  {
    category: 'SPORT', activity: 'PHYSICAL_ACTIVITY',
    targetSpec: { quantity: 30, unit: 'دقيقة' },
    verificationLevel: 'SELF_CHECK',
    rewardSpec: { type: 'SCREEN_TIME', amount: 20, expiresInHours: 24 }, durationMinutes: 30, difficulty: 'EASY',
  },
  {
    category: 'SCIENCE', activity: 'READ_PAGES',
    targetSpec: { quantity: 8, unit: 'صفحة', reference: 'كتاب العلوم' },
    verificationLevel: 'PARENT_CONFIRMATION',
    rewardSpec: { type: 'POINTS', amount: 35 }, durationMinutes: 25, difficulty: 'MEDIUM',
  },
  {
    category: 'PROGRAMMING', activity: 'CODE_EXERCISE',
    targetSpec: { quantity: 2, unit: 'تمرين', reference: 'Scratch' },
    verificationLevel: 'PARENT_CONFIRMATION',
    rewardSpec: { type: 'POINTS', amount: 50 }, durationMinutes: 40, difficulty: 'HARD',
  },
  {
    category: 'HOUSEWORK', activity: 'CHORE',
    targetSpec: { quantity: 1, unit: 'مهمة' },
    verificationLevel: 'SELF_CHECK',
    rewardSpec: { type: 'POINTS', amount: 25 }, durationMinutes: 15, difficulty: 'EASY',
  },
  {
    category: 'READING', activity: 'READ_PAGES',
    targetSpec: { quantity: 10, unit: 'صفحة' },
    verificationLevel: 'PARENT_CONFIRMATION',
    rewardSpec: { type: 'POINTS', amount: 30 }, durationMinutes: 20, difficulty: 'EASY',
  },
  {
    category: 'MATH', activity: 'SOLVE_PROBLEMS',
    targetSpec: { quantity: 12, unit: 'مسألة' },
    verificationLevel: 'PARENT_CONFIRMATION',
    rewardSpec: { type: 'POINTS', amount: 45 }, durationMinutes: 30, difficulty: 'MEDIUM',
  },
  {
    category: 'HABITS', activity: 'PRACTICE_SESSION',
    targetSpec: { quantity: 1, unit: 'جلسة' },
    verificationLevel: 'SELF_CHECK',
    rewardSpec: { type: 'PRIVILEGE', amount: 1, description: 'اختيار وجبة العشاء' }, durationMinutes: 10, difficulty: 'EASY',
  },
  {
    category: 'ARABIC', activity: 'MEMORIZE_TEXT',
    targetSpec: { quantity: 1, unit: 'قصيدة' },
    verificationLevel: 'PARENT_CONFIRMATION',
    rewardSpec: { type: 'POINTS', amount: 40 }, durationMinutes: 25, difficulty: 'MEDIUM',
  },
  {
    category: 'HEALTH', activity: 'PHYSICAL_ACTIVITY',
    targetSpec: { quantity: 20, unit: 'دقيقة' },
    verificationLevel: 'SELF_CHECK',
    rewardSpec: { type: 'POINTS', amount: 20 }, durationMinutes: 20, difficulty: 'EASY',
  },
  {
    category: 'ENGLISH', activity: 'PRACTICE_SESSION',
    targetSpec: { quantity: 1, unit: 'جلسة' },
    verificationLevel: 'PARENT_CONFIRMATION',
    rewardSpec: { type: 'POINTS', amount: 35 }, durationMinutes: 20, difficulty: 'MEDIUM',
  },
];

/**
 * THE PLACEHOLDER PRICE LIST. `subscription_prices` is empty on a fresh
 * database, and MRR/ARR/ARPPU are computed FROM it — so with no rows every
 * money KPI is honestly `null` and the unit-economics screen stays blank.
 *
 * THESE NUMBERS ARE NOT A PRICING DECISION. They are round, plausible amounts
 * in the right currency and the right order of magnitude, in MINOR UNITS, so
 * the arithmetic downstream is exercised. Real pricing needs the same sign-off
 * any pricing does — `prisma/seed.ts` says the same thing about
 * `plan_definitions` and this file does not quietly overrule it. The seed's own
 * output repeats the warning.
 */
const DEMO_PRICE_LIST: ReadonlyArray<{
  countryCode: 'EG' | 'SA';
  currencyCode: 'EGP' | 'SAR';
  tier: Tier;
  monthlyMinor: number;
}> = [
  { countryCode: 'EG', currencyCode: 'EGP', tier: 'BASIC', monthlyMinor: 9_900 },
  { countryCode: 'EG', currencyCode: 'EGP', tier: 'PREMIUM', monthlyMinor: 19_900 },
  { countryCode: 'EG', currencyCode: 'EGP', tier: 'FAMILY', monthlyMinor: 29_900 },
  { countryCode: 'SA', currencyCode: 'SAR', tier: 'BASIC', monthlyMinor: 2_900 },
  { countryCode: 'SA', currencyCode: 'SAR', tier: 'PREMIUM', monthlyMinor: 4_900 },
  { countryCode: 'SA', currencyCode: 'SAR', tier: 'FAMILY', monthlyMinor: 7_900 },
];

/** Quarterly = 3 months less 10%; annual = 12 months less 20%. Integer minor units. */
function periodAmountMinor(monthlyMinor: number, period: Period): number {
  if (period === 'MONTHLY') return monthlyMinor;
  if (period === 'QUARTERLY') return Math.round((monthlyMinor * 3 * 90) / 100);
  return Math.round((monthlyMinor * 12 * 80) / 100);
}

const PERIOD_MONTHS: Readonly<Record<Period, number>> = { MONTHLY: 1, QUARTERLY: 3, ANNUAL: 12 };

/**
 * VAT, IN BASIS POINTS, FROM `countries.vat_basis_points`. Both launch markets
 * price INCLUSIVE, so the VAT is carved OUT of the gross rather than added to
 * it: vat = round(gross × bps / (10000 + bps)). Integer arithmetic throughout —
 * `kpi-definitions.ts` rule 1, and the reason this is not `amount * 0.14`.
 */
function splitVatInclusive(grossMinor: number, vatBasisPoints: number): { vatMinor: number; netMinor: number } {
  const vatMinor = Math.round((grossMinor * vatBasisPoints) / (10_000 + vatBasisPoints));
  return { vatMinor, netMinor: grossMinor - vatMinor };
}

/** The four demo campaigns, one per market pair. Budgets are minor units. */
const CAMPAIGNS: ReadonlyArray<{
  slug: string;
  nameAr: string;
  countryCode: 'EG' | 'SA';
  currencyCode: 'EGP' | 'SAR';
  channel: string;
  budgetMinor: number;
  targetUsers: number;
  targetPaidUsers: number;
  dailySpendMinor: number;
  startsDaysAgo: number;
  endsInDays: number;
}> = [
  {
    slug: 'eg-launch', nameAr: 'إطلاق مصر', countryCode: 'EG', currencyCode: 'EGP',
    channel: 'TIKTOK', budgetMinor: 200_000, targetUsers: 40, targetPaidUsers: 8,
    dailySpendMinor: 1_200, startsDaysAgo: 98, endsInDays: 14,
  },
  {
    slug: 'eg-ramadan', nameAr: 'حملة رمضان مصر', countryCode: 'EG', currencyCode: 'EGP',
    channel: 'INFLUENCER', budgetMinor: 90_000, targetUsers: 25, targetPaidUsers: 5,
    dailySpendMinor: 800, startsDaysAgo: 60, endsInDays: 7,
  },
  {
    slug: 'sa-launch', nameAr: 'إطلاق السعودية', countryCode: 'SA', currencyCode: 'SAR',
    channel: 'TIKTOK', budgetMinor: 40_000, targetUsers: 25, targetPaidUsers: 6,
    dailySpendMinor: 200, startsDaysAgo: 98, endsInDays: 21,
  },
  {
    slug: 'sa-back-to-school', nameAr: 'العودة للمدارس السعودية', countryCode: 'SA', currencyCode: 'SAR',
    channel: 'GOOGLE', budgetMinor: 15_000, targetUsers: 15, targetPaidUsers: 3,
    dailySpendMinor: 130, startsDaysAgo: 45, endsInDays: 30,
  },
];

// ---------------------------------------------------------------------------
// 4. SMALL HELPERS
// ---------------------------------------------------------------------------

const now = new Date();

/**
 * THE ANCHOR: THE INSTANT «N DAYS AGO» IS COUNTED FROM, AND IT IS `now`.
 *
 * Retention, DAU and every «registered N days ago» cohort are counted on the
 * COUNTRY's calendar (Africa/Cairo, Asia/Riyadh — both UTC+3), not on UTC. The
 * temptation is to anchor the dataset to a tidy 00:00 or 07:00 UTC; both are
 * wrong in the same way, because a seed run at 22:00 UTC is already TOMORROW in
 * Cairo, and a household written at «07:00 UTC today» would then land on
 * YESTERDAY's reporting day — so the D1 cohort would silently be the D2 one and
 * the retention grid would read «—».
 *
 * Anchoring on `now` assumes nothing: day 0 IS the current reporting day in
 * every timezone, by construction, and every offset is an exact multiple of 24h
 * from it, so the local time-of-day (and therefore the local DATE) is stable
 * across the whole history — including across Egypt's DST changes, which move
 * the clock by an hour and not by a day.
 *
 * The consequence to know: the cohorts are aligned to the moment the seed RAN.
 * Look at the dashboard the next day and the D1 cohort is a D2 cohort, exactly
 * as it would be for real households. Re-running the seed re-aligns it.
 */
const ANCHOR: number = now.getTime();

const daysAgo = (n: number): Date => new Date(ANCHOR - n * DAY_MS);
const businessDateOf = (d: Date): string => d.toISOString().slice(0, 10);
const dateColumn = (d: Date): Date => new Date(`${businessDateOf(d)}T00:00:00.000Z`);

/** A stable, readable Arabic family label that also screams DEMO. */
const familyName = (spec: FamilySpec): string =>
  `DEMO-${(spec.market ?? 'XX').toUpperCase()}-${spec.slug.slice(-2)} · أسرة ${spec.surname}`;

/** Deterministic date of birth for a target age; noon UTC avoids any day slip. */
function dobForAge(age: number, offsetDays: number): string {
  const d = new Date(now.getTime() - (age * 365.25 + offsetDays) * DAY_MS);
  return d.toISOString().slice(0, 10);
}

const counters: Record<string, number> = {};
const bump = (key: string, by = 1): void => {
  counters[key] = (counters[key] ?? 0) + by;
};

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(2, 66 - title.length))}`);
}

// ---------------------------------------------------------------------------
// 5. THE SEED
// ---------------------------------------------------------------------------

interface SeededFamily {
  readonly spec: FamilySpec;
  readonly familyId: string;
  readonly ownerUserId: string;
  readonly children: Array<{ id: string; spec: ChildSpec }>;
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force-non-local');
  // `.env` is what `npm run seed:demo` will actually be configured by, and the
  // refusal below has to read DATABASE_URL BEFORE Nest boots — so it is loaded
  // here rather than relying on ConfigModule, which loads too late to refuse.
  try {
    require('dotenv').config();
  } catch {
    /* dotenv is a @nestjs/config dependency; if it is absent the shell env is used. */
  }
  const target = assertLocalDatabase(force);

  console.log(
    [
      '',
      '  ABNY / «ابني» — DEMO SEED',
      `  Target database : ${target}`,
      `  History window  : ${HISTORY_DAYS} days ending ${businessDateOf(now)}`,
      '  Every row written below is synthetic and carries the marker "demo".',
      '',
    ].join('\n'),
  );

  const prisma = buildPrismaSubstitute();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma.service)
    .compile();
  // Nest logs a great deal at boot; the seed's own output is what matters.
  moduleRef.useLogger(false as any);
  await moduleRef.init();

  const db = prisma.service;
  const auth = moduleRef.get(AuthService);
  const children = moduleRef.get(ChildrenService);
  const programsSvc = moduleRef.get(RewardProgramService);
  const achievements = moduleRef.get(AchievementService);
  const relay = moduleRef.get(OutboxRelay);
  const rewards = moduleRef.get(RewardsEngineService);
  const release = moduleRef.get(QuietHoursReleaseService);
  const campaignsSvc = moduleRef.get(CampaignService);
  const forecast = moduleRef.get(ForecastService);
  const aggregation = moduleRef.get(GrowthAggregationService);
  const alerts = moduleRef.get(GrowthAlertsService);
  const pilot = moduleRef.get(PilotEnrollmentService);
  const referrals = moduleRef.get(ReferralService);
  const referralRewards = moduleRef.get(ReferralRewardService);

  try {
    await ensurePlanDefinitions(db);
    await ensurePriceList(db);
    const pilotInvites = await ensurePilotInvites(pilot);
    const seeded = await seedHouseholds(db, auth, children);
    await redeemPilotInvites(pilot, pilotInvites, seeded);
    await seedDevices(db, seeded);
    await seedCommercials(db, seeded);
    await seedNotificationPolicy(db, seeded);
    await seedInstallEvents(db, seeded);
    await seedPrograms(db, programsSvc, achievements, seeded);
    await drainOutbox(relay);
    await seedRedemptionsAndMessages(db, rewards, seeded);
    await seedSupportRequests(db, seeded);
    await seedReferrals(db, referrals, referralRewards, seeded);
    // SECOND DRAIN, AND THE ORDER IS LOAD-BEARING. Redemptions, coin grants and
    // referral qualification all announce themselves through the same bus, so
    // they enqueue outbox messages of their own. Draining and releasing AFTER
    // them — rather than only after the achievements — is what leaves the
    // notification tables at a fixed point: anything still pending here would
    // be picked up by the NEXT run of this seed and would look like the counts
    // had changed on a re-run.
    await drainOutbox(relay);
    await releaseDeferred(release);
    await seedCampaigns(db, campaignsSvc, seeded);
    await seedTargetsAndScenarios(forecast, seeded);
    await seedActivations(db, seeded);
    await runDailyAggregation(aggregation);
    await runAlertScan(alerts);
    await report(db);
  } finally {
    await moduleRef.close();
    await prisma.close();
  }
}

// ---- 5.1 reference data ----------------------------------------------------

/**
 * `plan_definitions` gates `multiple_children` through `EntitlementsService`,
 * so a database without it cannot hold a two-child household and the demo would
 * silently be half a demo.
 *
 * MIRRORS `prisma/seed.ts` — that file owns the tier catalogue and its
 * placeholder pricing, and this one deliberately does not overrule it: the rows
 * are written ONLY when the table is empty, so a database already seeded from
 * there is left exactly as it is.
 */
async function ensurePlanDefinitions(db: any): Promise<void> {
  section('reference data');
  const existing = await sys('counting plan definitions', () => db.planDefinition.count());
  if (existing > 0) {
    console.log(`  plan_definitions        · ${existing} already present, left untouched`);
    return;
  }

  const base = ['multiple_children'];
  const premium = [...base, 'ai_diagnostics', 'family_insights', 'behavioral_trend_analysis'];
  const family = [...premium, 'unlimited_devices_per_child', 'priority_support'];
  const plans = [
    { tier: 'FREE', name: 'Free', priceCents: 0, features: base },
    { tier: 'BASIC', name: 'Basic', priceCents: 1999, features: base },
    { tier: 'PREMIUM', name: 'Premium', priceCents: 3999, features: premium },
    { tier: 'FAMILY', name: 'Family', priceCents: 7999, features: family },
    { tier: 'ENTERPRISE', name: 'Enterprise', priceCents: 0, features: family },
  ];
  for (const plan of plans) {
    await sys('creating a plan definition', () =>
      db.planDefinition.create({
        data: { ...plan, currency: 'SAR', billingIntervalMonths: 1, features: plan.features },
      }),
    );
  }
  console.log(`  plan_definitions        · ${plans.length} created (placeholder pricing, see prisma/seed.ts)`);
}

/** One live price per (tier, country, period) — the schema's own unique key. */
async function ensurePriceList(db: any): Promise<void> {
  let written = 0;
  for (const row of DEMO_PRICE_LIST) {
    for (const period of ['MONTHLY', 'QUARTERLY', 'ANNUAL'] as Period[]) {
      const amountMinor = periodAmountMinor(row.monthlyMinor, period);
      await sys('upserting a demo price', () =>
        db.subscriptionPrice.upsert({
          where: {
            planTier_countryCode_billingPeriod: {
              planTier: row.tier,
              countryCode: row.countryCode,
              billingPeriod: period,
            },
          },
          create: {
            planTier: row.tier,
            countryCode: row.countryCode,
            currencyCode: row.currencyCode,
            billingPeriod: period,
            amountMinor,
            vatMode: 'INCLUSIVE',
            isActive: true,
          },
          update: { amountMinor, currencyCode: row.currencyCode, vatMode: 'INCLUSIVE', isActive: true },
        }),
      );
      written += 1;
    }
  }
  bump('subscription_prices', written);
  console.log(`  subscription_prices     · ${written} upserted  ⚠ PLACEHOLDER PRICING — not a pricing decision`);
}

/**
 * THE PILOT ALLOW-LIST, AND THE ONE SETTING THIS SEED REFUSES TO TOUCH.
 *
 * `pilot.enabled` DEFAULTS TO FALSE AND IS LEFT FALSE. Turning it on would make
 * the registration gate live, and the very next thing the owner does after
 * running this seed is register his OWN account through the dashboard
 * (`RUN.md` step 6) — which would then be refused because he is not on the
 * allow-list. A demo seed that locks its user out of the product is not a demo.
 *
 * The consequence is that `AuthService.register` never reaches its `redeem`
 * call for these households, so redemption is performed explicitly afterwards
 * (`redeemPilotInvites`) using the SAME `PilotEnrollmentService.redeem` the
 * registration path uses. The invitations are otherwise real rows: an operator
 * inviting a household before it exists is exactly what this table is for.
 */
async function ensurePilotInvites(pilot: any): Promise<Map<string, string>> {
  const bySlug = new Map<string, string>();
  let invited = 0;
  for (const spec of FAMILIES) {
    if (!spec.pilot || spec.market === null) continue;
    const invite = await pilot.invite({
      email: demoEmail(spec.slug, 'parent1'),
      cohortId: DEMO_PILOT_COHORT,
      countryCode: spec.market,
    });
    bySlug.set(spec.slug, invite.id);
    invited += 1;
  }
  // Invitations that were sent and never taken up — the panel's other half.
  const unredeemed = [
    { email: `${DEMO}.pending-01@${EMAIL_DOMAIN}`, countryCode: 'EG' },
    { email: `${DEMO}.pending-02@${EMAIL_DOMAIN}`, countryCode: 'EG' },
    { email: `${DEMO}.pending-03@${EMAIL_DOMAIN}`, countryCode: 'SA' },
    { email: `${DEMO}.pending-04@${EMAIL_DOMAIN}`, countryCode: 'SA' },
    { email: `${DEMO}.pending-05@${EMAIL_DOMAIN}`, countryCode: 'SA' },
  ];
  for (const row of unredeemed) {
    await pilot.invite({ email: row.email, cohortId: DEMO_PILOT_COHORT, countryCode: row.countryCode });
  }
  bump('pilot_invites', invited + unredeemed.length);
  console.log(
    `  pilot_invites           · ${invited + unredeemed.length} upserted (${invited} redeemable by a demo household, ${unredeemed.length} left open)`,
  );
  return bySlug;
}

/** Marks the invited households enrolled. `redeem` is conditional on
 * `redeemedAt IS NULL` in its own WHERE clause, so a re-run is a no-op that
 * logs and returns false rather than handing a used invitation back out. */
async function redeemPilotInvites(
  pilot: any,
  invites: Map<string, string>,
  seeded: SeededFamily[],
): Promise<void> {
  let redeemed = 0;
  for (const fam of seeded) {
    const inviteId = invites.get(fam.spec.slug);
    if (!inviteId) continue;
    if (await pilot.redeem(inviteId, fam.familyId)) redeemed += 1;
  }
  console.log(`  pilot enrolment         · ${redeemed} invitation(s) redeemed this run`);
}

// ---- 5.2 households --------------------------------------------------------

/**
 * Households go through `AuthService.register`, which is the only path that
 * creates a User, a Family, a FamilyMember, the attribution row and the audit
 * record in one consistent shape. Registration runs under `AUTH_BOOTSTRAP`
 * because it runs BEFORE any tenant exists — the same context the HTTP route
 * declares.
 *
 * BACKDATING IS DONE AFTERWARDS AND ONLY ON MUTABLE TABLES. `created_at` is
 * `now()` by definition, and a demo whose entire population registered in the
 * same second has no trend to chart. `users`, `families`, `family_members` and
 * `acquisition_attributions` are ordinary mutable tables; none of the four
 * append-only tables is touched.
 */
async function seedHouseholds(db: any, auth: any, childrenSvc: any): Promise<SeededFamily[]> {
  section('households');
  const out: SeededFamily[] = [];

  for (const spec of FAMILIES) {
    const registeredAt = daysAgo(spec.registeredDaysAgo);
    const email = demoEmail(spec.slug, 'parent1');

    const existingUser = await sys('looking up a demo parent', () =>
      db.user.findUnique({ where: { email }, select: { id: true } }),
    );

    let familyId: string;
    let ownerUserId: string;

    if (existingUser) {
      const membership = await sys('resolving an existing demo household', () =>
        db.familyMember.findFirst({ where: { userId: existingUser.id }, select: { familyId: true } }),
      );
      familyId = membership.familyId;
      ownerUserId = existingUser.id;
    } else {
      const registered: { id: string; familyId: string } = await runAsSystemAsync(
        'AUTH_BOOTSTRAP',
        'Demo seed registers a synthetic household through the real registration path.',
        async () =>
          auth.register({
            email,
            password: DEMO_PASSWORD,
            fullName: `${spec.parents[0]} ${spec.surname} (DEMO)`,
            familyName: familyName(spec),
            // `undefined` for the three country-less households — the server
            // then stores NULL, which is what makes them unattributable.
            countryCode: spec.market ?? undefined,
            timezone: spec.market === 'EG' ? 'Africa/Cairo' : spec.market === 'SA' ? 'Asia/Riyadh' : 'UTC',
            locale: 'ar',
            acceptedTerms: true,
            attribution: {
              channel: spec.channel,
              source: `${DEMO}-seed`,
              campaign: spec.campaign ?? undefined,
              medium: spec.campaign ? 'cpc' : 'organic',
              // Omitted for the country-less households on purpose: an
              // attribution country would attribute them to a market.
              countryCode: spec.market ?? undefined,
              platform: spec.platform,
              sessionId: `${DEMO}-session-${spec.slug}`,
              landingPage: 'https://demo-seed.invalid/ar',
            },
          }),
      );
      familyId = registered.familyId;
      ownerUserId = registered.id;
      bump('users');
      bump('families');
    }

    // Co-parent, when the spec has one. Same registration path, then joined to
    // the household this seed just created.
    if (spec.parents.length > 1) {
      const coEmail = demoEmail(spec.slug, 'parent2');
      const existingCo = await sys('looking up a demo co-parent', () =>
        db.user.findUnique({ where: { email: coEmail }, select: { id: true } }),
      );
      if (!existingCo) {
        const co = await sys('creating a demo co-parent', () =>
          db.user.create({
            data: {
              email: coEmail,
              // Argon2 is deliberately slow; the co-parent never logs in, so
              // the demo does not pay for a second hash per household. The
              // value is a literal marker, not a hash of anything.
              passwordHash: `demo-seed:no-login:${spec.slug}`,
              fullName: `${spec.parents[1]} ${spec.surname} (DEMO)`,
              locale: 'ar',
              timezone: spec.market === 'EG' ? 'Africa/Cairo' : spec.market === 'SA' ? 'Asia/Riyadh' : 'UTC',
              status: 'ACTIVE',
              createdAt: registeredAt,
            },
            select: { id: true },
          }),
        );
        await sys('joining a demo co-parent to a household', () =>
          db.familyMember.create({
            data: { familyId, userId: co.id, role: 'PARENT', joinedAt: registeredAt },
          }),
        );
        bump('users');
      }
    }

    // Backdate the household so the growth series has a shape.
    await sys('backdating a demo household', async () => {
      await db.family.update({ where: { id: familyId }, data: { createdAt: registeredAt } });
      await db.user.update({ where: { id: ownerUserId }, data: { createdAt: registeredAt, lastLoginAt: daysAgo(spec.lastSeenDaysAgo ?? spec.registeredDaysAgo) } });
      await db.familyMember.updateMany({ where: { familyId }, data: { joinedAt: registeredAt } });
      await db.acquisitionAttribution.updateMany({ where: { familyId }, data: { createdAt: registeredAt } });
    });

    // Children. `ChildrenService.createChild` enforces the `multiple_children`
    // entitlement and emits the CHILD_ADDED growth event, so it is used rather
    // than a direct insert.
    const kids: Array<{ id: string; spec: ChildSpec }> = [];
    for (const [index, child] of spec.children.entries()) {
      const lastName = `DEMO-${spec.slug.toUpperCase()}`;
      const existingChild = await sys('looking up a demo child', () =>
        db.child.findFirst({
          where: { familyId, firstName: child.given, lastName },
          select: { id: true },
        }),
      );
      if (existingChild) {
        kids.push({ id: existingChild.id, spec: child });
        continue;
      }
      const created = await asFamily({ familyId, ownerUserId }, () =>
          childrenSvc.createChild(familyId, {
            firstName: child.given,
            lastName,
            dateOfBirth: dobForAge(child.age, index * 37),
            gender: child.gender,
          }),
      );
      // A child added a day AFTER the household registered: the activation
      // definition's third gate requires a real gap between adding a child and
      // that child completing something, and a demo where every child was
      // created seconds ago would activate nobody.
      const childCreatedAt = new Date(registeredAt.getTime() + (index + 1) * 3 * 60 * 60 * 1000);
      await sys('backdating a demo child', () =>
        db.child.update({ where: { id: created.id }, data: { createdAt: childCreatedAt } }),
      );
      kids.push({ id: created.id, spec: child });
      bump('children');
    }

    out.push({ spec, familyId, ownerUserId, children: kids });
  }

  const byMarket = (m: Market): number => out.filter((f) => f.spec.market === m).length;
  console.log(
    `  families                · ${out.length} total — EG ${byMarket('EG')} · SA ${byMarket('SA')} · no country ${byMarket(null)}`,
  );
  console.log(`  children                · ${out.reduce((n, f) => n + f.children.length, 0)} across the four age bands (6-8 / 9-11 / 12-14 / 15-17)`);
  return out;
}

// ---- 5.3 devices -----------------------------------------------------------

/**
 * One parent device per household plus one per child, each with a `lastSeenAt`
 * inside the household's stated activity window — which is what DAU/WAU/MAU and
 * `activeFamiliesLast7Days` are actually counted from. A device is a heartbeat,
 * not a person; that is exactly what the dashboard says it is.
 *
 * WHY NOT THE PAIRING SERVICE: pairing is a multi-step cryptographic handshake
 * driven by a real device (attestation chain, public key, challenge/response).
 * There is no server-side "just pair it" call, and faking the handshake would
 * mean forging attestation material. These rows are written with Prisma and
 * carry `trustLevel: L1_REGISTERED` — the level a device with no attestation
 * honestly has — rather than pretending to a verification that never happened.
 */
async function seedDevices(db: any, seeded: SeededFamily[]): Promise<void> {
  section('devices');
  let created = 0;
  let active7 = 0;

  for (const fam of seeded) {
    const { spec } = fam;
    const pairedAt = new Date(daysAgo(spec.registeredDaysAgo).getTime() + 2 * 60 * 60 * 1000);
    const owners: Array<{ kind: 'PARENT' | 'CHILD'; userId: string | null; childId: string | null; label: string }> = [
      { kind: 'PARENT', userId: fam.ownerUserId, childId: null, label: 'parent' },
      ...fam.children.map((c, i) => ({
        kind: 'CHILD' as const,
        userId: null,
        childId: c.id,
        label: `child${i + 1}`,
      })),
    ];

    for (const [index, owner] of owners.entries()) {
      const fingerprint = `${DEMO}-seed:${spec.slug}:${owner.label}`;
      const existing = await sys('looking up a demo device', () =>
        db.device.findFirst({ where: { deviceFingerprint: fingerprint }, select: { id: true } }),
      );
      // A household with no heartbeat at all still owns a device — it is simply
      // PENDING_PAIRING with a NULL lastSeenAt, which is a real state and the
      // one that keeps it out of every "active" count.
      const seenDays = spec.lastSeenDaysAgo === null ? null : spec.lastSeenDaysAgo + index;
      const lastSeenAt = seenDays === null ? null : daysAgo(seenDays);
      const data = {
        familyId: fam.familyId,
        ownerType: owner.kind,
        userId: owner.userId,
        childId: owner.childId,
        platform: spec.platform,
        deviceModel: spec.platform === 'IOS' ? 'iPhone 13 (DEMO)' : 'Galaxy A54 (DEMO)',
        osVersion: spec.platform === 'IOS' ? '17.4' : '14',
        appVersion: '1.0.0-demo',
        status: lastSeenAt === null ? 'PENDING_PAIRING' : 'ACTIVE',
        lastSeenAt,
        pairedAt: lastSeenAt === null ? null : pairedAt,
        trustLevel: 'L1_REGISTERED',
        deviceFingerprint: fingerprint,
        pairingProtocolVersion: 'demo-seed',
        createdAt: pairedAt,
      };

      await asFamily(fam, async () => {
        if (existing) {
          await db.device.update({ where: { id: existing.id }, data: { lastSeenAt, status: data.status } });
        } else {
          await db.device.create({ data });
          created += 1;
        }
      });
      if (seenDays !== null && seenDays <= 7) active7 += 1;
    }
  }

  bump('devices', created);
  console.log(`  devices                 · ${created} created (${active7} with a heartbeat inside 7 days)`);
}

// ---- 5.4 commercial --------------------------------------------------------

/**
 * SUBSCRIPTIONS, TRIALS, PAYMENTS, ENTITLEMENTS AND INVOICES.
 *
 * WRITTEN WITH PRISMA, AND THE REASON IS STATED RATHER THAN ASSUMED: the only
 * production path into `payment_transactions` is a provider webhook whose body
 * has been signature-verified (`PaymentWebhookService`). There is no
 * server-side "record a payment" call and there must not be one. Forging a
 * Paymob or Moyasar payload would exercise the adapter's parser, not any
 * business rule, so these rows are written directly — honouring every invariant
 * the schema names:
 *
 *   · money is INTEGER MINOR UNITS, and the VAT split comes from
 *     `countries.vat_basis_points` (EG 1400, SA 1500) in basis points;
 *   · `currency` is the COUNTRY's currency, frozen on the row, and EGP and SAR
 *     never meet in any column;
 *   · `idempotency_key` is deterministic (`demo-seed:…`), so the table's own
 *     `(family_id, idempotency_key)` UNIQUE makes a re-run a no-op rather than
 *     a second charge;
 *   · a subscription always names the price row it was sold at, and an
 *     entitlement always names its subscription. No orphans.
 */
async function seedCommercials(db: any, seeded: SeededFamily[]): Promise<void> {
  section('subscriptions, trials & payments');

  const countries: Record<string, { currencyCode: string; vatBasisPoints: number; provider: string }> = {};
  for (const code of ['EG', 'SA']) {
    const row = await sys('reading a country', () =>
      db.country.findUnique({ where: { code }, select: { currencyCode: true, vatBasisPoints: true, defaultProvider: true } }),
    );
    countries[code] = {
      currencyCode: row.currencyCode,
      vatBasisPoints: row.vatBasisPoints,
      provider: row.defaultProvider,
    };
  }

  const statusCounts: Record<string, number> = {};
  let payments = 0;
  let trials = 0;

  for (const fam of seeded) {
    const { spec } = fam;
    const registeredAt = daysAgo(spec.registeredDaysAgo);

    // ---- the trial -------------------------------------------------------
    if (spec.trial !== null) {
      const startedAt = new Date(registeredAt.getTime() + 10 * 60 * 1000);
      const endsAt = new Date(startedAt.getTime() + 14 * DAY_MS);
      const convertedAt = spec.trial === 'CONVERTED' ? new Date(endsAt.getTime() - DAY_MS) : null;
      const existingTrial = await asFamily(fam, () => db.trial.findUnique({ where: { familyId: fam.familyId }, select: { id: true } }),
      );
      if (!existingTrial) {
        await asFamily(fam, () =>
          db.trial.create({
            data: {
              familyId: fam.familyId,
              planTier: spec.subscription?.tier ?? 'PREMIUM',
              startedAt,
              endsAt,
              source: 'SIGNUP',
              convertedAt,
              cancelledAt: null,
              createdAt: startedAt,
            },
          }),
        );
        trials += 1;
      }
    }

    if (spec.subscription === null || spec.market === null) continue;
    const market = countries[spec.market];
    const sub = spec.subscription;
    statusCounts[sub.status] = (statusCounts[sub.status] ?? 0) + 1;

    const price = await sys('reading the demo price', () =>
      db.subscriptionPrice.findUnique({
        where: {
          planTier_countryCode_billingPeriod: {
            planTier: sub.tier,
            countryCode: spec.market as string,
            billingPeriod: sub.period,
          },
        },
        select: { id: true, amountMinor: true },
      }),
    );

    const periodMonths = PERIOD_MONTHS[sub.period];
    // ---- the billing timeline -------------------------------------------
    // THE CHARGES ARE DERIVED FROM THE SUBSCRIPTION, not listed by hand, so a
    // household that has held a monthly plan for three months has three
    // renewals behind it rather than one — which is what makes the revenue
    // series a series instead of a spike.
    //
    //   · the first charge is when the 14-day trial ended;
    //   · renewals repeat every billing period after it;
    //   · a CANCELED / EXPIRED subscription stops charging at its cancellation
    //     date, because a cancelled subscription that kept billing would be the
    //     most alarming thing on the page;
    //   · PAST_DUE and GRACE_PERIOD end with a FAILED attempt, which is exactly
    //     what those two states mean and what `paymentFailureCount` counts.
    const stepDays = periodMonths * 30;
    const firstChargeDaysAgo = Math.max(1, spec.registeredDaysAgo - 14);
    const cancelDaysAgo =
      sub.status === 'CANCELED' || sub.status === 'EXPIRED' ? Math.max(1, Math.round(spec.registeredDaysAgo * 0.4)) : 0;
    const canceledAt = cancelDaysAgo > 0 ? daysAgo(cancelDaysAgo) : null;
    const graceEndsAt = sub.status === 'GRACE_PERIOD' ? new Date(ANCHOR + 4 * DAY_MS) : null;

    const charges: Array<{ n: number; status: 'SUCCEEDED' | 'FAILED'; occurredDaysAgo: number }> = [];
    if (sub.status !== 'TRIALING') {
      let n = 1;
      for (let d = firstChargeDaysAgo; d >= 1 && charges.length < 8; d -= stepDays) {
        if (d < cancelDaysAgo) break;
        charges.push({ n: n++, status: 'SUCCEEDED', occurredDaysAgo: d });
      }
      if (sub.status === 'PAST_DUE' || sub.status === 'GRACE_PERIOD') {
        const lastSuccess = charges[charges.length - 1]?.occurredDaysAgo ?? firstChargeDaysAgo;
        charges.push({ n: n++, status: 'FAILED', occurredDaysAgo: Math.max(1, lastSuccess - stepDays) });
      }
    }

    // The CURRENT period runs from the most recent successful charge — or from
    // the end of the trial for a household that has not paid yet.
    const lastSucceededDaysAgo =
      [...charges].reverse().find((c) => c.status === 'SUCCEEDED')?.occurredDaysAgo ?? null;
    const periodStart =
      lastSucceededDaysAgo === null ? new Date(registeredAt.getTime() + 14 * DAY_MS) : daysAgo(lastSucceededDaysAgo);
    const periodEnd = new Date(periodStart.getTime() + stepDays * DAY_MS);

    const subscriptionStartedAt = new Date(registeredAt.getTime() + 14 * DAY_MS);

    const subscriptionData = {
      planTier: sub.tier,
      status: sub.status,
      provider: market.provider,
      providerSubscriptionId: `${DEMO}-seed-sub-${spec.slug}`,
      trialEndsAt: spec.trial ? new Date(registeredAt.getTime() + 14 * DAY_MS) : null,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      canceledAt,
      countryCode: spec.market,
      currencyCode: market.currencyCode,
      billingPeriod: sub.period,
      subscriptionPriceId: price.id,
      gracePeriodEndsAt: graceEndsAt,
      autoRenewing: sub.status === 'ACTIVE' || sub.status === 'GRACE_PERIOD',
      lastProviderEventAt: canceledAt ?? periodStart,
    };

    const subscription = await asFamily(fam, () =>
        db.subscription.upsert({
          where: { familyId: fam.familyId },
          // The subscription BEGAN when the trial ended, not at its current
          // period start — `KpiService`'s churn base counts subscriptions that
          // already existed 30 days ago, and dating the row to its latest
          // renewal would make every long-standing household look brand new and
          // drive the churn denominator to nearly zero.
          create: { familyId: fam.familyId, ...subscriptionData, createdAt: subscriptionStartedAt },
          update: subscriptionData,
          select: { id: true },
        }),
    );

    for (const charge of charges) {
      const idempotencyKey = `${DEMO}-seed:pay:${spec.slug}:${charge.n}`;
      const existing = await asFamily(fam, () =>
          db.paymentTransaction.findFirst({
            where: { familyId: fam.familyId, idempotencyKey },
            select: { id: true },
          }),
      );
      if (existing) continue;

      const gross = price.amountMinor;
      const { vatMinor, netMinor } = splitVatInclusive(gross, market.vatBasisPoints);
      const occurredAt = daysAgo(charge.occurredDaysAgo);

      const tx = await asFamily(fam, () =>
          db.paymentTransaction.create({
            data: {
              familyId: fam.familyId,
              subscriptionId: subscription.id,
              provider: market.provider,
              providerTransactionId: `${DEMO}-seed-txn-${spec.slug}-${charge.n}`,
              productRef: price.id,
              planTier: sub.tier,
              billingPeriod: sub.period,
              countryCode: spec.market,
              currency: market.currencyCode,
              // The amounts describe the CHARGE THAT WAS ATTEMPTED, not the
              // money that moved — `payment_transactions_amounts_check`
              // requires `net + vat = gross` on every row, including a FAILED
              // one, and `status` is what says whether it settled. Zeroing the
              // split on a failure would break that CHECK and would also make
              // "how much did we fail to collect" unanswerable.
              grossAmountMinor: gross,
              vatAmountMinor: vatMinor,
              netAmountMinor: netMinor,
              status: charge.status,
              idempotencyKey,
              occurredAt,
              verifiedAt: charge.status === 'SUCCEEDED' ? occurredAt : null,
              isSandbox: false,
              createdAt: occurredAt,
            },
            select: { id: true },
          }),
      );
      payments += 1;

      if (charge.status === 'SUCCEEDED') {
        await asFamily(fam, () =>
          db.invoice.create({
            data: {
              familyId: fam.familyId,
              subscriptionId: subscription.id,
              amountCents: gross,
              currency: market.currencyCode,
              status: 'PAID',
              invoiceNumber: `DEMO-${spec.slug.toUpperCase()}-${String(charge.n).padStart(4, '0')}`,
              countryCode: spec.market,
              billingPeriod: sub.period,
              vatBasisPoints: market.vatBasisPoints,
              subtotalMinor: netMinor,
              vatMinor,
              totalMinor: gross,
              provider: market.provider,
              paymentTransactionId: tx.id,
              issuedAt: occurredAt,
              paidAt: occurredAt,
            },
          }),
        );
        bump('invoices');
      }
    }

    // ---- entitlements ----------------------------------------------------
    // One live row per (family, feature): the unique key makes this an upsert,
    // which is exactly how a renewal extends access in production.
    const entitled = ['ACTIVE', 'TRIALING', 'GRACE_PERIOD'].includes(sub.status);
    const features =
      sub.tier === 'BASIC'
        ? ['multiple_children']
        : sub.tier === 'PREMIUM'
          ? ['multiple_children', 'ai_diagnostics', 'family_insights', 'behavioral_trend_analysis']
          : ['multiple_children', 'ai_diagnostics', 'family_insights', 'behavioral_trend_analysis', 'unlimited_devices_per_child', 'priority_support'];

    for (const featureKey of features) {
      const data = {
        planTier: sub.tier,
        source: market.provider,
        subscriptionId: subscription.id,
        status: entitled ? 'ACTIVE' : 'REVOKED',
        validFrom: periodStart,
        validUntil: periodEnd,
        revokedAt: entitled ? null : (canceledAt ?? daysAgo(1)),
        revokedReason: entitled ? null : `subscription ${sub.status}`,
      };
      await asFamily(fam, () =>
        db.entitlement.upsert({
          where: { familyId_featureKey: { familyId: fam.familyId, featureKey } },
          create: { familyId: fam.familyId, featureKey, ...data },
          update: data,
        }),
      );
      bump('entitlements');
    }
  }

  bump('subscriptions', Object.values(statusCounts).reduce((a, b) => a + b, 0));
  bump('trials', trials);
  bump('payment_transactions', payments);
  const statusLine = Object.entries(statusCounts)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
  console.log(`  subscriptions           · ${statusLine || 'none'}`);
  console.log(`  trials                  · ${trials} created`);
  console.log(`  payment_transactions    · ${payments} created (EGP for EG, SAR for SA — never summed)`);
}

// ---- 5.5 notification policy ----------------------------------------------

/**
 * PER-HOUSEHOLD QUIET HOURS — a real setting, on the real table, and a
 * deliberately MIXED population.
 *
 * `notification_policy_settings` is what `NotificationContextAssembler` reads to
 * decide the QUIET_HOURS_PENALTY component of a decision's score, so a
 * household with a narrow window scores its notifications differently from one
 * on the 21:00–07:00 default. Both shapes exist in the demo on purpose: the
 * scoring explanation on a decision row is one of the more interesting things
 * to look at, and a dataset where every family is configured identically shows
 * none of it.
 *
 * NOTE WHAT THIS DOES **NOT** DO. The DELIVERY layer's quiet hours come from
 * `DEFAULT_FATIGUE_POLICY` (21:00–07:00) in `notification-fatigue-guard.ts`, not
 * from this table — so a seed run at midnight still DEFERS its notifications,
 * correctly, into `notification_deliveries`. That is why `releaseDeferred()`
 * below exists: the sweep the scheduler runs at the end of quiet hours is run
 * here too, rather than the seed pretending quiet hours do not apply to it.
 */
async function seedNotificationPolicy(db: any, seeded: SeededFamily[]): Promise<void> {
  section('notification policy');
  let written = 0;
  for (const fam of seeded) {
    if (fam.spec.quietHours !== 'NARROW') continue;
    for (const [key, value] of [
      ['notification.quietHours.start', '03:00'],
      ['notification.quietHours.end', '03:30'],
    ] as const) {
      await asFamily(fam, () =>
        db.notificationPolicySetting.upsert({
          where: { familyId_key: { familyId: fam.familyId, key } },
          create: { familyId: fam.familyId, key, value, updatedBy: fam.ownerUserId },
          update: { value },
        }),
      );
      written += 1;
    }
  }
  const defaults = seeded.filter((f) => f.spec.quietHours === 'DEFAULT').length;
  console.log(`  quiet hours             · ${written} settings on ${written / 2} households; ${defaults} left on the 21:00–07:00 default`);
}

// ---- 5.6 install events ----------------------------------------------------

/**
 * The funnel's top MEASURED step is `APP_INSTALLED`, an ANONYMOUS analytics
 * event counted by DISTINCT SESSION because at install time no family exists.
 * The join to the rest of the funnel is `acquisition_attributions.session_id`,
 * which registration above already wrote — so the session ids here are the same
 * ones, plus a tail of sessions that installed and never registered, which is
 * what makes the INSTALL → REGISTRATION step a real drop rather than 100%.
 */
async function seedInstallEvents(db: any, seeded: SeededFamily[]): Promise<void> {
  section('funnel · installs');
  let written = 0;

  const write = async (sessionId: string, occurredAt: Date, countryCode: string | null): Promise<void> => {
    const sourceEventId = `${DEMO}-seed:install:${sessionId}`;
    const existing = await sys('looking up a demo install event', () =>
      db.analyticsEvent.findFirst({ where: { sourceEventId }, select: { id: true } }),
    );
    if (existing) return;
    await sys('recording a demo install event', () =>
      db.analyticsEvent.create({
        data: {
          familyId: null,
          userId: null,
          sessionId,
          eventName: 'APP_INSTALLED',
          payload: { demo: true, countryCode },
          occurredAt,
          sourceEventId,
        },
      }),
    );
    written += 1;
  };

  for (const fam of seeded) {
    await write(
      `${DEMO}-session-${fam.spec.slug}`,
      new Date(daysAgo(fam.spec.registeredDaysAgo).getTime() - 30 * 60 * 1000),
      fam.spec.market,
    );
  }
  // Installs that never became households — the honest top of the funnel.
  for (let i = 0; i < 40; i += 1) {
    const market = i % 3 === 0 ? 'SA' : 'EG';
    await write(`${DEMO}-session-lapsed-${String(i).padStart(2, '0')}`, daysAgo(2 + (i % HISTORY_DAYS)), market);
  }

  bump('analytics_events', written);
  console.log(`  analytics_events        · ${written} APP_INSTALLED sessions (${seeded.length} converted to a household)`);
}

// ---- 5.7 programs, attempts, and the real reward path ----------------------

/**
 * PROGRAMS AND ATTEMPTS, THROUGH THE REAL SERVICES.
 *
 * `RewardProgramService.create` validates the taxonomy, the target spec against
 * the REAL surah table, the reward spec including the screen-time ceiling and
 * the verification matrix — and materialises the companion `RewardRule` rows
 * that are what actually pay out. `AchievementService.start/submit/decide` then
 * moves an attempt through the real lifecycle and writes the outbox event that
 * the relay turns into a ledger entry.
 *
 * THE SPREAD OF STATES IS DELIBERATE, because a dashboard that only ever shows
 * VERIFIED tells you nothing about the queue:
 *   · VERIFIED       — auto (SELF_CHECK) and parent-approved
 *   · REJECTED       — a parent said "not yet"
 *   · PENDING_PARENT — sitting in a parent's queue right now
 *   · IN_PROGRESS    — started today, not submitted
 */
async function seedPrograms(
  db: any,
  programsSvc: any,
  achievements: any,
  seeded: SeededFamily[],
): Promise<void> {
  section('reward programs & achievements');
  let programCount = 0;
  const attemptStates: Record<string, number> = {};

  let cursor = 0;
  for (const fam of seeded) {
    for (const child of fam.children) {
      // Two programs per child, walking the catalogue so every category in it
      // is represented across the dataset.
      for (let k = 0; k < 2; k += 1) {
        const spec = PROGRAM_CATALOGUE[cursor % PROGRAM_CATALOGUE.length];
        cursor += 1;

        const existing = await asFamily(fam, () =>
            db.rewardProgram.findFirst({
              where: { familyId: fam.familyId, childId: child.id, category: spec.category, activity: spec.activity },
              select: { id: true },
            }),
        );

        let programId: string;
        if (existing) {
          programId = existing.id;
        } else {
          const created = await asFamily(fam, () =>
              programsSvc.create(fam.familyId, fam.ownerUserId, {
                childId: child.id,
                category: spec.category,
                activity: spec.activity,
                targetSpec: spec.targetSpec,
                durationMinutes: spec.durationMinutes,
                verificationLevel: spec.verificationLevel,
                rewardSpec: spec.rewardSpec,
                frequency: 'DAILY',
                maxPerDay: 1,
                maxPerWeek: 7,
                minAge: 0,
                difficulty: spec.difficulty,
                requiresParentApproval: spec.verificationLevel === 'PARENT_CONFIRMATION',
              }),
          );
          programId = created.id;
          programCount += 1;
        }

        // ---- attempts ----------------------------------------------------
        // Spread over the last two weeks. `maxPerDay: 1` and the
        // `(program, child, local_date, attempt_no)` unique key mean one
        // attempt per program per day, which is what the loop respects.
        const attemptDays = spec.verificationLevel === 'SELF_CHECK' ? [9, 7, 5, 3, 1] : [8, 4, 0];
        for (const [i, dayOffset] of attemptDays.entries()) {
          const startAt = new Date(daysAgo(dayOffset).getTime());
          startAt.setUTCHours(13, 0, 0, 0);
          const submitAt = new Date(startAt.getTime() + (spec.durationMinutes + 5) * 60_000);
          const localDate = dateColumn(startAt);

          const already = await asFamily(fam, () =>
              db.achievementRequest.findFirst({
                where: { programId, childId: child.id, localDate },
                select: { id: true, status: true },
              }),
          );
          if (already) {
            attemptStates[already.status] = (attemptStates[already.status] ?? 0) + 1;
            continue;
          }

          const state = await asFamily(fam, async () => {
              const attempt = await achievements.start(child.id, programId, startAt);

              // The most recent attempt of a parent-confirmed program is left
              // OPEN on purpose, so the parent's queue is not empty.
              if (dayOffset === 0) return 'IN_PROGRESS';

              await achievements.submit(child.id, attempt.id, { selfConfirmed: true }, submitAt);

              if (spec.verificationLevel === 'SELF_CHECK') return 'VERIFIED';

              // PARENT_CONFIRMATION always escalates; the parent then decides.
              // One in three is declined, which is what makes the REJECTED
              // path visible at all.
              if (i === 1) {
                // Left sitting in the parent's queue.
                const row = await db.achievementRequest.findUnique({
                  where: { id: attempt.id },
                  select: { status: true },
                });
                return row.status;
              }
              const approve = i !== 2;
              await achievements.decide(
                fam.ownerUserId,
                attempt.id,
                approve,
                approve ? 'DEMO — approved by the parent' : 'DEMO — needs another look',
                new Date(submitAt.getTime() + 30 * 60_000),
              );
              return approve ? 'VERIFIED' : 'REJECTED';
            },
          );
          attemptStates[state] = (attemptStates[state] ?? 0) + 1;
          bump('achievement_requests');
        }
      }
    }
  }

  bump('reward_programs', programCount);
  console.log(`  reward_programs         · ${programCount} created across ${new Set(PROGRAM_CATALOGUE.map((p) => p.category)).size} categories`);
  console.log(
    `  achievement_requests    · ${Object.entries(attemptStates).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}`,
  );
}

/**
 * THE OUTBOX RELAY, TICKED BY HAND.
 *
 * `main.ts` starts the relay on a timer; a seed has no timer and must not start
 * one (it would keep the process alive). `tick()` is the same method the e2e
 * suites drive, and it is what turns the `ACHIEVEMENT_VERIFIED` events written
 * above into the rows the dashboard reads: `rewards_ledger_entries` (via
 * `RewardsCompletionConsumer`), `life_timeline_events`, `family_activations`
 * (via the growth bridge) and `notification_decisions` / `notifications` /
 * `child_messages` (via the smart notification engine).
 *
 * Ticking to exhaustion, not a fixed number of times: a consumer's own writes
 * can enqueue further events, and stopping early would leave the demo half
 * processed in a way that looks like a bug in the reward engine.
 */
async function drainOutbox(relay: any): Promise<void> {
  section('outbox relay');
  let published = 0;
  let failed = 0;
  for (let i = 0; i < 200; i += 1) {
    const tick = await relay.tick(200);
    published += tick.published;
    failed += tick.failed;
    if (tick.claimed === 0) break;
  }
  bump('outbox_published', published);
  console.log(`  outbox_messages         · ${published} published${failed > 0 ? `, ${failed} failed` : ''} — ledger, timeline, activations and notifications produced by the real consumers`);
}

/**
 * THE QUIET-HOURS RELEASE SWEEP, RUN AS THOUGH IT WERE MORNING.
 *
 * A notification produced during a household's quiet hours is DEFERRED, not
 * dropped: it lands in `notification_deliveries` with a `deliver_after` at the
 * end of that household's quiet window, and `QuietHoursReleaseService.sweep` —
 * the scheduler's `notification-delivery-sweep` job — is what turns it into a
 * `notifications` or `child_messages` row when morning comes.
 *
 * A seed run at 23:00 would otherwise leave the notification panels at zero and
 * a reader would reasonably conclude the notification engine is broken, when in
 * fact it is working exactly as designed. So the sweep is called here with a
 * `now` set to TOMORROW MORNING, which is the moment the scheduler would have
 * called it. Nothing is bypassed: the release re-evaluates fatigue, respects
 * the daily and per-category caps, and refuses anything a cap refuses — the
 * demo simply does not make the owner wait until 07:00 to see the result.
 *
 * Run at a time of day when nothing was deferred, this releases nothing and
 * prints zero, which is also correct.
 *
 * SWEPT TO EXHAUSTION, not once. One `sweep` handles a bounded batch of
 * households, and a release can itself re-defer (the caps still apply), so a
 * single call leaves work behind — and that leftover is what a SECOND run of
 * this seed would pick up, which is how «re-running it changed the counts»
 * happens without anything being duplicated. Draining here makes the notification
 * tables a fixed point instead.
 */
async function releaseDeferred(release: any): Promise<void> {
  section('deferred notifications');
  const morning = new Date(now.getTime() + DAY_MS);
  morning.setUTCHours(9, 0, 0, 0);

  const total = { claimed: 0, delivered: 0, digested: 0, digests: 0, capped: 0, coalesced: 0, failed: 0 };
  for (let i = 0; i < 50; i += 1) {
    const report = await release.sweep(morning);
    if (report.claimed === 0) break;
    total.claimed += report.claimed;
    total.delivered += report.delivered;
    total.digested += report.digested;
    total.digests += report.digests;
    total.capped += report.capped;
    total.coalesced += report.coalesced;
    total.failed += report.failed;
  }
  bump('notifications_released', total.delivered);
  console.log(
    `  quiet-hours release     · ${total.claimed} claimed — ` +
      `${total.delivered} delivered · ${total.digested} folded into ${total.digests} digests · ` +
      `${total.capped} held by a cap · ${total.coalesced} coalesced${total.failed ? ` · ${total.failed} failed` : ''}`,
  );
}

// ---- 5.8 redemptions, child messages ---------------------------------------

/**
 * THE FAMILY STORE, EARNED COINS, AND A REAL REDEMPTION — all through
 * `RewardsEngineService`, which is the only thing in this product allowed to
 * move a child's balance.
 *
 * WHY COINS NEED THEIR OWN TRIGGER. A reward PROGRAM can pay POINTS,
 * SCREEN_TIME, a privilege or a physical reward (`PROGRAM_REWARD_TYPES`) — but
 * not COINS, and the store is priced in coins. Coins come from the sixteen
 * PLATFORM `reward_rules` migration 0007 seeded, e.g. «سلسلة عادات متصلة» pays
 * 15 COINS on `habit-builder / STREAK_ACHIEVED`. So a streak is triggered
 * through `RewardsEngineService.trigger`, the real rule engine matches the real
 * rule, and the ledger EARN row is written by the same code a real streak
 * would write it with. The `idempotencyKey` is deterministic, so the ledger's
 * own `(child_id, idempotency_key)` UNIQUE makes a second run a no-op.
 *
 * THEN THE REDEMPTION IS REAL TOO: `requestRedemption` (which deliberately
 * allows a child to ask while short on coins) followed by `approveRedemption`,
 * which is the call that checks the balance, writes the REDEEM ledger row and
 * debits the account — atomically, in one transaction. That REDEEM row is what
 * the market panel's «rewardsRedeemed» counts.
 *
 * Parent-authored `child_messages` carry a NULL `source_event_id` — the
 * schema's own way of saying «a human wrote this», and the reason they are not
 * deduplicated the way machine-generated ones are. They are keyed here on a
 * deterministic title so a re-run does not write a second copy.
 */
async function seedRedemptionsAndMessages(db: any, rewards: any, seeded: SeededFamily[]): Promise<void> {
  section('family store & redemptions');
  let items = 0;
  let coinGrants = 0;
  let requested = 0;
  let approved = 0;
  let messages = 0;

  const STORE_COST_COINS = 30;

  for (const fam of seeded) {
    if (fam.children.length === 0) continue;

    const title = 'DEMO — ساعة لعب إضافية';
    let item = await asFamily(fam, () =>
      db.rewardCatalogItem.findFirst({ where: { familyId: fam.familyId, title }, select: { id: true } }),
    );
    if (!item) {
      item = await asFamily(fam, () =>
        db.rewardCatalogItem.create({
          data: {
            familyId: fam.familyId,
            title,
            costCoins: STORE_COST_COINS,
            createdByUserId: fam.ownerUserId,
            isActive: true,
          },
          select: { id: true },
        }),
      );
      items += 1;
    }

    // Parent-authored encouragement.
    for (const [i, kid] of fam.children.entries()) {
      const exists = await asFamily(fam, () =>
        db.childMessage.findFirst({
          where: { childId: kid.id, title: 'DEMO — رسالة من ولي الأمر' },
          select: { id: true },
        }),
      );
      if (exists) continue;
      await asFamily(fam, () =>
        db.childMessage.create({
          data: {
            familyId: fam.familyId,
            childId: kid.id,
            fromUserId: fam.ownerUserId,
            authorType: 'PARENT',
            approvalStatus: 'NOT_REQUIRED',
            category: 'ENCOURAGEMENT',
            title: 'DEMO — رسالة من ولي الأمر',
            body: 'DEMO — أحسنت! استمر على هذا المستوى.',
            deliveredAt: daysAgo(1 + i),
            createdAt: daysAgo(1 + i),
            sourceEventId: null,
          },
        }),
      );
      messages += 1;
    }

    // Only households whose devices are actually alive get a streak; a dormant
    // household that kept earning coins would be a contradiction on the page.
    if (fam.spec.lastSeenDaysAgo === null || fam.spec.lastSeenDaysAgo > 7) continue;

    const child = fam.children[0];

    // Two streak grants → 30 coins, exactly the store price. Real rule, real
    // ledger, deterministic key.
    for (const streakDays of [7, 14]) {
      const granted = await asFamily(fam, () =>
        rewards.trigger(child.id, fam.familyId, {
          engine: 'habit-builder',
          type: 'STREAK_ACHIEVED',
          payload: { streakDays },
          idempotencyKey: `${DEMO}-seed:streak:${fam.spec.slug}:${streakDays}`,
        }),
      );
      coinGrants += granted;
    }

    const openRedemption = await asFamily(fam, () =>
      db.rewardRedemption.findFirst({
        where: { childId: child.id, rewardCatalogItemId: item.id },
        select: { id: true, status: true },
      }),
    );
    let redemptionId = openRedemption?.id ?? null;
    if (!redemptionId) {
      const created = await asFamily(fam, () =>
        rewards.requestRedemption(child.id, fam.familyId, item.id),
      );
      redemptionId = created.id;
      requested += 1;
    }

    // Half the requests are approved (a REDEEM ledger row and a real debit);
    // the rest are left in the parent's queue, which is where a queue panel
    // gets something to show.
    const shouldApprove = fam.spec.slug.charCodeAt(fam.spec.slug.length - 1) % 2 === 0;
    if (shouldApprove && (openRedemption?.status ?? 'REQUESTED') === 'REQUESTED') {
      try {
        await asFamily(fam, () => rewards.approveRedemption(redemptionId, fam.familyId, fam.ownerUserId));
        approved += 1;
      } catch {
        // Not enough coins — an honest outcome, not a seed failure. The
        // request stays in the queue exactly as it would in production.
      }
    }

  }

  bump('reward_catalog_items', items);
  bump('reward_redemptions', requested);
  bump('child_messages', messages);
  console.log(`  reward_catalog_items    · ${items} created (${STORE_COST_COINS} coins each)`);
  console.log(`  coin grants             · ${coinGrants} ledger EARN rows from the platform streak rule`);
  console.log(`  reward_redemptions      · ${requested} requested · ${approved} approved (a REDEEM row and a real debit)`);
  console.log(`  child_messages          · ${messages} parent-authored (machine-generated ones came from the relay)`);
}

// ---- 5.9 support -----------------------------------------------------------

/** `dashboard-metrics` reports support requests in the last 7 days. */
async function seedSupportRequests(db: any, seeded: SeededFamily[]): Promise<void> {
  section('support');
  let written = 0;
  const subjects = [
    'DEMO — لا أستطيع إقران جهاز ابني',
    'DEMO — سؤال عن الفاتورة',
    'DEMO — كيف أضيف طفلًا ثانيًا؟',
    'DEMO — طلب استرداد',
    'DEMO — اقتراح لبرنامج مكافآت',
  ];
  for (const [i, subject] of subjects.entries()) {
    const fam = seeded[i % seeded.length];
    const existing = await sys('looking up a demo support request', () =>
      db.supportRequest.findFirst({ where: { subject }, select: { id: true } }),
    );
    if (existing) continue;
    await sys('creating a demo support request', () =>
      db.supportRequest.create({
        data: {
          familyId: fam.familyId,
          userId: fam.ownerUserId,
          email: demoEmail(fam.spec.slug, 'parent1'),
          subject,
          message: 'رسالة تجريبية من بذرة العرض التوضيحي — لا تحتاج إلى رد.',
          isPriority: i % 3 === 0,
          createdAt: daysAgo(i % 6),
        },
      }),
    );
    written += 1;
  }
  bump('support_requests', written);
  console.log(`  support_requests        · ${written} created (all inside the last 7 days)`);
}

// ---- 5.10 referrals --------------------------------------------------------

/**
 * REFERRALS, THROUGH THE REAL SERVICES. `ensureCode` mints the household's
 * one-per-lifetime code, `recordSent` logs an invitation on a channel (rate
 * limited, and the refusal is itself recorded), and `ReferralRewardService`'s
 * sweep is what QUALIFIES a referral once the referred household's payment has
 * survived the refund window — the same sweep the scheduler runs.
 *
 * `recordSent` composes a RANDOM idempotency key, so it is not itself
 * re-runnable; the guard is the count check below, not a key.
 */
async function seedReferrals(db: any, referrals: any, referralRewards: any, seeded: SeededFamily[]): Promise<void> {
  section('referrals');
  let codes = 0;
  let sent = 0;

  for (const fam of seeded) {
    if (fam.spec.market === null) continue;
    const code = await asFamily(fam, () => referrals.ensureCode(fam.familyId, fam.ownerUserId),
    );
    if (code) codes += 1;

    const already = await asFamily(fam, () => db.referralEvent.count({ where: { familyId: fam.familyId, kind: 'SENT' } }),
    );
    if (already === 0) {
      for (const channel of ['OTHER', 'INSTAGRAM'] as const) {
        await asFamily(fam, () =>
          referrals.recordSent(fam.familyId, fam.ownerUserId, channel),
        );
        sent += 1;
      }
    }
  }

  // FOUR REAL BINDINGS, AND THE SPLIT IS THE POINT. Every referred household
  // below registered with the channel REFERRAL, and is bound to a referrer that
  // actually exists.
  //
  //   eg-06 / sa-04 paid more than the 14-day refund window ago, so the sweep
  //     QUALIFIES them and a `referral_rewards` row is created and fulfilled.
  //   eg-12 / sa-09 are still on trial and have paid nothing, so the sweep
  //     returns a reason and a `qualifiesAt` instead — a referral that is
  //     REGISTERED but not yet earned, which is the state most referrals are in
  //     at any moment and the one a panel showing only payouts would hide.
  const pairs: Array<[string, string]> = [
    ['eg-01', 'eg-06'],
    ['eg-03', 'eg-12'],
    ['sa-01', 'sa-04'],
    ['sa-02', 'sa-09'],
  ];
  let bound = 0;
  for (const [referrerSlug, referredSlug] of pairs) {
    const referrer = seeded.find((f) => f.spec.slug === referrerSlug);
    const referred = seeded.find((f) => f.spec.slug === referredSlug);
    if (!referrer || !referred) continue;
    const referrerCode = await sys('reading a demo referral code', () =>
      db.referralCode.findFirst({ where: { familyId: referrer.familyId }, select: { code: true } }),
    );
    if (!referrerCode) continue;

    // RE-RUN GUARD, AND IT MATTERS MORE THAN IT LOOKS. `registerReferral` keeps
    // its refusals — «this household is already referred» is written as a
    // REJECTED row on purpose, because a system that discards its refusals
    // cannot see fraud. Calling it twice is therefore not a no-op: it is one
    // more honest rejection per run, and the demo would accumulate them. So
    // the binding is attempted only when this household has never been bound.
    const alreadyBound = await sys('checking whether a demo referral is already bound', () =>
      db.referralEvent.findFirst({
        where: { referredFamilyId: referred.familyId, kind: 'REGISTERED' },
        select: { id: true },
      }),
    );
    if (alreadyBound) continue;

    const outcome = await referrals.registerReferral(referred.familyId, referrerCode.code);
    if (outcome.bound) bound += 1;
  }

  const qualified = await referralRewards.sweep(now, 200);

  bump('referral_codes', codes);
  bump('referral_events', sent + bound);
  console.log(`  referral_codes          · ${codes} households have a code`);
  console.log(`  referral_events         · ${sent} SENT · ${bound} REGISTERED · ${qualified.length} evaluated for qualification`);
}

// ---- 5.11 campaigns --------------------------------------------------------

/**
 * Campaigns and their daily spend, through `CampaignService`. Spend import is
 * idempotent on `(campaign, business_date)` by the schema's own unique key, so
 * a re-run corrects a day rather than doubling it — which would have halved the
 * reported CAC in the flattering direction.
 *
 * Impressions/clicks/visits/leads are EXTERNALLY REPORTED numbers; the funnel
 * API tags those steps as such, and the shapes below are chosen to be plausible
 * rather than flattering.
 */
async function seedCampaigns(db: any, campaigns: any, seeded: SeededFamily[]): Promise<void> {
  section('campaigns & spend');
  const operator = seeded[0]?.ownerUserId ?? null;
  let created = 0;
  let spendDays = 0;

  for (const c of CAMPAIGNS) {
    const name = `DEMO — ${c.nameAr}`;
    let campaign = await sys('looking up a demo campaign', () =>
      db.growthCampaign.findFirst({ where: { name, countryCode: c.countryCode }, select: { id: true } }),
    );
    if (!campaign) {
      campaign = await campaigns.create(
        {
          name,
          channel: c.channel,
          countryCode: c.countryCode,
          budgetMinor: c.budgetMinor,
          currencyCode: c.currencyCode,
          startsAt: daysAgo(c.startsDaysAgo),
          endsAt: new Date(now.getTime() + c.endsInDays * DAY_MS),
          targetUsers: c.targetUsers,
          targetPaidUsers: c.targetPaidUsers,
          utmCampaign: c.slug,
          notes: 'DEMO — بيانات تجريبية من بذرة العرض التوضيحي.',
        },
        operator,
      );
      created += 1;
    }

    for (let d = c.startsDaysAgo; d >= 1; d -= 1) {
      // A deterministic, dull weekly shape — no randomness, so two runs agree.
      const wobble = 100 + ((d % 7) - 3) * 6;
      const spendMinor = Math.round((c.dailySpendMinor * wobble) / 100);
      await campaigns.recordSpend(campaign.id, {
        businessDate: dateColumn(daysAgo(d)),
        spendMinor,
        impressions: spendMinor * 4,
        clicks: Math.round(spendMinor / 60),
        visits: Math.round(spendMinor / 120),
        leads: Math.round(spendMinor / 900),
      });
      spendDays += 1;
    }
  }

  bump('growth_campaigns', created);
  bump('campaign_daily_spend', spendDays);
  console.log(`  growth_campaigns        · ${created} created (2 EG in EGP, 2 SA in SAR)`);
  console.log(`  campaign_daily_spend    · ${spendDays} day-rows upserted`);
}

// ---- 5.12 targets & scenarios ----------------------------------------------

/**
 * TARGETS ARE INPUTS A HUMAN WROTE, and the quarterly view renders `target`,
 * `actual` and `forecast` as three separate fields — never one `value`. Both
 * writes are upserts keyed by the schema's own unique constraints.
 */
async function seedTargetsAndScenarios(forecast: any, seeded: SeededFamily[]): Promise<void> {
  section('targets & forecast scenarios');
  const operator = seeded[0]?.ownerUserId ?? null;
  const year = now.getUTCFullYear();

  const targets: Record<'EG' | 'SA', Array<[string, number, string | null]>> = {
    EG: [
      ['USERS', 40, null],
      ['PAID_USERS', 12, null],
      ['REVENUE_MINOR', 500_000, 'EGP'],
      ['MRR_MINOR', 90_000, 'EGP'],
      ['SUBSCRIPTIONS', 12, null],
      ['CAC_MINOR', 40_000, 'EGP'],
      ['CHURN_RATE', 0.06, null],
    ],
    SA: [
      ['USERS', 30, null],
      ['PAID_USERS', 9, null],
      ['REVENUE_MINOR', 140_000, 'SAR'],
      ['MRR_MINOR', 22_000, 'SAR'],
      ['SUBSCRIPTIONS', 9, null],
      ['CAC_MINOR', 9_000, 'SAR'],
      ['CHURN_RATE', 0.05, null],
    ],
  };

  let written = 0;
  for (const country of ['EG', 'SA'] as const) {
    for (let quarter = 1; quarter <= 4; quarter += 1) {
      for (const [metric, base, currency] of targets[country]) {
        // A gently rising plan across the year — a flat target across four
        // quarters is not a plan, it is a placeholder.
        const value = metric === 'CHURN_RATE' ? base : Math.round(base * (0.7 + quarter * 0.1) * 100) / 100;
        await forecast.setTarget(
          country,
          year,
          quarter as 1 | 2 | 3 | 4,
          metric as any,
          value,
          currency,
          operator,
          'DEMO — هدف تجريبي من بذرة العرض التوضيحي.',
        );
        written += 1;
      }
    }
  }

  const scenarios: Array<{
    scenario: 'CONSERVATIVE' | 'BASE' | 'AGGRESSIVE';
    countryCode: 'EG' | 'SA';
    currencyCode: 'EGP' | 'SAR';
    monthlyAcquisition: number;
    conversionRate: number;
    paidConversionRate: number;
    churnRate: number;
    arpuMinor: number;
    cacMinor: number;
    retentionD30: number;
  }> = [
    { scenario: 'CONSERVATIVE', countryCode: 'EG', currencyCode: 'EGP', monthlyAcquisition: 400, conversionRate: 0.3, paidConversionRate: 0.2, churnRate: 0.09, arpuMinor: 17_000, cacMinor: 26_000, retentionD30: 0.3 },
    { scenario: 'BASE', countryCode: 'EG', currencyCode: 'EGP', monthlyAcquisition: 700, conversionRate: 0.38, paidConversionRate: 0.28, churnRate: 0.06, arpuMinor: 19_900, cacMinor: 22_000, retentionD30: 0.4 },
    { scenario: 'AGGRESSIVE', countryCode: 'EG', currencyCode: 'EGP', monthlyAcquisition: 1_100, conversionRate: 0.45, paidConversionRate: 0.34, churnRate: 0.05, arpuMinor: 22_000, cacMinor: 19_000, retentionD30: 0.48 },
    { scenario: 'CONSERVATIVE', countryCode: 'SA', currencyCode: 'SAR', monthlyAcquisition: 250, conversionRate: 0.32, paidConversionRate: 0.24, churnRate: 0.08, arpuMinor: 4_200, cacMinor: 7_500, retentionD30: 0.34 },
    { scenario: 'BASE', countryCode: 'SA', currencyCode: 'SAR', monthlyAcquisition: 450, conversionRate: 0.4, paidConversionRate: 0.32, churnRate: 0.05, arpuMinor: 4_900, cacMinor: 6_500, retentionD30: 0.45 },
    { scenario: 'AGGRESSIVE', countryCode: 'SA', currencyCode: 'SAR', monthlyAcquisition: 700, conversionRate: 0.47, paidConversionRate: 0.38, churnRate: 0.04, arpuMinor: 5_600, cacMinor: 5_800, retentionD30: 0.52 },
  ];
  for (const s of scenarios) {
    await forecast.upsertScenario(s as any, operator);
  }

  bump('growth_quarterly_targets', written);
  bump('growth_forecast_scenarios', scenarios.length);
  console.log(`  growth_quarterly_targets· ${written} upserted (2 markets × 4 quarters × 7 metrics)`);
  console.log(`  growth_forecast_scenarios· ${scenarios.length} upserted (Conservative / Base / Aggressive per market)`);
}

// ---- 5.13 activations ------------------------------------------------------

/**
 * ACTIVATION IS PRODUCED BY THE RELAY, NOT BY THIS SCRIPT — `ActivationService`
 * is driven by `REWARD_GRANTED`, which only fires after the LEDGER confirms a
 * grant, and it applies three gates of its own (including "was this child added
 * long enough ago that this is not a demonstration"). Everything above is
 * arranged so those gates pass honestly: children are backdated to their
 * household's registration day, and their attempts are days later.
 *
 * WHAT THIS STEP DOES is only to BACKDATE the activation rows the relay just
 * wrote, so time-to-value and the activation trend are spread across the
 * history window instead of all landing on today. `occurred_at` is moved to the
 * day the attempt it came from was verified; `time_to_value_minutes` is
 * recomputed from `families.created_at` so the stored fact stays internally
 * consistent (the column has a non-negative CHECK, and a negative
 * time-to-value is a clock bug, not a fast family).
 */
async function seedActivations(db: any, seeded: SeededFamily[]): Promise<void> {
  section('activations');
  let moved = 0;
  for (const fam of seeded) {
    const activation = await sys('reading a demo activation', () =>
      db.familyActivation.findUnique({
        where: { familyId: fam.familyId },
        select: { id: true, occurredAt: true },
      }),
    );
    if (!activation) continue;

    const firstVerified = await sys('reading the first verified demo attempt', () =>
      db.achievementRequest.findFirst({
        where: { familyId: fam.familyId, status: 'VERIFIED' },
        orderBy: { decidedAt: 'asc' },
        select: { decidedAt: true },
      }),
    );
    const occurredAt = firstVerified?.decidedAt ?? activation.occurredAt;
    const registeredAt = daysAgo(fam.spec.registeredDaysAgo);
    const minutes = Math.max(0, Math.round((occurredAt.getTime() - registeredAt.getTime()) / 60_000));
    if (minutes === 0) continue;

    await sys('backdating a demo activation', () =>
      db.familyActivation.update({
        where: { id: activation.id },
        data: { occurredAt, timeToValueMinutes: minutes, createdAt: occurredAt },
      }),
    );
    moved += 1;
  }
  bump('family_activations', moved);
  console.log(`  family_activations      · ${moved} produced by the reward path, dated to their own first verified goal`);
}

// ---- 5.14 daily aggregation ------------------------------------------------

/**
 * THE DAILY AGGREGATE, COMPUTED BY THE REAL JOB, ONE DAY AT A TIME.
 *
 * `GrowthAggregationService.run(now)` closes the day that has ENDED on each
 * country's own calendar, so walking `now` backwards through the history window
 * produces the same rows the scheduler would have produced had it been running
 * all along. It is an UPSERT on `(business_date, country_code)`, which is what
 * makes running this script twice correct one row per day rather than double
 * every number on it.
 */
async function runDailyAggregation(aggregation: any): Promise<void> {
  section('daily aggregation');
  const started = Date.now();
  let rows = 0;
  for (let d = HISTORY_DAYS; d >= 0; d -= 1) {
    const outcomes = await aggregation.run(daysAgo(d));
    rows += outcomes.length;
  }
  bump('growth_daily_metrics', rows);
  console.log(
    `  growth_daily_metrics    · ${HISTORY_DAYS + 1} days × 3 scopes (EG, SA, platform «**») recomputed in ${Math.round((Date.now() - started) / 1000)}s`,
  );
}

/** The same scan the scheduler runs; the unique key makes it one alert per day per scope. */
async function runAlertScan(alerts: any): Promise<void> {
  const raised = await alerts.scan(now);
  const created = raised.filter((r: any) => r.created).length;
  bump('growth_alerts', created);
  console.log(`  growth_alerts           · ${created} raised by the real scan (${raised.length - created} already present today)`);
}

// ---- 5.15 the report -------------------------------------------------------

/** Reads the tables back and prints what is actually there — not what was intended. */
async function report(db: any): Promise<void> {
  section('what is in the database now');

  const count = (model: string, where: Record<string, unknown> = {}): Promise<number> =>
    sys(`counting ${model}`, () => (db as any)[model].count({ where }));

  const [
    families, egFamilies, saFamilies, nullFamilies,
    users, childrenCount, devices, activeDevices,
    subs, trials, payments, invoices, entitlements,
    programs, attempts, verified, ledger, timeline,
    notifications, childMessages, decisions,
    pilotInvites, pilotRedeemed, campaignsN, spendN, dailyN, targetsN, scenariosN, alertsN,
    referralCodes, referralEvents, supportN, activationsN,
  ] = await Promise.all([
    count('family'), count('family', { countryCode: 'EG' }), count('family', { countryCode: 'SA' }), count('family', { countryCode: null }),
    count('user'), count('child'), count('device'), count('device', { lastSeenAt: { gte: daysAgo(7) } }),
    count('subscription'), count('trial'), count('paymentTransaction'), count('invoice'), count('entitlement'),
    count('rewardProgram'), count('achievementRequest'), count('achievementRequest', { status: 'VERIFIED' }),
    count('rewardsLedgerEntry'), count('lifeTimelineEvent'),
    count('notification'), count('childMessage'), count('notificationDecision'),
    count('pilotInvite'), count('pilotInvite', { redeemedAt: { not: null } }),
    count('growthCampaign'), count('campaignDailySpend'), count('growthDailyMetric'),
    count('growthQuarterlyTarget'), count('growthForecastScenario'), count('growthAlert'),
    count('referralCode'), count('referralEvent'), count('supportRequest'), count('familyActivation'),
  ]);

  const subsByStatus = await sys('grouping subscriptions', () =>
    db.subscription.groupBy({ by: ['status', 'currencyCode'], _count: { _all: true } }),
  );

  const money = await sys('summing revenue per currency', () =>
    db.paymentTransaction.groupBy({
      by: ['currency'],
      where: { status: 'SUCCEEDED' },
      _sum: { netAmountMinor: true, grossAmountMinor: true },
    }),
  );

  const line = (label: string, value: string | number): void =>
    console.log(`  ${label.padEnd(26)}${value}`);

  line('families', `${families}  (EG ${egFamilies} · SA ${saFamilies} · no country ${nullFamilies})`);
  line('users', users);
  line('children', childrenCount);
  line('devices', `${devices}  (${activeDevices} seen in the last 7 days)`);
  line('subscriptions', subs);
  for (const row of subsByStatus) {
    line(`  ${row.status}`, `${row._count._all}  ${row.currencyCode ?? '(no currency)'}`);
  }
  line('trials', trials);
  line('payment_transactions', payments);
  for (const row of money) {
    line(`  net revenue ${row.currency}`, `${row._sum.netAmountMinor} minor units (gross ${row._sum.grossAmountMinor})`);
  }
  line('invoices', invoices);
  line('entitlements', entitlements);
  line('reward_programs', programs);
  line('achievement_requests', `${attempts}  (${verified} VERIFIED)`);
  line('rewards_ledger_entries', ledger);
  line('life_timeline_events', timeline);
  line('notifications', notifications);
  line('child_messages', childMessages);
  line('notification_decisions', decisions);
  line('family_activations', activationsN);
  line('pilot_invites', `${pilotInvites}  (${pilotRedeemed} redeemed, ${pilotInvites - pilotRedeemed} open)`);
  line('growth_campaigns', campaignsN);
  line('campaign_daily_spend', spendN);
  line('growth_daily_metrics', dailyN);
  line('growth_quarterly_targets', targetsN);
  line('growth_forecast_scenarios', scenariosN);
  line('growth_alerts', alertsN);
  line('referral_codes', referralCodes);
  line('referral_events', referralEvents);
  line('support_requests', supportN);

  console.log(
    [
      '',
      '  Every household above is synthetic. To find them all:',
      `      SELECT * FROM users WHERE email LIKE '%@${EMAIL_DOMAIN}';`,
      "      SELECT * FROM families WHERE name LIKE 'DEMO-%';",
      '',
      '  ⚠ The price list this seed wrote is PLACEHOLDER pricing, not a pricing decision.',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  console.error('\n  ✗ The demo seed failed. Nothing is half-written that a re-run will not fix.\n');
  console.error(err);
  process.exit(1);
});
