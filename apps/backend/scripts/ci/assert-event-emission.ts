#!/usr/bin/env ts-node
/**
 * CI guard — F3 (R3). Run with:  npm run ci:event-emission
 *
 * THE RULE THIS PROTECTS, from `docs/architecture/EVENT_PIPELINE.md`:
 *
 *   No new domain module may write child-achievement state without emitting a
 *   domain event through the Outbox.
 *
 * WHAT THIS CHECK CAN AND CANNOT DO — read this before trusting it.
 *
 * It CANNOT prove "this write has a corresponding outbox write in the same
 * transaction". That is a data-flow property across a `$transaction` callback,
 * across repository/service/consumer layers, and often across files; deciding
 * it statically would need a real type-aware call-graph analysis, and a
 * regex-shaped approximation of it would be worse than nothing — it would pass
 * a service that writes the event OUTSIDE the transaction (the exact bug the
 * Outbox pattern exists to prevent) while failing honest code. So it is not
 * attempted, and this paragraph exists so nobody later assumes it was.
 *
 * What it DOES do is three things that are decidable, and it is a RATCHET:
 *
 *   RULE E1  A file that writes a DOMAIN-STATE model must either import
 *            `OutboxWriter`, or appear in `KNOWN_UNWIRED` with a written
 *            reason. The allowlist is the honest, enumerated answer to "what is
 *            still not wired through the bus" — it is reproduced verbatim in
 *            the F3 report. A NEW module cannot join it without a reviewer
 *            editing this file, which is the point.
 *
 *   RULE E2  `domain_events` / `outbox_messages` / `consumed_messages` may be
 *            written ONLY from `src/modules/events/`. A module that hand-rolls
 *            its own event insert bypasses `OutboxWriter` — and with it the
 *            single-transaction guarantee, the deterministic idempotency key
 *            and the tenant stamp.
 *
 *   RULE E3  No dead entries. Every `KNOWN_UNWIRED` path must still exist and
 *            must still perform a domain-state write; every model in
 *            `DOMAIN_STATE_MODELS` must still exist in `schema.prisma`. An
 *            allowlist nobody prunes becomes a permanent hole.
 *
 * Exit code 1 on any violation, 0 when clean. Same shape as
 * `assert-tenant-scoping.ts`, deliberately.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const SCHEMA = path.join(ROOT, 'prisma/schema.prisma');
const EVENTS_MODULE = path.join('src', 'modules', 'events');

interface Violation {
  rule: string;
  file: string;
  line: number;
  detail: string;
}
const violations: Violation[] = [];

/**
 * DOMAIN-STATE MODELS: the rows whose creation IS a real-world child
 * achievement — the things a reward can be granted for and a parent would want
 * to hear about. Deliberately NOT "every model": creating a `SupportRequest` or
 * refreshing an `AiUsageLog` is not a domain event and never will be, and a
 * check that demanded an event for those would be noise that trains reviewers
 * to ignore it.
 *
 * Each entry maps to a member of the event catalogue in
 * `src/shared/events/event-types.ts`.
 */
const DOMAIN_STATE_MODELS: ReadonlyMap<string, string> = new Map([
  ['habitCompletion', 'HABIT_COMPLETED'],
  ['smartTask', 'TASK_COMPLETED'],
  ['hydrationLog', 'HYDRATION_GOAL_COMPLETED'],
  ['activityLog', 'ACTIVITY_GOAL_COMPLETED'],
  ['learningSession', 'EDUCATION_PROGRESS'],
  ['learningAssessment', 'EDUCATION_PROGRESS'],
  ['faithPracticeLog', 'MEMORIZATION_COMPLETED'],
  ['childBadgeAward', 'REWARD_GRANTED'],
  ['rewardsLedgerEntry', 'REWARD_GRANTED'],
]);

/**
 * THE HONEST LIST OF WHAT IS NOT YET WIRED THROUGH THE BUS.
 *
 * Every entry is a real write path that predates F3 and still reaches the
 * database without emitting a domain event. They are not broken — they are the
 * IN-APP paths (a parent ticking a habit in the Parent App, the Rewards Engine
 * writing its own ledger row), and the pipeline this sprint built covers the
 * DEVICE path. Closing each of these means calling `OutboxWriter.writeWithin`
 * inside the transaction that already exists in the repository.
 *
 * Adding a line here is a deliberate, reviewable act. Removing one is the work.
 */
