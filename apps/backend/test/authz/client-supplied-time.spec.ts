/**
 * PHASE E (P0.4) — NO ENDPOINT MAY QUIETLY START TRUSTING THE CLIENT'S CLOCK.
 *
 * Three of Phase C's critical findings were the same defect wearing different
 * clothes: `PC-B-003` (a child forging `date` on an activity log and minting a
 * 30-day streak), `PC-B-005` (a child forging `verifiedBy: 'PARENT'`), and
 * `PA-B-002` (quiet hours evaluated on the container's wall clock). Each was
 * closed by hand, at one call site, with a test that proves THAT call site.
 *
 * None of those tests can fail because of an endpoint written tomorrow. That is
 * the gap this file exists for, and it is the fourth reason the brief lists
 * P0.4 as a re-verification rather than a fix: the property is «no path accepts
 * a client-supplied business date», and a property about ALL paths cannot be
 * proven by any number of tests about particular paths.
 *
 * SO THIS IS A STATIC SWEEP, and it fails CLOSED. Every field in every
 * `*.dto.ts` whose NAME says it carries a time — a date, an instant, a wall
 * clock, a zone — must appear in the table below with a written sentence
 * saying how the server neutralises it. A new endpoint that adds one and does
 * not classify it turns this suite red, and the author has to write the
 * sentence before the pipeline is green.
 *
 * SAME SHAPE, DELIBERATELY, as the two guards this codebase already trusts:
 * `retention-targets.spec.ts` reads every `action:` literal in `src/` and
 * refuses an unclassified audit prefix; `notification-class.spec.ts` reads
 * every notification type and refuses an unclassified one. This is that
 * discipline applied to the axis Phase C found three critical bugs on.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

/**
 * THE VOCABULARY OF TIME, as field names in this codebase actually spell it.
 *
 * Deliberately a NAME test and not a TYPE test. A type test would miss
 * `date!: string` — which is how every one of these is actually declared, and
 * how `PC-B-003` looked on the wire. A name test over-matches instead of
 * under-matching, and over-matching costs one line in a table while
 * under-matching costs a streak nobody earned.
 */
const TIME_FIELD = /^date|^timezone$|^timestamp$|(Date|At|Time)$|^(sleep|bedtime)(Start|End)$/;

/** How the server refuses to take the value at face value. */
type Disposition =
  /** The server computes the business date itself; the wire value is ignored entirely. */
  | 'SERVER_DERIVED'
  /** Only a PARENT may set it, and only inside bounds the server enforces (no future, no further back than the scoring window). */
  | 'PARENT_ONLY_BOUNDED'
  /** Stored for diagnostics and never read by any decision. */
  | 'TELEMETRY_ONLY'
  /** Not a business date at all — a configuration value, a profile attribute or a wall-clock schedule. */
  | 'NOT_A_BUSINESS_DATE';

interface ClientTimeField {
  readonly dto: string;
  readonly field: string;
  readonly disposition: Disposition;
  /** Required. This is the deliverable — the classification without it is a checkbox. */
  readonly why: string;
}

