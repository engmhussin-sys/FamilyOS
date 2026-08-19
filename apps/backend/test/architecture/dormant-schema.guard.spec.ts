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
 *   `badge_definitions`     REFERENCE DATA since migration 0026 — `src/` still
 *                           cannot originate a row and never should, and the
 *                           catalogue it looks up is now inserted by the
 *                           migration. See the blind spot below: this entry
 *                           said `DEFERRED_FEATURE` for a whole sprint AFTER
 *                           0026 landed, and nothing in this file could tell.
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
 * THE BLIND SPOT THAT LET AN ENTRY ROT, AND WHY RULE D7 EXISTS.
 *
 * RULE D3 fails when a declared model gains a writer IN `src/`. That covers
 * `DEFERRED_FEATURE` -> LIVE, and it covered nothing else, because the scanner
 * READ `src/` AND ONLY `src/`. So the OTHER way a declaration can stop being
 * true — the rows start arriving from a MIGRATION — was invisible here by
 * construction, and the ledger recorded the wrong reason with no test able to
 * notice.
 *
 * MEASURED, NOT IMAGINED. `BadgeDefinition` was declared `DEFERRED_FEATURE`
 * because «nothing seeds the badge catalogue — no migration INSERT and no admin
 * CRUD». Migration `0026_badge_catalogue` then inserted nine definitions and the
 * nine `reward_rules` that demand them; `findBadgeByKey` started resolving,
 * `awardBadgeIfNotAlready` started awarding, and `test/rewards/badge-catalogue.e2e.spec.ts`
 * proved all of it against a real database. Every rule in this file stayed
 * green: the model still had no `src/` writer, so D2 and D3 were both satisfied
 * by a justification whose first clause was now false.
 *
 * `WRITTEN_BY_MIGRATION_ONLY` was the reason most exposed to this, because it
 * is the one reason whose evidence has NEVER lived in `src/`. Its docstring
 * demanded a file name «so the claim can be checked in one grep», and then
 * nobody ran the grep — for eight entries, on every run, for as long as the
 * ledger existed. RULE D7 runs it, in both directions:
 *
 *   D7a  a `WRITTEN_BY_MIGRATION_ONLY` claim with NO migration or seed writing
 *        that table is a claim about nothing, and fails.
 *   D7b  any OTHER reason on a model a migration or seed DOES write is a stale
 *        classification, and fails naming the file that writes it. This is the
 *        assertion that would have turned red on the day 0026 landed.
 *
 * THE SEED AXIS IS SEPARATE FROM `status`, DELIBERATELY. A migration INSERT does
 * NOT make a model LIVE: «live» means a REQUEST can originate a row, and the
 * whole point of reference data is that none can. Folding the two together would
 * make D3 demand the deletion of exactly the entries that are most correct.
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
 *   D7  THE MIGRATION AXIS, both directions. `WRITTEN_BY_MIGRATION_ONLY` is
 *       CHECKED against `prisma/migrations/**\/*.sql` and `prisma/seed*.{ts,sql}`,
 *       and every OTHER reason is checked against the same scan for staleness.
 *       The justification must name a file the scan actually found, so «one
 *       grep» is a machine-checked claim rather than a promise.
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
// 2b. THE SECOND SCANNER — WHAT A MIGRATION OR A SEED PUTS IN A TABLE
// ===========================================================================

/**
 * WHY THIS IS A SECOND SCAN AND NOT A WIDER `files` ARGUMENT TO THE FIRST.
 *
 * `scanUsage` answers «can a REQUEST originate a row?», and its answer is what
 * `status` means everywhere else in this file. A migration INSERT is the exact
 * OPPOSITE claim — «rows exist and no request may make them» — so feeding
 * migration SQL into the same scan would flip `Country`, `QuranSurah` and every
 * other reference table to LIVE and make RULE D3 demand the deletion of the
 * eight entries that are most correct. Two questions, two scans, one ledger
 * that has to answer both.
 */
export type SeedEvidence = 'MIGRATION_INSERT' | 'SEED_SQL_INSERT' | 'SEED_TS_WRITE';

export interface SeedSite {
  /** Repo-relative from `apps/backend`, POSIX separators. */
  readonly file: string;
  readonly line: number;
  readonly evidence: SeedEvidence;
  readonly how: string;
}

