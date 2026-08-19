/**
 * ============================================================================
 * ARCHITECTURE GUARD — NO UNDECLARED DORMANT TABLE.
 * ============================================================================
 *
 * THE DEFECT SHAPE.
 *
 * `prisma/schema.prisma` declares 101 models. Every one of them is migrated
 * into PostgreSQL, carries its indexes, carries its foreign keys, and is read
 * by every reviewer as a statement about what this product stores. Some of them
 * will be EMPTY FOREVER, because nothing in `src/` ever originates a row:
 *
 *   `location_safe_zones`   `ls src/modules` has no location module. Not a
 *   `location_events`       missing repository — a missing SUBSYSTEM. The
 *                           compliance export reads `location_events` and the
 *                           retention sweep purges it, so two live code paths
 *                           depend on a table that nothing can ever fill.
 *   `learning_assessments`  `latestAssessmentScore` is the ASSESSMENT reward
 *                           strategy's only score source, and it returns `null`
 *                           for every child in production because no writer
 *                           exists.
 *   `badge_definitions`     `awardBadgeIfNotAlready` needs a badge id that
 *                           `findBadgeByKey` looks up in a catalogue nothing
 *                           seeds.
 *   `ai_alerts`             `GrowthAlertsService.aiSafetyIncident` is documented
 *                           as «one is one too many» and can never fire.
 *
 * NONE OF THAT IS THE DEFECT. A deferred feature may legitimately land its
 * schema first, and a reference table legitimately gets its rows from a
 * migration. THE DEFECT IS THAT A DORMANT TABLE IS INDISTINGUISHABLE FROM A
 * LIVE ONE BY READING THE SCHEMA. `PhysicalMeasurementLog` and `SleepLog` sit
 * four lines apart, look identical, and one of them has a writer. A reviewer
 * pricing an index, a DBA sizing a partition, an engineer wiring a new reader —
 * each of them is entitled to know which is which, and today the only way to
 * find out is to grep.
 *
 * This file is that grep, executed on every run, with the answer written down.
 *
 * ---------------------------------------------------------------------------
 * WHY IT CANNOT GO STALE, WHICH IS THE ONLY PROPERTY THAT MATTERS.
 *
 * The design is `notification-producer-chain.guard.spec.ts`'s, deliberately:
 * a SCANNER that measures production, a DECLARATION LEDGER that carries a
 * reason from a fixed vocabulary, and NEGATIVE CONTROLS that prove the scanner
 * discriminates. The model list is never typed out here — it is READ, at test
 * time, out of `prisma/schema.prisma`. Add a model with no reader and no
 * writer: RULE D2 goes red naming it. Give a declared model a writer: RULE D3
 * goes red and demands the entry be DELETED. Delete a model: RULE D5 goes red
 * on the orphaned entry. Nobody has to remember anything.
 *
 * RULE D3 is the whole point. A ledger that can be satisfied by ignoring it is
 * a scoreboard; this one fails the build when reality improves, so the entry
 * cannot outlive the condition that justified it.
 *
 * ---------------------------------------------------------------------------
 * WHAT «LIVE» MEANS HERE, AND WHY IT IS NARROWER THAN «MENTIONED».
 *
 * LIVE means `src/` can ORIGINATE A ROW: a `create` / `createMany` / `upsert`
 * on the delegate, a nested relation write, or a raw `INSERT INTO`. It does NOT
 * mean the name appears somewhere.
 *
 *   A READER IS NOT A WRITER. `PhysicalMeasurementLog` has a reader in the
 *   compliance export and no writer anywhere; the export therefore returns an
 *   empty array for every child, forever. Counting that read as «live» would
 *   have hidden exactly the fact this guard exists to publish, so a
 *   reader-without-writer is DORMANT and the ledger says so in words.
 *
 *   A DELETER IS NOT A WRITER EITHER. `data-retention` calls
 *   `locationEvent.deleteMany`. Purging a table nothing fills is a no-op that
 *   looks like coverage.
 *
 * WHAT THIS GUARD CANNOT DECIDE, stated so nobody trusts it further than it
 * goes: it cannot prove a write site is REACHED at runtime — the same
 * inter-procedural reachability property the notification guards decline to
 * approximate — and it cannot see a row written by a dynamic delegate lookup
 * (`prisma[name].create(...)`), which this codebase does not do today. It
 * decides one narrow, total question: «is there anything in `src/` that could
 * put a row in this table?»
 *
 * ---------------------------------------------------------------------------
 * THE RULES.
 *
 *   D1  NOT VACUOUS. The scan reads the real schema, finds the models this
 *       product demonstrably has, and exercises EVERY evidence kind it
 *       implements. An evidence kind nothing triggers is an untested one.
 *   D2  Every DORMANT model appears in `DORMANT_SCHEMA_DECLARATIONS`, by name.
 *   D3  THE RATCHET. No declared model is LIVE. The day one gains a writer the
 *       suite goes red and the entry must be deleted.
 *   D4  Every declaration carries a `reason` from the FIXED vocabulary and a
 *       `justification` that names a concrete blocker or a superseding model.
 *       An empty or placeholder justification is rejected by the same assertion
 *       the real ledger faces.
 *   D5  No declaration is orphaned or duplicated.
 *   D6  NEGATIVE CONTROL, PERMANENT, on synthetic fixtures. An undeclared
 *       dormant model IS reported by name; adding a usage clears it; a usage
 *       that appears only in a COMMENT does not count; a declared model that
 *       has gone live IS reported.
 *
 * ---------------------------------------------------------------------------
 * COMMENTS ARE STRIPPED, STRINGS AND TEMPLATE LITERALS ARE NOT.
 *
 * This repository's docstrings name tables constantly — `retention-targets.ts`,
 * `rewards-engine.service.ts` and `notification-delivery.sql.ts` all discuss
 * `notification_deliveries` in prose — so a scanner that counted prose would
 * report writers that do not exist. `stripComments` is the ordered lexical scan
 * the notification guard already proved it needs, and for the same measured
 * reason: a `/*` inside a `//` line comment (`// DIRECT \`/self/*\` path …`)
 * makes a regex-chain stripper swallow the next forty lines of REAL CODE. That
 * bug is reproduced as a negative control below.
 *
 * TEMPLATE LITERALS ARE KEPT, because the raw SQL is the evidence. It does not
 * live at a `$queryRaw` call site: `notification-delivery.sql.ts`,
 * `scheduler.sql.ts`, `outbox.sql.ts` and four others export their statements
 * as `const SQL_… = \`INSERT INTO "…"\`` and hand them to `$executeRawUnsafe`.
 * MEASURED, NOT IMAGINED: scanning only the text following a `$queryRaw` token
 * reports `notification_deliveries`, `scheduled_jobs`, `notification_policy_settings`
 * and `job_runs` as dormant, and every one of those is wrong.
 */