const CLASSIFIED: readonly ClientTimeField[] = [
  // ---- SERVER_DERIVED: the wire value cannot reach a decision -------------
  {
    dto: 'LogActivityDto',
    field: 'date',
    disposition: 'SERVER_DERIVED',
    why:
      'THE `PC-B-003` FIELD. A child posting `date: "2026-07-01"` thirty times minted a thirty-day streak. `HealthEngineService.logActivity` takes an `actor` argument that defaults to `DEVICE`, and on the DEVICE path the DTO date is discarded in favour of `FamilyDateService`. The field survives on the wire only because the PARENT surface shares the DTO.',
  },
  {
    dto: 'LogLearningSessionDto',
    field: 'date',
    disposition: 'SERVER_DERIVED',
    why:
      'Same gate as LogActivityDto, in `LearningEngineService.logSession`: `actor` defaults to DEVICE and the DEVICE path resolves the date from the family calendar.',
  },
  {
    dto: 'LogNutritionDto',
    field: 'date',
    disposition: 'SERVER_DERIVED',
    why: 'Same gate as LogActivityDto — the nutrition path in `HealthEngineService` resolves the business date through the same actor-aware helper.',
  },
  {
    dto: 'LogSleepDto',
    field: 'date',
    disposition: 'SERVER_DERIVED',
    why:
      'Same gate as LogActivityDto: the sleep log is dated by `HealthEngineService` on the family calendar, and the DEVICE path never reads the wire value.',
  },
  {
    dto: 'RecordDailyUsageSummaryDto',
    field: 'usageDate',
    disposition: 'SERVER_DERIVED',
    why:
      'The daily wellbeing upload. It names the day the DEVICE aggregated locally, and no reward, streak or ledger key is derived from it: `recordDailySummary` upserts a snapshot and runs the deterministic detection pipeline, neither of which mints anything. The one thing that IS minted on this path — a critical-event notification — takes its instant from the server (`recordCriticalEvent`, PHASE E).',
  },

  // ---- PARENT_ONLY_BOUNDED: a parent may back-date, inside bounds ---------
  {
    dto: 'CompleteHabitDto',
    field: 'date',
    disposition: 'PARENT_ONLY_BOUNDED',
    why:
      'A parent legitimately logs a missed day after the fact. `HabitEngineService.resolveCompletionDate` (B1 / `PA-B-004`) is the ONLY door: it refuses any actor other than PARENT, clamps the future to today, and clamps the past to the scoring window, so back-dating can neither pre-mint keys for days that have not happened nor widen the key space beyond the window that can still score.',
  },
  {
    dto: 'LogFaithPracticeDto',
    field: 'date',
    disposition: 'PARENT_ONLY_BOUNDED',
    why: 'Same helper, same bounds, in `FaithEngineService.logPractice`; `actor` defaults to DEVICE so a route that forgets to pass one fails closed.',
  },

  // ---- TELEMETRY_ONLY: recorded, never consulted --------------------------
  {
    dto: 'WireEventDto',
    field: 'localDate',
    disposition: 'TELEMETRY_ONLY',
    why:
      'Survives as `clientReportedLocalDate` in the event metadata for diagnosing device clock skew. `EventIngestionService` derives the real business date with `getBusinessDate(occurredAt, Family.timezone)`, so this value reaches no rule, no cap and no key.',
  },
  {
    dto: 'WireEventDto',
    field: 'occurredAt',
    disposition: 'TELEMETRY_ONLY',
    why:
      'The device instant, and the one client-supplied time this system does read — from which the server, not the client, derives the business date on `Family.timezone`. An instant is checkable (it is bounded by the ingestion window); a business DATE is an assertion about which day a thing belongs to, and that assertion is never accepted.',
  },
  {
    dto: 'WireEventDto',
    field: 'timezone',
    disposition: 'TELEMETRY_ONLY',
    why:
      'The zone the DEVICE believes it is in. Recorded; never substituted for `Family.timezone`, which is the only zone any daily boundary is computed on.',
  },
  {
    dto: 'IngestEventsDto',
    field: 'deviceTime',
    disposition: 'TELEMETRY_ONLY',
    why: 'Batch-level device clock reading, kept precisely so clock skew is measurable rather than invisible. No decision reads it.',
  },

  // ---- NOT_A_BUSINESS_DATE: configuration, profile, wall-clock schedule ---
  {
    dto: 'RegisterDto',
    field: 'timezone',
    disposition: 'NOT_A_BUSINESS_DATE',
    why: 'Sets `Family.timezone` — the value every daily boundary in this system is computed FROM. Setting it is a parent action on the family record, not a claim about what day it is.',
  },
  {
    dto: 'UpdateProfileDto',
    field: 'timezone',
    disposition: 'NOT_A_BUSINESS_DATE',
    why: 'A user profile preference. Not read by `FamilyDateService`, which reads the FAMILY zone.',
  },
  {
    dto: 'UpdateSettingsDto',
    field: 'timezone',
    disposition: 'NOT_A_BUSINESS_DATE',
    why: 'The family setting behind `Family.timezone`; a parent-surface configuration change, audited like any other.',
  },
  {
    dto: 'CreateChildDto',
    field: 'dateOfBirth',
    disposition: 'NOT_A_BUSINESS_DATE',
    why: 'A profile attribute used for age-appropriateness. It names a day in the past by definition and no streak, cap or ledger key is derived from it.',
  },
  {
    dto: 'UpdateChildDto',
    field: 'dateOfBirth',
    disposition: 'NOT_A_BUSINESS_DATE',
    why: 'As CreateChildDto — a profile attribute, corrected by a parent, from which nothing is granted and no daily boundary is derived.',
  },
  {
    dto: 'CreateLearningGoalDto',
    field: 'targetDate',
    disposition: 'NOT_A_BUSINESS_DATE',
    why: 'A goal deadline the parent chooses. It is a target, not a claim that something happened on a day, and nothing is granted by reaching it on the wire.',
  },
  {
    dto: 'CreateHabitDto',
    field: 'scheduledStartTime',
    disposition: 'NOT_A_BUSINESS_DATE',
    why: 'A wall-clock HH:MM in the habit definition — when the habit is meant to happen, set by a parent. Never the time something DID happen.',
  },
  {
    dto: 'CreateHabitDto',
    field: 'scheduledEndTime',
    disposition: 'NOT_A_BUSINESS_DATE',
    why: 'As scheduledStartTime — the far end of the same parent-authored schedule window, and equally never a record of when something happened.',
  },
  {
    dto: 'LogSleepDto',
    field: 'sleepStart',
    disposition: 'NOT_A_BUSINESS_DATE',
    why: 'A self-reported duration boundary inside an already server-dated log. It affects the reported sleep length, not which day the log belongs to.',
  },
  {
    dto: 'LogSleepDto',
    field: 'sleepEnd',
    disposition: 'NOT_A_BUSINESS_DATE',
    why: 'As sleepStart — a boundary of a self-reported duration inside a log the server has already dated, affecting length and not which day it belongs to.',
  },
  {
    dto: 'SetScreenTimePolicyDto',
    field: 'bedtimeStart',
    disposition: 'NOT_A_BUSINESS_DATE',
    why: 'A parent-set wall-clock policy boundary, enforced on the family calendar by the device agent.',
  },
  {
    dto: 'SetScreenTimePolicyDto',
    field: 'bedtimeEnd',
    disposition: 'NOT_A_BUSINESS_DATE',
    why: 'As bedtimeStart — the far end of the same parent-set wall-clock policy window, enforced on the family calendar by the device agent.',
  },
  {
    dto: 'CreateRewardProgramDto',
    field: 'expiresAt',
    disposition: 'NOT_A_BUSINESS_DATE',
    why: 'When a PARENT-authored reward program stops being offered. A parent shortening or extending their own program is the feature, not an exploit; it grants nothing.',
  },
  {
    dto: 'UpdateRewardProgramDto',
    field: 'expiresAt',
    disposition: 'NOT_A_BUSINESS_DATE',
    why: 'As CreateRewardProgramDto — a parent editing the expiry of a program they authored themselves, which grants nothing on its own.',
  },
];