/**
 * SQL's comment syntax, not TypeScript's. `--` to end of line, `/* … *\/`, and
 * single-quoted literals in which `''` is an escaped quote rather than a close.
 *
 * IT IS NOT OPTIONAL. Every migration in this repository opens with a `--`
 * banner naming the tables it is about (`-- badge_definitions: the catalogue…`),
 * and `0011_scheduler_and_retention` discusses `INSERT INTO "scheduled_jobs"` in
 * prose above the statement that does it. A scan that counted those would report
 * a writer for any table a migration MENTIONS, which is most of them.
 *
 * STRING BODIES ARE BLANKED, WHICH IS THE OPPOSITE OF WHAT `stripComments`
 * DOES TO TYPESCRIPT — and the reason is that the two languages put the SQL in
 * opposite places. In `*.sql.ts` the statement IS the template literal, so
 * keeping it is the only way to see it; in a `.sql` file the statement is the
 * code and a quoted literal is DATA. `0011_scheduler_and_retention` inserts a
 * `scheduled_jobs` row whose description is prose about what the job does to
 * other tables, and that prose must not read as a writer for them.
 */
export function stripSqlComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === '-' && d === '-') {
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
    if (c === "'") {
      out += c;
      i += 1;
      while (i < n) {
        if (source[i] === "'" && source[i + 1] === "'") {
          out += '  ';
          i += 2;
          continue;
        }
        if (source[i] === "'") break;
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += "'";
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * EVERY MIGRATION OR SEED THAT ORIGINATES A ROW, PER MODEL.
 *
 * `sql` is `prisma/migrations/**\/*.sql` plus `prisma/seed*.sql`; `ts` is
 * `prisma/seed*.ts`. The TypeScript half REUSES `scanUsage` rather than
 * reimplementing «what originates a row» in a second place — a seed that upserts
 * through the Prisma client and a repository that does are the same operation,
 * and `ORIGINATING` is already the one definition of it.
 *
 * A SELECT, an UPDATE or a DELETE in a migration is NOT a writer, for the same
 * reason a reader is not a writer in `src/`: `0019_default_locale_arabic`
 * UPDATEs rows it did not create, and counting that would report a seed for
 * every table any backfill has ever touched.
 *
 * Pure in all three arguments, so RULE D6 can hand it a repository that does not
 * exist.
 */
export function scanSeedWriters(
  models: readonly SchemaModel[],
  sql: readonly SourceFile[],
  ts: readonly SourceFile[],
): Map<string, SeedSite[]> {
  const stripped = sql.map((f) => ({ file: f.file, code: stripSqlComments(f.content) }));
  const fromTs = scanUsage(models, ts);
  const out = new Map<string, SeedSite[]>();

  for (const model of models) {
    const sites: SeedSite[] = [];

    // `INSERT INTO "badge_definitions"` and `COPY "countries" (…) FROM stdin`,
    // which is how a `pg_dump`-shaped seed states the same thing.
    const t = tableRef(model.table);
    const insert = new RegExp(`(?:INSERT\\s+INTO|COPY)\\s+${t}`, 'gi');
    for (const { file, code } of stripped) {
      let m: RegExpExecArray | null;
      while ((m = insert.exec(code)) !== null) {
        sites.push({
          file,
          line: lineOf(code, m.index),
          evidence: file.startsWith('prisma/migrations/') ? 'MIGRATION_INSERT' : 'SEED_SQL_INSERT',
          how: m[0].replace(/\s+/g, ' '),
        });
      }
    }

    const tsUsage = fromTs.find((u) => u.model.model === model.model);
    for (const site of tsUsage?.sites ?? []) {
      if (!ORIGINATING.includes(site.evidence)) continue;
      sites.push({ file: site.file, line: site.line, evidence: 'SEED_TS_WRITE', how: site.how });
    }

    out.set(model.model, sites);
  }

  return out;
}

/**
 * THE FILE TOKENS A JUSTIFICATION NAMES — a migration number (`0026`) or a seed
 * file (`seed-demo.ts`, `seed-phase-d-prices.example.sql`).
 *
 * The eight entries that predate RULE D7 name their evidence in three different
 * shapes — a full path, a bare four-digit number, a list of numbers — because
 * they were written for a human reader. Extracting the TOKEN rather than
 * demanding a canonical path is what lets the promise be machine-checked without
 * rewriting eight sentences into a format nobody reads.
 *
 * `\b` IS THE WRONG BOUNDARY HERE, and it was measured: a migration directory is
 * `0014_commercial_subscription_payments`, `_` is a word character, so `\b\d{4}\b`
 * matches nothing in the very path the justification quotes and every entry
 * reported as unnamed. The boundary that is meant is «not part of a longer
 * number», which is what the lookarounds below say.
 */
export function seedFileTokens(justification: string): string[] {
  return [
    ...new Set([
      ...[...justification.matchAll(/(?<![\w])(\d{4})(?!\d)/g)].map((m) => m[1]),
      ...[...justification.matchAll(/\b(seed[A-Za-z0-9._-]*\.(?:ts|sql))/g)].map((m) => m[1]),
    ]),
  ];
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
 *                             them — and since RULE D7 that `grep` is RUN: the
 *                             named file must be one the scan actually found
 *                             writing the table, and no OTHER reason may be used
 *                             for a table a migration writes.
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
  /**
   * THE ENTRY THAT PROVED THE BLIND SPOT, AND THE SHAPE OF ITS CORRECTION.
   *
   * It read `DEFERRED_FEATURE` — «nothing seeds the badge catalogue: no
   * migration INSERT and no admin CRUD» — and that sentence was true until
   * `0026_badge_catalogue` inserted the nine definitions and the nine
   * `reward_rules` that ask for them. `Country` is the precedent this now
   * matches exactly: deployment-level reference data with no `family_id`, one
   * row shared by every household, and a stable identity that a request must not
   * be able to mint. `child_badge_awards (child_id, badge_id)` is UNIQUE, so the
   * identity of a badge has to outlive every award that points at it.
   *
   * THE DORMANCY IS UNCHANGED AND INTENDED. `src/` still cannot originate a row:
   * `prisma-rewards.repository.ts` only ever calls `findBadgeByKey`, and an
   * admin CRUD that could add a tenth badge would be the defect, not the fix.
   * What changed is the REASON, and RULE D7b is the assertion that would have
   * demanded this edit on the day 0026 landed instead of a sprint later.
   */
  {
    model: 'BadgeDefinition',
    reason: 'WRITTEN_BY_MIGRATION_ONLY',
    justification:
      'The nine platform badges are inserted by prisma/migrations/0026_badge_catalogue/migration.sql from src/shared/rewards/badge-catalogue.ts; src/ only reads them — findBadgeByKey at prisma-rewards.repository.ts:328 resolves every key and awardBadgeIfNotAlready awards against it — and a badge id a request could mint would orphan the awards that point at it.',
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

/**
 * `prisma/migrations/**\/*.sql` plus `prisma/seed*.sql`, and `prisma/seed*.ts`.
 *
 * `prisma/migrations-scripts/` is deliberately NOT read: it holds the operator
 * runbooks for applying migrations, not the statements themselves, and a
 * runbook that quotes an INSERT is prose about a writer rather than one.
 */
function readSeedSources(): { sql: SourceFile[]; ts: SourceFile[] } {
  const dir = path.join(BACKEND_ROOT, 'prisma');
  const sql: SourceFile[] = [];
  const ts: SourceFile[] = [];
  const rel = (abs: string): string => path.relative(BACKEND_ROOT, abs).split(path.sep).join('/');

  const migrations = path.join(dir, 'migrations');
  if (fs.existsSync(migrations)) {
    for (const entry of fs.readdirSync(migrations, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const inner = path.join(migrations, entry.name);
      for (const f of fs.readdirSync(inner)) {
        if (!f.endsWith('.sql')) continue;
        const abs = path.join(inner, f);
        sql.push({ file: rel(abs), content: fs.readFileSync(abs, 'utf8') });
      }
    }
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith('seed')) continue;
    const abs = path.join(dir, entry.name);
    const source = { file: rel(abs), content: fs.readFileSync(abs, 'utf8') };
    if (entry.name.endsWith('.sql')) sql.push(source);
    else if (entry.name.endsWith('.ts')) ts.push(source);
  }

  return { sql, ts };
}

const schemaText = fs.readFileSync(SCHEMA, 'utf8');
const schemaModels = parseSchemaModels(schemaText);
const files = readSourceFiles();
const usage = scanUsage(schemaModels, files);
const seedSources = readSeedSources();
const seedWriters = scanSeedWriters(schemaModels, seedSources.sql, seedSources.ts);
const seedWritersOf = (model: string): readonly SeedSite[] => seedWriters.get(model) ?? [];

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

    it('reads the real migrations and seeds, and finds the reference data they demonstrably insert', () => {
      // RULE D7 is only as good as this scan. A seed scan that found NOTHING
      // would make D7a fail loudly and D7b pass vacuously — the more dangerous
      // half — so both file sets and both evidence kinds are named here.
      expect(seedSources.sql.length).toBeGreaterThanOrEqual(20);
      expect(seedSources.ts.length).toBeGreaterThanOrEqual(1);

      const kindsFor = (model: string): string[] =>
        [...new Set(seedWritersOf(model).map((s) => s.evidence))].sort();

      // A migration INSERT, a seed `.sql` INSERT and a seed `.ts` upsert — one
      // named model per evidence kind, so an unused kind is an untested one.
      expect(kindsFor('BadgeDefinition')).toEqual(['MIGRATION_INSERT']);
      expect(kindsFor('SubscriptionPrice')).toContain('SEED_SQL_INSERT');
      expect(kindsFor('PlanDefinition')).toContain('SEED_TS_WRITE');
      // …and the negative: a deferred feature has no seed writer anywhere, or
      // D7b below would be reporting it.
      expect(seedWritersOf('AiAlert')).toEqual([]);
      expect(seedWritersOf('LocationEvent')).toEqual([]);

      // The badge catalogue's writer, by file, because the whole point of this
      // rule is that the justification's file name is the checkable claim.
      expect(seedWritersOf('BadgeDefinition').map((s) => s.file)).toEqual([
        'prisma/migrations/0026_badge_catalogue/migration.sql',
      ]);
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
  // RULE D7 — THE MIGRATION AXIS. The blind spot, closed in both directions.
  // =========================================================================
  describe('RULE D7 — a migration claim is checked against the migrations', () => {
    /**
     * D7a. «Rows come from a migration» is a statement about a file. If no file
     * in `prisma/` puts a row in that table, the entry is describing something
     * that does not happen, and the model is dormant for a DIFFERENT reason that
     * the ledger is now hiding.
     */
    it('every WRITTEN_BY_MIGRATION_ONLY model really is written by a migration or a seed', () => {
      const unbacked = DORMANT_SCHEMA_DECLARATIONS.filter(
        (d) => d.reason === 'WRITTEN_BY_MIGRATION_ONLY' && seedWritersOf(d.model).length === 0,
      ).map((d) => {
        const table = schemaModels.find((m) => m.model === d.model)?.table ?? d.model;
        return `${d.model} (${table}) claims WRITTEN_BY_MIGRATION_ONLY, but no INSERT/COPY in prisma/migrations/**/*.sql and no write in prisma/seed* touches it — either name the real writer or change the reason`;
      });
      expect(unbacked).toEqual([]);
    });

    /**
     * D7a, second half — THE «ONE GREP» PROMISE, RUN.
     *
     * The vocabulary has always demanded the file name «so the claim can be
     * checked in one grep». Until this assertion the grep was never run, which
     * is how `Country`'s justification and `BadgeDefinition`'s could sit four
     * lines apart with one of them true.
     */
    it('every WRITTEN_BY_MIGRATION_ONLY justification names a file the scan actually found', () => {
      const unnamed = DORMANT_SCHEMA_DECLARATIONS.filter(
        (d) => d.reason === 'WRITTEN_BY_MIGRATION_ONLY',
      )
        .filter((d) => {
          const sites = seedWritersOf(d.model);
          if (sites.length === 0) return false; // already reported by D7a
          const tokens = seedFileTokens(d.justification);
          return !sites.some((s) => tokens.some((token) => s.file.includes(token)));
        })
        .map(
          (d) =>
            `${d.model}'s justification names none of the files that actually write it [${seedWritersOf(
              d.model,
            )
              .map((s) => `${s.file}:${s.line}`)
              .join('; ')}]`,
        );
      expect(unnamed).toEqual([]);
    });

    /**
     * D7b. THE RATCHET FOR THE OTHER AXIS, and the one that would have caught
     * `BadgeDefinition` on the day `0026_badge_catalogue` landed. A model whose
     * rows now arrive from a migration is not a `DEFERRED_FEATURE`, is not
     * `SUPERSEDED`, and is not `READ_BY_TOOLING_ONLY` — whatever the entry says,
     * the schema stopped being empty and the ledger has to say so.
     */
    it('no OTHER reason survives a migration or seed that writes the table', () => {
      const stale = DORMANT_SCHEMA_DECLARATIONS.filter(
        (d) => d.reason !== 'WRITTEN_BY_MIGRATION_ONLY' && seedWritersOf(d.model).length > 0,
      ).map(
        (d) =>
          `${d.model} is declared ${d.reason}, but its rows are inserted by [${seedWritersOf(d.model)
            .map((s) => `${s.file}:${s.line} ${s.evidence}`)
            .join(
              '; ',
            )}] — reclassify it WRITTEN_BY_MIGRATION_ONLY and rewrite the justification around that file`,
      );
      expect(stale).toEqual([]);
    });

    // One case per migration-backed entry, so every such claim is named in the
    // report of every run — the same discipline RULE D3 applies to dormancy.
    it.each(
      DORMANT_SCHEMA_DECLARATIONS.filter((d) => d.reason === 'WRITTEN_BY_MIGRATION_ONLY').map(
        (d) => [d.model] as const,
      ),
    )('%s — its rows come from a file this scan can point at', (model) => {
      expect(seedWritersOf(model).length).toBeGreaterThan(0);
    });
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

    // -----------------------------------------------------------------------
    // THE SECOND SCANNER, ON THE SAME SYNTHETIC SCHEMA
    // -----------------------------------------------------------------------
    const seedStatusOf = (sql: SourceFile[], ts: SourceFile[] = []): Map<string, SeedEvidence[]> =>
      new Map(
        [...scanSeedWriters(fixtureModels, sql, ts).entries()].map(([model, sites]) => [
          model,
          sites.map((s) => s.evidence),
        ]),
      );

    it('a real INSERT in a migration IS a seed writer, and a SELECT in one is not', () => {
      const status = seedStatusOf([
        {
          file: 'prisma/migrations/0001_init/migration.sql',
          content: `INSERT INTO "gadget_logs" ("id") VALUES ('a');
                    SELECT * FROM "widget_logs";
                    UPDATE "families" SET "id" = 'b';
                    DELETE FROM "widget_logs";`,
        },
      ]);
      expect(status.get('GadgetLog')).toEqual(['MIGRATION_INSERT']);
      // A read, an update and a delete are not origination — the same rule the
      // `src/` scanner turns on, applied to SQL.
      expect(status.get('WidgetLog')).toEqual([]);
      expect(status.get('Family')).toEqual([]);
    });

    it('a table named only in a SQL COMMENT is not a seed writer', () => {
      const status = seedStatusOf([
        {
          file: 'prisma/migrations/0002_notes/migration.sql',
          content: [
            '-- We used to INSERT INTO "gadget_logs" here and it was wrong.',
            '/* INSERT INTO "widget_logs" ("id") VALUES (1) — removed in review */',
            'CREATE TABLE "families" ("id" TEXT);',
          ].join('\n'),
        },
      ]);
      expect(status.get('GadgetLog')).toEqual([]);
      expect(status.get('WidgetLog')).toEqual([]);
    });

    it('a table name inside a SQL STRING LITERAL is not a statement about it', () => {
      // `INSERT INTO "scheduled_jobs" (…) VALUES ('…', 'purge widget_logs …')`
      // is the real shape: a job DESCRIPTION naming another table.
      const status = seedStatusOf([
        {
          file: 'prisma/migrations/0003_jobs/migration.sql',
          content: `INSERT INTO "gadget_logs" ("id", "note") VALUES ('a', 'INSERT INTO widget_logs nightly');`,
        },
      ]);
      expect(status.get('GadgetLog')).toEqual(['MIGRATION_INSERT']);
      expect(status.get('WidgetLog')).toEqual([]);
    });

    it('a longer table name does not satisfy a shorter one, in SQL either', () => {
      const status = seedStatusOf([
        {
          file: 'prisma/migrations/0004_archive/migration.sql',
          content: `INSERT INTO "gadget_logs_archive" ("id") VALUES ('a');`,
        },
      ]);
      expect(status.get('GadgetLog')).toEqual([]);
    });

    it('a seed .ts that upserts through the client counts, and one that only reads does not', () => {
      const status = seedStatusOf(
        [],
        [
          {
            file: 'prisma/seed-fixture.ts',
            content: `await prisma.gadgetLog.upsert({ where: { id }, create: {}, update: {} });
                      await prisma.widgetLog.findMany({});`,
          },
        ],
      );
      expect(status.get('GadgetLog')).toEqual(['SEED_TS_WRITE']);
      expect(status.get('WidgetLog')).toEqual([]);
    });

    it('a seed .sql is distinguished from a migration, because the two claims read differently', () => {
      const status = seedStatusOf([
        {
          file: 'prisma/seed-prices.example.sql',
          content: `INSERT INTO "gadget_logs" ("id") VALUES ('a');`,
        },
      ]);
      expect(status.get('GadgetLog')).toEqual(['SEED_SQL_INSERT']);
    });

    it('RULE D7a fires: a WRITTEN_BY_MIGRATION_ONLY claim nothing backs IS reported', () => {
      const ledger: readonly DormantSchemaDeclaration[] = [
        {
          model: 'GadgetLog',
          reason: 'WRITTEN_BY_MIGRATION_ONLY',
          justification:
            'A justification long enough to pass the length assertion, naming prisma/migrations/0001_init/migration.sql as the file that inserts these rows.',
        },
      ];
      const writers = scanSeedWriters(fixtureModels, [], []);
      const unbacked = ledger
        .filter((d) => d.reason === 'WRITTEN_BY_MIGRATION_ONLY' && (writers.get(d.model) ?? []).length === 0)
        .map((d) => d.model);
      expect(unbacked).toEqual(['GadgetLog']);

      // …and it CLEARS the moment the migration exists, which is what makes it
      // a discriminating check rather than a blanket refusal.
      const backed = scanSeedWriters(
        fixtureModels,
        [
          {
            file: 'prisma/migrations/0001_init/migration.sql',
            content: `INSERT INTO "gadget_logs" ("id") VALUES ('a');`,
          },
        ],
        [],
      );
      expect(
        ledger.filter((d) => (backed.get(d.model) ?? []).length === 0).map((d) => d.model),
      ).toEqual([]);
    });

    it('RULE D7a names-the-file fires: a justification pointing at the wrong migration IS reported', () => {
      const writers = scanSeedWriters(
        fixtureModels,
        [
          {
            file: 'prisma/migrations/0026_gadgets/migration.sql',
            content: `INSERT INTO "gadget_logs" ("id") VALUES ('a');`,
          },
        ],
        [],
      );
      const wrong = {
        model: 'GadgetLog',
        reason: 'WRITTEN_BY_MIGRATION_ONLY' as const,
        justification:
          'A justification long enough to pass the length assertion, claiming the rows come from prisma/migrations/0014_something_else/migration.sql, which is not where they come from.',
      };
      const sites = writers.get(wrong.model) ?? [];
      const tokens = seedFileTokens(wrong.justification);
      expect(tokens).toContain('0014');
      expect(sites.some((s) => tokens.some((t) => s.file.includes(t)))).toBe(false);

      // The corrected sentence passes the same computation.
      const right = seedFileTokens(
        'The nine rows are inserted by prisma/migrations/0026_gadgets/migration.sql and nothing else writes them.',
      );
      expect(sites.some((s) => right.some((t) => s.file.includes(t)))).toBe(true);
    });

    it('RULE D7b fires: the EXACT staleness that let BadgeDefinition rot', () => {
      // A model declared DEFERRED_FEATURE — «nothing seeds it» — on the day a
      // migration starts seeding it. `src/` is unchanged, so RULE D3 stays
      // green and this is the only assertion that can notice.
      const ledger: readonly DormantSchemaDeclaration[] = [
        {
          model: 'GadgetLog',
          reason: 'DEFERRED_FEATURE',
          justification:
            'A justification long enough to pass the length assertion, stating that nothing seeds this catalogue and no admin CRUD exists to fill it.',
        },
      ];
      const writers = scanSeedWriters(
        fixtureModels,
        [
          {
            file: 'prisma/migrations/0026_gadget_catalogue/migration.sql',
            content: `INSERT INTO "gadget_logs" ("id") VALUES ('a');`,
          },
        ],
        [],
      );
      const stale = ledger
        .filter((d) => d.reason !== 'WRITTEN_BY_MIGRATION_ONLY' && (writers.get(d.model) ?? []).length > 0)
        .map((d) => d.model);
      expect(stale).toEqual(['GadgetLog']);

      // Correcting the REASON clears it — and note that the model is still
      // DORMANT throughout, because a migration does not make `src/` able to
      // originate a row. That separation is the point.
      const corrected = ledger.map((d) => ({ ...d, reason: 'WRITTEN_BY_MIGRATION_ONLY' as const }));
      expect(
        corrected
          .filter((d) => d.reason !== 'WRITTEN_BY_MIGRATION_ONLY' && (writers.get(d.model) ?? []).length > 0)
          .map((d) => d.model),
      ).toEqual([]);
      expect(
        scanUsage(fixtureModels, [
          { file: 'src/modules/x/read.repository.ts', content: 'await this.prisma.gadgetLog.findMany({});' },
        ]).find((u) => u.model.model === 'GadgetLog')?.status,
      ).toBe('DORMANT');
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