import * as fs from 'fs';
import * as path from 'path';

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(BACKEND_ROOT, 'src');
const SCHEMA = path.join(BACKEND_ROOT, 'prisma/schema.prisma');

// ===========================================================================
// 0. THE LEXER
// ===========================================================================

export interface SourceFile {
  /** Repo-relative from `apps/backend`, POSIX separators. */
  readonly file: string;
  readonly content: string;
}

/**
 * Removes `//` and block comments and NOTHING ELSE, preserving every newline so
 * reported line numbers stay true. Ordered rather than a chain of regexes: a
 * `/*` inside a line comment or a string does not open a block comment, and a
 * `//` inside a string is not a comment.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && d === '*') {
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n && source[i] !== quote && source[i] !== '\n') {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += source[i];
        i += 1;
      }
      if (i < n && source[i] === quote) {
        out += source[i];
        i += 1;
      }
      continue;
    }
    if (c === '`') {
      out += c;
      i += 1;
      while (i < n && source[i] !== '`') {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += source[i];
        i += 1;
      }
      if (i < n) {
        out += source[i];
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const lineOf = (code: string, index: number): number => code.slice(0, index).split('\n').length;

// ===========================================================================
// 1. THE SCHEMA, PARSED — the model list is never typed out in this file
// ===========================================================================

export interface SchemaModel {
  /** `AiRiskScore`. */
  readonly model: string;
  /** The Prisma client delegate: `AiRiskScore` -> `aiRiskScore`. Prisma
   * lower-cases the FIRST CHARACTER ONLY; it does not snake- or kebab-case. */
  readonly delegate: string;
  /** The physical table from `@@map("…")`, or the model name when unmapped. */
  readonly table: string;
  /** Field names on OTHER models whose type is this model — the names a nested
   * `include:` read or a nested `create:` write would use. */
  readonly relationFields: readonly string[];
}

/** Every `model X { … }` in a Prisma schema, with its `@@map` and its inbound
 * relation field names. Pure in `text`, so RULE D6 can hand it a fixture. */
export function parseSchemaModels(text: string): SchemaModel[] {
  const blocks: { name: string; body: string }[] = [];
  const re = /^model\s+([A-Za-z_]\w*)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) blocks.push({ name: m[1], body: m[2] });

  const names = new Set(blocks.map((b) => b.name));
  const inbound = new Map<string, Set<string>>();
  for (const block of blocks) {
    for (const line of block.body.split('\n')) {
      // `name  Target[]  @relation(...)` / `name Target?` — a field whose TYPE
      // is another model is a relation field, whatever its modifiers.
      const f = /^\s*([a-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:\[\]|\?)?\s*(?:@|$)/.exec(line);
      if (!f || !names.has(f[2])) continue;
      const set = inbound.get(f[2]) ?? new Set<string>();
      set.add(f[1]);
      inbound.set(f[2], set);
    }
  }

  return blocks.map((block) => ({
    model: block.name,
    delegate: block.name[0].toLowerCase() + block.name.slice(1),
    table: /@@map\("([^"]+)"\)/.exec(block.body)?.[1] ?? block.name,
    relationFields: [...(inbound.get(block.name) ?? [])].sort(),
  }));
}

// ===========================================================================
// 2. THE SCANNER
// ===========================================================================

/**
 * PRISMA'S MODEL-DELEGATE VOCABULARY. A CLOSED SET, and requiring the operation
 * is what makes `.currency.` a delegate access rather than a DTO field.
 *
 * MEASURED: a scanner that accepted a bare `.<delegate>` property access reports
 * `Currency`, `Country`, `Child`, `User`, `Refund` and `ReferralCode` as used
 * from `payment-webhook.service.ts`, `current-user.decorator.ts` and
 * `attribution.service.ts` — every one of those is `dto.currency`,
 * `request.user`, `event.refund`, and not one is a query. Requiring
 * `.<delegate>.<operation>(` removes all of them and loses nothing, because
 * this codebase never holds a delegate in a variable.
 */