const KNOWN_UNWIRED: ReadonlyMap<string, string> = new Map([
  [
    'src/modules/rewards-engine/infrastructure/repositories/prisma-reward-program.repository.ts',
    'F4: DELIBERATELY SILENT, and the opposite of a gap. The `learningSession` write here is a REPORTING MIRROR of an achievement that has ALREADY been evented — AchievementOutcomeConsumer writes it while handling ACHIEVEMENT_VERIFIED, and emits QURAN_ACHIEVEMENT_COMPLETED / LEARNING_GOAL_COMPLETED for it in the same handler. Emitting EDUCATION_PROGRESS from here as the rule asks would be actively WRONG: EDUCATION_PROGRESS is a member of COMPLETION_EVENT_TYPES, so it would reach RewardsCompletionConsumer and pay a SECOND reward for one verified achievement.',
  ],
  [
    'src/modules/life-intelligence/infrastructure/repositories/prisma-habit.repository.ts',
    'In-app habit completion (parent/child app tick, not the device agent). The DEVICE path emits HABIT_COMPLETED through EventIngestionService; this repository is the same table reached from the UI and still emits nothing.',
  ],
  [
    'src/modules/life-intelligence/infrastructure/repositories/habit-completion.recorder.ts',
    'THE ONE `habit_completions` UPSERT, extracted so both doors share it — the previous two copies had diverged (`update: {}` vs `update: { status }`), which left a rollover-written MISSED row unpromoted after an offline device synced the completion, so the reward was paid for a day the streak could not see. Emission belongs to the CALLERS and is split by design: EventIngestionService calls this INSIDE the same $transaction as its OutboxWriter.writeWithin, so the device door does emit HABIT_COMPLETED; PrismaHabitRepository (allowlisted directly above, same reason) calls it for the in-app tick and still emits nothing. A conditional OutboxWriter import here would emit the device path twice.',
  ],
  [
    'src/modules/life-intelligence/infrastructure/repositories/prisma-health.repository.ts',
    'Hydration and activity logs written from the Health UI. HYDRATION_GOAL_COMPLETED / ACTIVITY_GOAL_COMPLETED exist in the catalogue and are device-ingestible, but the in-app writer does not emit them.',
  ],
  [
    'src/modules/life-intelligence/infrastructure/repositories/prisma-learning.repository.ts',
    'Learning sessions and assessments written from the Education UI. EDUCATION_PROGRESS is proven end to end from a device; the in-app writer does not emit it.',
  ],
  [
    'src/modules/life-intelligence/infrastructure/repositories/prisma-faith.repository.ts',
    'Faith practice logs written from the Faith UI. Same shape as Education (CONTEXT §4: one engine), same gap.',
  ],
  [
    'src/modules/life-intelligence/infrastructure/repositories/prisma-smart-task.repository.ts',
    'Smart task rows. TASK_COMPLETED is in the catalogue and device-ingestible; the Tasks module itself does not emit it yet.',
  ],
  [
    'src/modules/life-intelligence/infrastructure/repositories/prisma-rewards.repository.ts',
    'The rewards ledger and badge awards. Deliberately NOT emitting from the repository: REWARD_GRANTED is emitted one layer up by RewardsCompletionConsumer, and ONLY when the engine reports a real grant. Emitting here as well would produce a second REWARD_GRANTED for the same grant.',
  ],
]);

// ---------------------------------------------------------------------------

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile() && full.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

const files = walk(SRC);
const rel = (f: string) => path.relative(ROOT, f);

const WRITE_OPS = '(create|createMany|createManyAndReturn|upsert)';
const writeRegexFor = (model: string) => new RegExp(`\\.${model}\\.${WRITE_OPS}\\s*\\(`);

/** Files that actually perform a domain-state write, with the first line of it. */
const domainWriters = new Map<string, { line: number; model: string }>();