/** Every `*.dto.ts` under `src/`. */
function dtoFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) dtoFiles(full, acc);
    else if (entry.isFile() && full.endsWith('.dto.ts')) acc.push(full);
  }
  return acc;
}

/** Every (class, field) pair whose name is in the vocabulary of time. */
function discoverTimeFields(): { dto: string; field: string; file: string }[] {
  const found: { dto: string; field: string; file: string }[] = [];
  for (const file of dtoFiles(SRC)) {
    let currentClass: string | null = null;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const classMatch = line.match(/^\s*export class (\w+)/);
      if (classMatch) {
        currentClass = classMatch[1];
        continue;
      }
      if (!currentClass) continue;
      // EVERY `name: type` pair on the line, not the first one. Inline
      // decorators put their own object literals in front of the property
      // (`@IsISO8601({ strict: true }) usageDate!: string;`), so a
      // first-match-wins parser reads `strict` and never sees `usageDate` —
      // which is exactly how a static guard passes vacuously.
      for (const propMatch of line.matchAll(
        /(?:^|[\s(])(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)[!?]?:\s*[A-Za-z'{[]/g,
      )) {
        const field = propMatch[1];
        if (!TIME_FIELD.test(field)) continue;
        if (found.some((f) => f.dto === currentClass && f.field === field)) continue;
        found.push({ dto: currentClass, field, file: path.relative(ROOT, file) });
      }
    }
  }
  return found;
}

const discovered = discoverTimeFields();

describe('PHASE E (P0.4) — client-supplied time is classified, or the build is red', () => {
  it('finds the time-carrying DTO fields this codebase actually has', () => {
    // A sanity floor on the scanner itself. If a refactor breaks the parser
    // this number collapses and the suite below passes vacuously — which is
    // the classic failure mode of a static guard, and the reason
    // `retention-targets.spec.ts` carries the same assertion.
    expect(discovered.length).toBeGreaterThanOrEqual(20);
    expect(discovered.map((d) => `${d.dto}.${d.field}`)).toContain('LogActivityDto.date');
  });

  /**
   * THE GUARD. A new endpoint that accepts a date and does not say what the
   * server does with it fails here, by name, before it can ship.
   */
  it('classifies every one of them deliberately — no field reaches a route unexamined', () => {
    const classified = new Set(CLASSIFIED.map((c) => `${c.dto}.${c.field}`));
    const unclassified = discovered
      .filter((d) => !classified.has(`${d.dto}.${d.field}`))
      .map((d) => `${d.dto}.${d.field} (${d.file})`);

    expect(unclassified).toEqual([]);
  });

  it('keeps the table honest in the other direction too — no entry for a field that no longer exists', () => {
    const real = new Set(discovered.map((d) => `${d.dto}.${d.field}`));
    const stale = CLASSIFIED.filter((c) => !real.has(`${c.dto}.${c.field}`)).map(
      (c) => `${c.dto}.${c.field}`,
    );

    expect(stale).toEqual([]);
  });

  it('gives every classification a real written justification, not a checkbox', () => {
    for (const entry of CLASSIFIED) {
      expect(entry.why.length).toBeGreaterThan(40);
    }
  });

  /**
   * The other half of `PC-B-003`: the classification above is only true
   * because the engines default their actor to the untrusted side. A route
   * that forgets to pass an actor must get DEVICE — the side whose date is
   * discarded — and never PARENT.
   */
  it('every actor-aware engine method fails CLOSED: the default is DEVICE, never PARENT', () => {
    const engineFiles = fs
      .readdirSync(path.join(SRC, 'modules/life-intelligence/application/services'))
      .filter((f) => f.endsWith('.service.ts'))
      .map((f) => path.join(SRC, 'modules/life-intelligence/application/services', f));

    const declarations: string[] = [];
    for (const file of engineFiles) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (/actor\s*:\s*'PARENT'\s*\|\s*'DEVICE'/.test(line)) {
          declarations.push(`${path.basename(file)}: ${line.trim()}`);
        }
      }
    }

    expect(declarations.length).toBeGreaterThanOrEqual(4);
    // A parameter with a default must default to DEVICE. A parameter with no
    // default at all is a private helper whose caller has already decided —
    // those are the `resolveCompletionDate`-shaped ones and they are required,
    // which is stricter still.
    const wrongDefault = declarations.filter((d) => /=\s*'PARENT'/.test(d));
    expect(wrongDefault).toEqual([]);
  });

  /**
   * `PC-B-005`, as a permanent rule rather than a fixed call site: a child's
   * device claimed `verifiedBy: 'PARENT'` and cleared `minVerifiedBy`. The
   * closure was to stop reading it. This is what stops the next DTO from
   * offering it again.
   */
  it('no DTO anywhere lets the wire name an actor, an authorization level, or a business date', () => {
    const forbidden = /^(verifiedBy|verifiedByRole|actorType|actorRole|familyRole|businessDate|isVerified|approvedBy)$/;
    const offenders: string[] = [];

    for (const file of dtoFiles(SRC)) {
      let currentClass: string | null = null;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const classMatch = line.match(/^\s*export class (\w+)/);
        if (classMatch) {
          currentClass = classMatch[1];
          continue;
        }
        for (const propMatch of line.matchAll(
          /(?:^|[\s(])(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)[!?]?:\s*[A-Za-z'{[]/g,
        )) {
          if (forbidden.test(propMatch[1])) {
            offenders.push(`${currentClass ?? '?'}.${propMatch[1]} (${path.relative(ROOT, file)})`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