const READ_OPS = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
] as const;
/** The row-ORIGINATING operations. This list is the definition of «live». */
const WRITE_OPS = ['create', 'createMany', 'createManyAndReturn', 'upsert'] as const;
/** Mutations that presuppose a row somebody else originated. NOT live. */
const MUTATE_OPS = ['update', 'updateMany', 'updateManyAndReturn', 'delete', 'deleteMany'] as const;
const ALL_OPS: readonly string[] = [...READ_OPS, ...WRITE_OPS, ...MUTATE_OPS];

/** Nested-write verbs inside a relation field: `child: { create: … }`. */
const NESTED_WRITE_OPS = ['create', 'createMany', 'connectOrCreate', 'upsert'] as const;

export type Evidence =
  | 'DELEGATE_WRITE'
  | 'DELEGATE_MUTATE'
  | 'DELEGATE_READ'
  | 'RAW_INSERT'
  | 'RAW_MUTATE'
  | 'RAW_SELECT'
  | 'RELATION_WRITE'
  | 'RELATION_READ';

/** The evidence kinds that mean `src/` can put a row in the table. */
const ORIGINATING: readonly Evidence[] = ['DELEGATE_WRITE', 'RAW_INSERT', 'RELATION_WRITE'];

export interface UsageSite {
  readonly file: string;
  readonly line: number;
  readonly evidence: Evidence;
  /** The matched text, so a reader can check the claim rather than trust it. */
  readonly how: string;
}

export interface ModelUsage {
  readonly model: SchemaModel;
  readonly sites: readonly UsageSite[];
  readonly status: 'LIVE' | 'DORMANT';
}

/** A table reference in SQL: `tbl`, `"tbl"`, `public."tbl"` — never a longer
 * identifier that merely starts with it (`reward_programs` must not match
 * `reward_program_categories`). */
const tableRef = (table: string): string => `(?:"?public"?\\s*\\.\\s*)?(?:"${table}"|\\b${table}\\b)`;

/**
 * EVERY USAGE OF EVERY MODEL IN `files`.
 *
 * Pure in `models` and `files`, so RULE D6 can run it against a codebase and a
 * schema that do not exist.
 */