for (const file of files) {
  const r = rel(file);
  if (r.startsWith(EVENTS_MODULE)) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const model of DOMAIN_STATE_MODELS.keys()) {
      if (writeRegexFor(model).test(line) && !domainWriters.has(r)) {
        domainWriters.set(r, { line: i + 1, model });
      }
    }
  });
}

// --- RULE E1 ---------------------------------------------------------------
for (const [file, where] of domainWriters) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const emits = /OutboxWriter/.test(text);
  if (emits || KNOWN_UNWIRED.has(file)) continue;
  violations.push({
    rule: 'RULE E1 (domain write with no event emission)',
    file,
    line: where.line,
    detail:
      `Writes \`${where.model}\` — a domain-state model whose catalogue event is ` +
      `${DOMAIN_STATE_MODELS.get(where.model)} — without importing OutboxWriter. ` +
      'Emit through the Outbox inside the same transaction, or add this file to ' +
      'KNOWN_UNWIRED in scripts/ci/assert-event-emission.ts with a written reason.',
  });
}

// --- RULE E2 ---------------------------------------------------------------
const EVENT_TABLE_MODELS = ['domainEvent', 'outboxMessage', 'consumedMessage'];
for (const file of files) {
  const r = rel(file);
  if (r.startsWith(EVENTS_MODULE)) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const model of EVENT_TABLE_MODELS) {
      if (writeRegexFor(model).test(line)) {
        violations.push({
          rule: 'RULE E2 (event tables written outside the events module)',
          file: r,
          line: i + 1,
          detail:
            `Writes \`${model}\` directly. Only src/modules/events may write the event ` +
            'tables — going around OutboxWriter loses the single-transaction guarantee, ' +
            'the server-composed idempotency key and the tenant stamp.',
        });
      }
    }
  });
}

// --- RULE E3 ---------------------------------------------------------------
const schemaText = fs.readFileSync(SCHEMA, 'utf8');
for (const model of DOMAIN_STATE_MODELS.keys()) {
  const pascal = model.charAt(0).toUpperCase() + model.slice(1);
  if (!new RegExp(`^model ${pascal} \\{`, 'm').test(schemaText)) {
    violations.push({
      rule: 'RULE E3 (stale configuration)',
      file: 'scripts/ci/assert-event-emission.ts',
      line: 0,
      detail: `DOMAIN_STATE_MODELS names \`${pascal}\`, which no longer exists in schema.prisma.`,
    });
  }
}
for (const [file, reason] of KNOWN_UNWIRED) {
  if (!fs.existsSync(path.join(ROOT, file))) {
    violations.push({
      rule: 'RULE E3 (stale allowlist)',
      file,
      line: 0,
      detail: 'Listed in KNOWN_UNWIRED but the file no longer exists. Remove the entry.',
    });
    continue;
  }
  if (!domainWriters.has(file)) {
    violations.push({
      rule: 'RULE E3 (stale allowlist)',
      file,
      line: 0,
      detail:
        'Listed in KNOWN_UNWIRED but it no longer writes any domain-state model. ' +
        'Remove the entry so the list keeps meaning something.',
    });
  }
  if (reason.trim().length < 40) {
    violations.push({
      rule: 'RULE E3 (allowlist entry without a real reason)',
      file,
      line: 0,
      detail: 'A KNOWN_UNWIRED entry needs a reason a reviewer can act on (>= 40 chars).',
    });
  }
}

// ---------------------------------------------------------------------------
console.log('\nevent-emission guard');
console.log(`  files scanned              : ${files.length}`);
console.log(`  domain-state models        : ${DOMAIN_STATE_MODELS.size}`);
console.log(`  files writing domain state : ${domainWriters.size}`);
console.log(`  known-unwired (allowlisted): ${KNOWN_UNWIRED.size}`);
console.log(`  violations                 : ${violations.length}`);

if (violations.length > 0) {
  for (const v of violations) {
    console.error(`\n  ✗ ${v.rule}`);
    console.error(`      ${v.file}${v.line ? `:${v.line}` : ''}`);
    console.error(`      ${v.detail}`);
  }
  console.error('');
  process.exit(1);
}

console.log('  OK — every domain-state writer either emits through the Outbox or is');
console.log('       explicitly, reviewably listed as not yet wired.\n');