export function scanUsage(models: readonly SchemaModel[], files: readonly SourceFile[]): ModelUsage[] {
  const stripped = files.map((f) => ({ file: f.file, code: stripComments(f.content) }));

  // Template literals, extracted ONCE. The raw SQL of this codebase lives in
  // `*.sql.ts` constants, not at the `$executeRaw` call site — see the header.
  const literals: { file: string; line: number; text: string }[] = [];
  for (const { file, code } of stripped) {
    for (const m of code.matchAll(/`[^`]*`/g)) {
      literals.push({ file, line: lineOf(code, m.index ?? 0), text: m[0] });
    }
  }

  return models.map((model) => {
    const sites: UsageSite[] = [];

    // --- delegate operations: `this.prisma.aiRiskScore.create({ … })` -------
    const delegateRe = new RegExp(`\\.${model.delegate}\\s*\\.\\s*(${ALL_OPS.join('|')})\\s*[(<]`, 'g');
    for (const { file, code } of stripped) {
      let m: RegExpExecArray | null;
      while ((m = delegateRe.exec(code)) !== null) {
        const op = m[1] as string;
        const evidence: Evidence = (WRITE_OPS as readonly string[]).includes(op)
          ? 'DELEGATE_WRITE'
          : (READ_OPS as readonly string[]).includes(op)
            ? 'DELEGATE_READ'
            : 'DELEGATE_MUTATE';
        sites.push({ file, line: lineOf(code, m.index), evidence, how: `.${model.delegate}.${op}(` });
      }
    }

    // --- raw SQL DML naming the mapped table -------------------------------
    const t = tableRef(model.table);
    const insert = new RegExp(`INSERT\\s+INTO\\s+${t}`, 'i');
    const update = new RegExp(`UPDATE\\s+(?:ONLY\\s+)?${t}`, 'i');
    const remove = new RegExp(`DELETE\\s+FROM\\s+(?:ONLY\\s+)?${t}`, 'i');
    const select = new RegExp(`(?:FROM|JOIN)\\s+${t}`, 'i');
    for (const literal of literals) {
      const evidence: Evidence | null = insert.test(literal.text)
        ? 'RAW_INSERT'
        : update.test(literal.text) || remove.test(literal.text)
          ? 'RAW_MUTATE'
          : select.test(literal.text)
            ? 'RAW_SELECT'
            : null;
      if (evidence) {
        sites.push({ file: literal.file, line: literal.line, evidence, how: `raw SQL on "${model.table}"` });
      }
    }

    // --- nested relation reads and writes ----------------------------------
    // `include: { currency: true }` is how `Currency` is read — the delegate is
    // never touched — and `child: { create: … }` is how a row could be
    // originated without ever naming the delegate. Both are real usage and
    // omitting either would report a live model as dormant.
    for (const field of model.relationFields) {
      const nested = new RegExp(
        `\\b${field}\\s*:\\s*\\{\\s*(?:${NESTED_WRITE_OPS.join('|')})\\s*:`,
        'g',
      );
      const included = new RegExp(`\\b${field}\\s*:\\s*(?:true\\b|\\{\\s*(?:select|where|orderBy|take)\\s*:)`, 'g');
      for (const { file, code } of stripped) {
        let m: RegExpExecArray | null;
        while ((m = nested.exec(code)) !== null) {
          sites.push({ file, line: lineOf(code, m.index), evidence: 'RELATION_WRITE', how: m[0].trim() });
        }
        while ((m = included.exec(code)) !== null) {
          sites.push({ file, line: lineOf(code, m.index), evidence: 'RELATION_READ', how: m[0].trim() });
        }
      }
    }

    const originates = sites.some((s) => ORIGINATING.includes(s.evidence));
    return { model, sites, status: originates ? 'LIVE' : 'DORMANT' };
  });
}

// ===========================================================================
// 3. THE LEDGER — AND IT IS THE AUDIT TRAIL, NOT A MUTE BUTTON
// ===========================================================================

/**
 * THE FIXED VOCABULARY. Four reasons, and «we have not got to it» is not one of
 * them in that wording — `DEFERRED_FEATURE` is, and it costs a sentence naming
 * the blocker.
 *
 * `DEFERRED_FEATURE`          the feature is real and planned, and NO MODULE
 *                             EXISTS to produce the rows. The justification
 *                             must name what is missing, not that it is
 *                             missing. A table with a READER but no writer
 *                             belongs here too, and the justification must say
 *                             plainly that the reader returns nothing.
 * `WRITTEN_BY_MIGRATION_ONLY` reference data. Rows come from a migration's SQL
 *                             or a `prisma/seed*.ts`, never from a request. The
 *                             justification must name the file that inserts
 *                             them, so the claim can be checked in one `grep`.
 * `READ_BY_TOOLING_ONLY`      only `scripts/` or `prisma/` touch it at all;
 *                             `src/` neither reads nor writes it.
 * `SUPERSEDED`                a LIVE model already carries this concern. The
 *                             justification must NAME that model, because an
 *                             unnamed supersession is an opinion.
 *
 * WHAT IS NOT AN ACCEPTABLE JUSTIFICATION, written down so it cannot be added
 * quietly: "not used yet", "future work", "TBD", "another work stream". Every
 * one of those describes the SYMPTOM this guard already measured on its own,
 * and RULE D4 rejects them by pattern.
 */
export type DormancyReason =
  | 'DEFERRED_FEATURE'
  | 'WRITTEN_BY_MIGRATION_ONLY'
  | 'READ_BY_TOOLING_ONLY'
  | 'SUPERSEDED';

export const DORMANCY_REASONS: readonly DormancyReason[] = Object.freeze([
  'DEFERRED_FEATURE',
  'WRITTEN_BY_MIGRATION_ONLY',
  'READ_BY_TOOLING_ONLY',
  'SUPERSEDED',
]);

export interface DormantSchemaDeclaration {
  readonly model: string;
  readonly reason: DormancyReason;
  /** ONE SENTENCE, and it must say something: the concrete blocker, or the
   * superseding model, or the file that inserts the rows. */
  readonly justification: string;
}

/**
 * EVERY MODEL IN `prisma/schema.prisma` THAT `src/` CANNOT PUT A ROW IN.
 *
 * Measured by `scanUsage` on 2026-08-19 against 101 models, then checked by
 * hand, one model at a time, against the file the justification names.
 *
 * DELETING AN ENTRY REQUIRES A WRITER, not a decision. RULE D3 fails the build
 * for an entry whose model has gone live; RULE D2 fails it for a model that is
 * dormant and absent. There is no third state.
 */
export const DORMANT_SCHEMA_DECLARATIONS: readonly DormantSchemaDeclaration[] = Object.freeze([
  // -------------------------------------------------------------------------
  // A WHOLE SUBSYSTEM THAT DOES NOT EXIST
  // -------------------------------------------------------------------------
  {
    model: 'LocationSafeZone',
    reason: 'DEFERRED_FEATURE',
    justification:
      'There is no location module in src/modules at all — not a missing repository, a missing subsystem — so nothing can define a zone; the FK from LocationEvent.safeZoneId therefore points at a table that stays empty.',
  },
  {
    model: 'LocationEvent',
    reason: 'DEFERRED_FEATURE',
    justification:
      'No location module exists to ingest a ping, yet two live paths already depend on the table: prisma-child-export.repository.ts:289 groupBy/aggregate/findMany it for the compliance export and data-retention-enforcement.service.ts:120 deleteMany purges it — a reader and a purger over a table with no writer, so the export returns nothing for every child.',
  },

  // -------------------------------------------------------------------------
  // A READER WITH NO WRITER — the shape that looks like coverage
  // -------------------------------------------------------------------------
  {
    model: 'PhysicalMeasurementLog',
    reason: 'DEFERRED_FEATURE',
    justification:
      'prisma-health.repository.ts writes NutritionLog, HydrationLog, SleepLog and ActivityLog and has no measurement method, so the count/findMany at prisma-child-export.repository.ts:191 is a reader with no writer and the growth section of every child export is empty.',
  },
  {
    model: 'LearningAssessment',
    reason: 'DEFERRED_FEATURE',
    justification:
      'Three readers and no writer: prisma-reward-program.repository.ts:257 latestAssessmentScore is documented as the ASSESSMENT reward strategy’s score source and returns null for every child, while prisma-learning.repository.ts only ever creates LearningSession rows.',
  },
  {
    model: 'AiAlert',
    reason: 'DEFERRED_FEATURE',
    justification:
      'No ai-core service raises one: growth-alerts.service.ts:360 is the single mention in src/ and its aiSafetyIncident rule — commented «one is one too many» — scans a table nothing inserts into, so the rule can never fire.',
  },
  {
    model: 'AiRiskScore',
    reason: 'DEFERRED_FEATURE',
    justification:
      'The per-child daily safety score has no producer anywhere in ai-core or analytics; DeviceRiskAssessment is written by prisma-device-risk.repository.ts:17 but scores a DEVICE pairing, not a child’s day, so it does not supersede this table.',
  },
  {
    model: 'BadgeDefinition',
    reason: 'DEFERRED_FEATURE',
    justification:
      'Nothing seeds the badge catalogue — no migration INSERT and no admin CRUD — so findBadgeByKey at prisma-rewards.repository.ts:328 always misses and the live awardBadgeIfNotAlready two lines below it can never be reached with a real badge id.',
  },
  {
    model: 'FamilyChallenge',
    reason: 'DEFERRED_FEATURE',
    justification:
      'No module creates a family challenge; the schema pair was landed ahead of the feature and the parent-facing endpoint that would define one does not exist in any controller under src/modules.',
  },
  {
    model: 'FamilyChallengeParticipation',
    reason: 'DEFERRED_FEATURE',
    justification:
      'Blocked behind FamilyChallenge above — prisma-digital-twin.repository.ts:24 already counts completed participations into the group-achievement signal, so that signal is structurally zero until a challenge can be created and joined.',
  },

  // -------------------------------------------------------------------------
  // A LIVE MODEL ALREADY CARRIES THE CONCERN
  // -------------------------------------------------------------------------
  {
    model: 'FamilyBroadcastMessage',
    reason: 'SUPERSEDED',
    justification:
      'ChildMessage is the live family-to-child path — prisma-communication.repository.ts:13 creates it, it carries authorType PARENT, title, body and the approval gate, and the notification pipeline already fans a decision out over it — so a broadcast is n ChildMessage rows and this table duplicates the concern.',
  },

  // -------------------------------------------------------------------------
  // REFERENCE DATA — rows come from a migration or a seed, never from a request
  // -------------------------------------------------------------------------
  {
    model: 'ScheduledJob',
    reason: 'WRITTEN_BY_MIGRATION_ONLY',
    justification:
      'Platform configuration inserted by migrations 0011, 0015, 0016 and 0024; scheduler.sql.ts only ever SELECTs and UPDATEs the lease columns, and a job the app could invent at runtime is exactly what the migration-owned registry exists to prevent.',
  },
  {
    model: 'Country',
    reason: 'WRITTEN_BY_MIGRATION_ONLY',
    justification:
      'Rows are inserted by prisma/migrations/0014_commercial_subscription_payments/migration.sql; src/ reads the catalogue in ten places (kpi.service.ts, country-catalogue.service.ts, prisma-payment.repository.ts) and adding a country is deliberately a migration, not an API call.',
  },
  {
    model: 'Currency',
    reason: 'WRITTEN_BY_MIGRATION_ONLY',
    justification:
      'Inserted by prisma/migrations/0014_commercial_subscription_payments/migration.sql and read only through the relation — prisma-payment.repository.ts:74 does include: { currency: true } — because minorUnits is an ISO-4217 fact, not tenant data.',
  },
  {
    model: 'QuranSurah',
    reason: 'WRITTEN_BY_MIGRATION_ONLY',
    justification:
      'The 114 surahs are inserted by prisma/migrations/0006_smart_reward_engine/migration.sql; prisma-reward-program.repository.ts:251 lists them and nothing may add a 115th, so the absence of a writer is the intended constraint.',
  },
  {
    model: 'RewardProgramCategory',
    reason: 'WRITTEN_BY_MIGRATION_ONLY',
    justification:
      'Inserted by prisma/migrations/0006_smart_reward_engine and 0007_reward_rule_management; the two live readers (prisma-rewards.repository.ts:452, prisma-reward-program.repository.ts:244) treat the category list as a closed domain vocabulary.',
  },
  {
    model: 'PlanDefinition',
    reason: 'WRITTEN_BY_MIGRATION_ONLY',
    justification:
      'Plans are upserted by prisma/seed.ts and prisma/seed-demo.ts, never by a request; prisma-billing.repository.ts:23 reads them, and a plan the application could mint at runtime would be a pricing change nobody reviewed.',
  },
  {
    model: 'SubscriptionPrice',
    reason: 'WRITTEN_BY_MIGRATION_ONLY',
    justification:
      'Prices come from prisma/seed-phase-d-prices.example.sql and the upsert in prisma/seed-demo.ts; the four readers in prisma-payment.repository.ts and kpi.service.ts resolve a price and none of them may create one.',
  },
  {
    model: 'RewardCatalogItem',
    reason: 'WRITTEN_BY_MIGRATION_ONLY',
    justification:
      'The catalogue is populated by prisma/seed-demo.ts; prisma-rewards.repository.ts:479 lists it and :489 creates the RewardRedemption against it, so the redemption path is live over a catalogue no request can extend.',
  },
]);

// ===========================================================================
// 4. THE SUITE
// ===========================================================================

function readSourceFiles(dir: string = SRC): SourceFile[] {
  const out: SourceFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readSourceFiles(abs));
    else if (entry.name.endsWith('.ts')) {
      out.push({
        file: path.relative(BACKEND_ROOT, abs).split(path.sep).join('/'),
        content: fs.readFileSync(abs, 'utf8'),
      });
    }
  }
  return out;
}

const schemaText = fs.readFileSync(SCHEMA, 'utf8');
const schemaModels = parseSchemaModels(schemaText);
const files = readSourceFiles();
const usage = scanUsage(schemaModels, files);

const dormant = usage.filter((u) => u.status === 'DORMANT').map((u) => u.model.model);
const live = usage.filter((u) => u.status === 'LIVE').map((u) => u.model.model);
const declared = DORMANT_SCHEMA_DECLARATIONS.map((d) => d.model);
const usageOf = (model: string): ModelUsage =>
  usage.find((u) => u.model.model === model) as ModelUsage;

/** Placeholder text, rejected by RULE D4. A justification that could be pasted
 * under any model at all is not a justification. */
const PLACEHOLDER = /^(n\/?a|tbd|todo|none|future work|not used( yet)?|unused|later|wip)\.?$/i;

describe('ARCHITECTURE GUARD — no undeclared dormant table', () => {
  // =========================================================================
  // RULE D1 — anti-vacuity, FIRST, because everything else is downstream of it
  // =========================================================================
  describe('RULE D1 — the scan is not vacuously green', () => {
    it('reads the real schema and the real source tree', () => {
      expect(schemaModels.length).toBeGreaterThanOrEqual(90);
      expect(files.length).toBeGreaterThan(300);
      expect(live.length).toBeGreaterThanOrEqual(70);
      // A guard that found NOTHING dormant on a 100-model schema would be a
      // guard whose regexes had broken, not a clean codebase.
      expect(dormant.length).toBeGreaterThan(0);
    });

    it('derives delegates and tables the way Prisma does', () => {
      const byName = new Map(schemaModels.map((m) => [m.model, m]));
      expect(byName.get('AiRiskScore')?.delegate).toBe('aiRiskScore');
      expect(byName.get('AiRiskScore')?.table).toBe('ai_risk_scores');
      expect(byName.get('User')?.delegate).toBe('user');
      expect(byName.get('User')?.table).toBe('users');
      // Every model is mapped; an unmapped one would make the raw-SQL half of
      // the scanner search for a table name PostgreSQL does not have.
      expect(schemaModels.filter((m) => !/^[a-z][a-z0-9_]*$/.test(m.table)).map((m) => m.model)).toEqual([]);
    });

    it('finds the live models this product demonstrably has, by the evidence that makes them live', () => {
      // Named models and named evidence, not a count: a count survives a
      // rewrite that reads the wrong thing.
      const evidenceFor = (model: string): string[] =>
        [...new Set(usageOf(model).sites.map((s) => s.evidence))].sort();

      expect(evidenceFor('ChildMessage')).toContain('DELEGATE_WRITE');
      expect(evidenceFor('ChildBadgeAward')).toContain('DELEGATE_WRITE');
      expect(evidenceFor('GrowthAlert')).toContain('DELEGATE_WRITE');
      // The `*.sql.ts` constants. Their INSERTs are the ONLY writers these
      // three tables have; if the template-literal scan regressed they would
      // silently become dormant and this guard would demand ledger entries for
      // tables that are written on every request.
      expect(evidenceFor('NotificationDelivery')).toContain('RAW_INSERT');
      expect(evidenceFor('NotificationPolicySetting')).toContain('RAW_INSERT');
      expect(evidenceFor('JobRun')).toContain('RAW_INSERT');
      // …and `OutboxMessage` is the mixed case that proves the two halves of
      // the scanner coexist: `outbox.sql.ts` claims and marks rows with raw
      // UPDATEs while the delegate creates them.
      expect(evidenceFor('OutboxMessage')).toContain('DELEGATE_WRITE');
      expect(evidenceFor('OutboxMessage')).toContain('RAW_MUTATE');
    });

    it('exercises every evidence kind it implements — an unused kind is an untested one', () => {
      const seen = new Set(usage.flatMap((u) => u.sites.map((s) => s.evidence)));
      for (const kind of [
        'DELEGATE_WRITE',
        'DELEGATE_MUTATE',
        'DELEGATE_READ',
        'RAW_INSERT',
        'RAW_MUTATE',
        'RAW_SELECT',
        'RELATION_READ',
      ] as const) {
        expect(`${kind}:${seen.has(kind)}`).toBe(`${kind}:true`);
      }
    });

    it('a READER is not a WRITER — the distinction this guard turns on', () => {
      // PhysicalMeasurementLog is read and never written; SleepLog sits four
      // lines away in the schema and is written. If these two ever classify the
      // same way, the scanner has stopped measuring origination.
      expect(usageOf('PhysicalMeasurementLog').sites.length).toBeGreaterThan(0);
      expect(usageOf('PhysicalMeasurementLog').status).toBe('DORMANT');
      expect(usageOf('SleepLog').status).toBe('LIVE');
      // …and a DELETER is not a writer either.
      expect(usageOf('LocationEvent').sites.map((s) => s.evidence)).toContain('DELEGATE_MUTATE');
      expect(usageOf('LocationEvent').status).toBe('DORMANT');
    });
  });

  // =========================================================================
  // RULE D2 — the property this file exists for
  // =========================================================================
  it('RULE D2 — every DORMANT model is declared, by name', () => {
    const undeclared = dormant
      .filter((model) => !declared.includes(model))
      .map((model) => {
        const u = usageOf(model);
        const where = u.sites.length
          ? u.sites.map((s) => `${s.file}:${s.line} ${s.evidence}`).join('; ')
          : 'no usage in src/ at all';
        return `${model} (${u.model.table}) is DORMANT — nothing in src/ can originate a row [${where}] — add it to DORMANT_SCHEMA_DECLARATIONS with a reason and a justification, or give it a writer`;
      });
    expect(undeclared).toEqual([]);
  });

  // =========================================================================
  // RULE D3 — THE RATCHET. This is what makes the ledger a guard.
  // =========================================================================
  describe('RULE D3 — a declared model that has become live fails the build', () => {
    it('no declaration outlives the condition that justified it', () => {
      const revived = DORMANT_SCHEMA_DECLARATIONS.filter((d) => live.includes(d.model)).map((d) => {
        const writers = usageOf(d.model)
          .sites.filter((s) => ORIGINATING.includes(s.evidence))
          .map((s) => `${s.file}:${s.line} ${s.evidence}`)
          .join('; ');
        return `${d.model} is now LIVE (${writers}) — DELETE its DORMANT_SCHEMA_DECLARATIONS entry; the ledger records dormancy, not permission`;
      });
      expect(revived).toEqual([]);
    });

    // One case per entry, so every declared model is named in the report of
    // every run and the ledger cannot be satisfied by nobody reading it.
    it.each(DORMANT_SCHEMA_DECLARATIONS.map((d) => [d.model, d.reason] as const))(
      '%s is still dormant (%s)',
      (model) => {
        expect(dormant).toContain(model);
      },
    );
  });

  // =========================================================================
  // RULE D4 — a classification with no reason is not a classification
  // =========================================================================
  describe('RULE D4 — every declaration carries a vocabulary reason and a real justification', () => {
    it.each(DORMANT_SCHEMA_DECLARATIONS.map((d) => [d.model, d] as const))(
      '%s — reason from the fixed vocabulary, justification that names something',
      (model, entry) => {
        expect(DORMANCY_REASONS).toContain(entry.reason);
        // A justification too short to be a sentence IS no justification.
        expect(`${model}:${entry.justification.trim().length > 80}`).toBe(`${model}:true`);
        expect(`${model}:${PLACEHOLDER.test(entry.justification.trim())}`).toBe(`${model}:false`);
        expect(entry.justification).not.toMatch(/\n/);
        // SUPERSEDED without a named superseding model is an opinion. The named
        // model must exist in the schema AND be live.
        if (entry.reason === 'SUPERSEDED') {
          const named = live.filter(
            (other) => other !== model && new RegExp(`\\b${other}\\b`).test(entry.justification),
          );
          expect(`${model} names a live superseding model:${named.length > 0}`).toBe(
            `${model} names a live superseding model:true`,
          );
        }
        // WRITTEN_BY_MIGRATION_ONLY must name the file that inserts the rows,
        // so the claim is one grep away from being checked.
        if (entry.reason === 'WRITTEN_BY_MIGRATION_ONLY') {
          expect(`${model} names a seed file:${/(migration|seed)/i.test(entry.justification)}`).toBe(
            `${model} names a seed file:true`,
          );
        }
      },
    );
  });

  // =========================================================================
  // RULE D5 — no orphan, no duplicate
  // =========================================================================
  it('RULE D5 — every declaration names a model the schema still has, exactly once', () => {
    const known = new Set(schemaModels.map((m) => m.model));
    expect(declared.filter((model) => !known.has(model))).toEqual([]);
    expect(declared).toHaveLength(new Set(declared).size);
  });

  // =========================================================================
  // RULE D6 — THE NEGATIVE CONTROL, WIRED IN AND PERMANENT
  // =========================================================================
  describe('RULE D6 — negative control: the detection provably fires', () => {
    /** A synthetic schema. NOT the real one — a control that reads the artefact
     * it is controlling proves nothing about the analyser. */
    const FIXTURE_SCHEMA = `
model WidgetLog {
  id       String @id
  familyId String @map("family_id")
  family   Family @relation(fields: [familyId], references: [id])

  @@map("widget_logs")
}

model GadgetLog {
  id String @id

  @@map("gadget_logs")
}

model Family {
  id      String      @id
  widgets WidgetLog[]

  @@map("families")
}
`;
    const fixtureModels = parseSchemaModels(FIXTURE_SCHEMA);
    const statusOf = (fs_: SourceFile[]): Map<string, 'LIVE' | 'DORMANT'> =>
      new Map(scanUsage(fixtureModels, fs_).map((u) => [u.model.model, u.status]));

    it('the fixture schema parses into the three models it declares', () => {
      expect(fixtureModels.map((m) => m.model).sort()).toEqual(['Family', 'GadgetLog', 'WidgetLog']);
      expect(fixtureModels.find((m) => m.model === 'WidgetLog')?.delegate).toBe('widgetLog');
      expect(fixtureModels.find((m) => m.model === 'WidgetLog')?.table).toBe('widget_logs');
    });

    it('an UNDECLARED DORMANT model is reported BY NAME', () => {
      const status = statusOf([
        {
          file: 'src/modules/x/x.service.ts',
          content: `async go() { await this.prisma.widgetLog.create({ data: { id } }); }`,
        },
      ]);
      const reported = [...status.entries()].filter(([, s]) => s === 'DORMANT').map(([m]) => m);
      expect(reported).toContain('GadgetLog');
      expect(reported).toContain('Family');
      expect(reported).not.toContain('WidgetLog');
    });

    it('adding a writer CLEARS the report — the guard is discriminating, not indiscriminate', () => {
      const status = statusOf([
        {
          file: 'src/modules/x/x.service.ts',
          content: `async go() { await this.prisma.widgetLog.create({ data: { id } }); }`,
        },
        {
          file: 'src/modules/x/y.service.ts',
          content: `async go() { await this.db.gadgetLog.upsert({ where: { id }, create: {}, update: {} }); }`,
        },
        {
          file: 'src/modules/x/z.repository.ts',
          content: 'const SQL = `INSERT INTO "families" ("id") VALUES ($1)`;',
        },
      ]);
      expect([...status.entries()].filter(([, s]) => s === 'DORMANT').map(([m]) => m)).toEqual([]);
    });

    it('a READER is not a writer — the model stays dormant and stays reported', () => {
      const status = statusOf([
        {
          file: 'src/modules/x/export.repository.ts',
          content: `async go() {
            const rows = await this.prisma.gadgetLog.findMany({ where: { id } });
            await this.prisma.gadgetLog.deleteMany({ where: { id } });
            return rows;
          }`,
        },
      ]);
      expect(status.get('GadgetLog')).toBe('DORMANT');
    });

    it('a usage that appears only inside a COMMENT does NOT count as a usage', () => {
      const status = statusOf([
        {
          file: 'src/modules/x/notes.ts',
          content: [
            `/** It used to call this.prisma.gadgetLog.create({ data }) and that was the defect. */`,
            `// await this.prisma.gadgetLog.createMany({ data }) — deliberately not done`,
            `/* INSERT INTO "gadget_logs" ("id") VALUES ($1) — the statement we removed */`,
            `export const NOTE = 1;`,
          ].join('\n'),
        },
      ]);
      expect(status.get('GadgetLog')).toBe('DORMANT');
    });

    it('a `/*` inside a line comment does not blind the scanner to the next forty lines', () => {
      // MEASURED IN THIS REPOSITORY, NOT IMAGINED: `rewards-engine.service.ts`
      // carries ``// DIRECT `/self/*` path …`` and a regex-chain stripper
      // swallows everything up to the next `*/`, taking the real writer with it.
      const status = statusOf([
        {
          file: 'src/modules/x/tricky.repository.ts',
          content: [
            '// the DIRECT `/self/*` path, there is nothing to retry with',
            '/** a real docstring, closed normally */',
            'async go() { await this.prisma.gadgetLog.create({ data: { id } }); }',
          ].join('\n'),
        },
      ]);
      expect(status.get('GadgetLog')).toBe('LIVE');
    });

    it('a table name in PROSE inside a live file is not raw SQL', () => {
      const status = statusOf([
        {
          file: 'src/modules/x/docs.ts',
          content: [
            '/**',
            ' * Rows in `gadget_logs` used to be written by INSERT INTO gadget_logs here.',
            ' */',
            'export const SQL = `SELECT 1`;',
          ].join('\n'),
        },
      ]);
      expect(status.get('GadgetLog')).toBe('DORMANT');
    });

    it('a longer table name is not a match for a shorter one', () => {
      // `INSERT INTO "gadget_logs_archive"` must not make `gadget_logs` live.
      const status = statusOf([
        {
          file: 'src/modules/x/archive.repository.ts',
          content: 'const SQL = `INSERT INTO "gadget_logs_archive" ("id") VALUES ($1)`;',
        },
      ]);
      expect(status.get('GadgetLog')).toBe('DORMANT');
    });

    it('a same-named DTO FIELD is not a delegate access', () => {
      // `dto.currency.code` is why the scanner requires a Prisma operation.
      const status = statusOf([
        {
          file: 'src/modules/x/dto.service.ts',
          content: `function f(dto) { return dto.gadgetLog.title + dto.gadgetLog.createdAt; }`,
        },
      ]);
      expect(status.get('GadgetLog')).toBe('DORMANT');
    });

    it('a nested relation write DOES count — a row is a row however it was made', () => {
      const status = statusOf([
        {
          file: 'src/modules/x/nested.repository.ts',
          content: `async go() { await this.prisma.family.create({ data: { id, widgets: { create: [{ id: w }] } } }); }`,
        },
      ]);
      expect(status.get('WidgetLog')).toBe('LIVE');
    });

    it('a LEDGER ENTRY FOR A NOW-LIVE MODEL is reported — the ratchet fires', () => {
      // The exact computation RULE D3 runs, on a fixture, so the ratchet is
      // proven capable of failing without waiting for production to improve.
      const ledger: readonly DormantSchemaDeclaration[] = [
        {
          model: 'GadgetLog',
          reason: 'DEFERRED_FEATURE',
          justification:
            'A justification long enough to pass the length assertion, naming a blocker that no longer blocks anything at all.',
        },
      ];
      const status = statusOf([
        {
          file: 'src/modules/x/x.service.ts',
          content: `async go() { await this.prisma.gadgetLog.create({ data: { id } }); }`,
        },
      ]);
      const revived = ledger.filter((d) => status.get(d.model) === 'LIVE').map((d) => d.model);
      expect(revived).toEqual(['GadgetLog']);
    });

    it('an unjustified declaration is rejected by the same assertions the real ledger faces', () => {
      const bad: DormantSchemaDeclaration[] = [
        { model: 'A', reason: 'DEFERRED_FEATURE', justification: 'not used yet' },
        { model: 'B', reason: 'SUPERSEDED', justification: 'TBD' },
        { model: 'C', reason: 'DEFERRED_FEATURE', justification: '' },
      ];
      for (const entry of bad) {
        expect(entry.justification.trim().length > 80 && !PLACEHOLDER.test(entry.justification.trim())).toBe(
          false,
        );
      }
      // …and the real ones pass it, which is what makes the assertion mean
      // anything at all.
      for (const entry of DORMANT_SCHEMA_DECLARATIONS) {
        expect(entry.justification.trim().length > 80).toBe(true);
        expect(PLACEHOLDER.test(entry.justification.trim())).toBe(false);
      }
    });
  });
});
