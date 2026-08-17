/**
 * ============================================================================
 * ARCHITECTURE GUARD — NO PRODUCTION PRODUCER MAY BYPASS THE SMART
 * NOTIFICATION ENGINE.
 * ============================================================================
 *
 * THE RULE. A notification exists because the engine DECIDED it should exist.
 * `SmartNotificationEngineService.handleEvent` is the only door: it assembles
 * the context, asks `NOTIFICATION_DECISION_PROVIDER`, writes a
 * `notification_decisions` row for the decision — including the decisions that
 * send nothing — composes the copy from `COPY_CATALOGUE` at the child's own
 * band, runs the audience's own safety policy, and only then hands the result
 * to the delivery pipeline. A producer that reaches `notifications` or
 * `child_messages` some other way gets none of that: no decision row, no
 * scoring, no quiet-hours class, no localization, no child safety band. It is
 * invisible to `GET /system/notifications/analytics` and it is invisible to a
 * parent reading `GET /notifications/decisions`.
 *
 * WHY A TEST AND NOT A CODE REVIEW. This has already regressed twice in this
 * codebase's recorded history, and both times every component reported success
 * (`PE-N-001`, `PF-E-006`). A rule that lives in a report is a rule that holds
 * until the next sprint.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GUARD CAN AND CANNOT DO — read this before trusting it.
 *
 * It CANNOT prove "this call site was reached from `handleEvent`". That is an
 * inter-procedural reachability property, and a regex-shaped approximation of
 * it would be worse than nothing — the same argument
 * `scripts/ci/assert-event-emission.ts` makes about transactions, for the same
 * reason.
 *
 * What it DOES do is decidable, and it is a RATCHET over four rules:
 *
 *   RULE B1  A file that contains a TERMINAL NOTIFICATION WRITE or a DELIVERY
 *            PIPELINE ENTRY must be inside the engine (`notification-engine/`)
 *            or appear in `ENGINE_BYPASS_ALLOWLIST` with a classification of
 *            `SYSTEM` or `TRANSACTIONAL` and a one-line reason. THE ALLOW-LIST
 *            IS THE AUDIT TRAIL; a new module cannot join it without a
 *            reviewer editing this file, which is the entire point.
 *
 *   RULE B2  No dead entries. Every allow-listed path must still exist and must
 *            still contain at least one of the producer patterns it was
 *            allow-listed for. An allow-list nobody prunes becomes a permanent
 *            hole, and a stale entry is a licence somebody else inherits.
 *
 *   RULE B3  NOT VACUOUS. The scan must actually find the producers this
 *            codebase is known to have, and it must find them in the files the
 *            architecture says own them. A guard whose regexes silently stop
 *            matching passes forever, and Phase E already caught one of those.
 *
 *   RULE B4  NEGATIVE CONTROL, PERMANENT. The analyser is fed a synthetic
 *            bypassing producer at a path nobody allow-listed and must flag it,
 *            once per pattern family. This is the check that proves B1 is
 *            capable of failing, and it cannot rot the way a one-off manual
 *            experiment does.
 *
 * COMMENTS ARE STRIPPED BEFORE MATCHING. Half this codebase's docstrings NAME
 * these methods while explaining why they must not be called; a guard that
 * matched prose would flag the documentation and train reviewers to ignore it.
 */
import * as fs from 'fs';
import * as path from 'path';

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(BACKEND_ROOT, 'src');

/** The engine's own module — the one place these calls are unconditionally correct. */
const ENGINE_DIR = path.join('src', 'modules', 'notification-engine');

/**
 * A producer pattern is one of two things, and they are separated because they
 * fail differently.
 *
 *   TERMINAL_WRITE   — the row itself. Reaching this without a decision means
 *                      the notification exists and the ledger does not know.
 *   PIPELINE_ENTRY   — `notifyEvent` / `deliverNow` / the two writer facades.
 *                      Reaching these skips the DECISION and the COMPOSER but
 *                      still gets fatigue, quiet hours and dedupe — a smaller
 *                      hole than a terminal write, and still a hole.
 */
type PatternKind = 'TERMINAL_WRITE' | 'PIPELINE_ENTRY';

interface ProducerPattern {
  readonly id: string;
  readonly kind: PatternKind;
  readonly regex: RegExp;
  readonly what: string;
}

/**
 * THE PATTERNS, EACH TIED TO A REAL WRITER IN THIS REPOSITORY.
 *
 * `notification.create` and `childMessage.create` are the only two model
 * accessors that produce a human-visible notification row; the raw-SQL forms
 * are here because a hand-written `INSERT` is exactly how somebody would get
 * around a Prisma-shaped rule without meaning to hide anything.
 */
const PRODUCER_PATTERNS: readonly ProducerPattern[] = Object.freeze([
  {
    id: 'PRISMA_NOTIFICATION_WRITE',
    kind: 'TERMINAL_WRITE',
    regex: /\bnotification\s*\.\s*(?:create|createMany|upsert)\s*\(/,
    what: 'a direct Prisma write to `notifications`',
  },
  {
    id: 'PRISMA_CHILD_MESSAGE_WRITE',
    kind: 'TERMINAL_WRITE',
    regex: /\bchildMessage\s*\.\s*(?:create|createMany|upsert)\s*\(/,
    what: 'a direct Prisma write to `child_messages`',
  },
  {
    id: 'RAW_SQL_NOTIFICATION_WRITE',
    kind: 'TERMINAL_WRITE',
    regex: /insert\s+into\s+"?(?:notifications|child_messages)"?/i,
    what: 'a raw SQL INSERT into `notifications` / `child_messages`',
  },
  {
    id: 'RUNTIME_ALERT_FACADE',
    kind: 'PIPELINE_ENTRY',
    regex: /\.\s*createForFamilyOwner\s*\(/,
    what: 'the parent-notification writer facade `createForFamilyOwner`',
  },
  {
    id: 'CHILD_MESSAGE_FACADE',
    kind: 'PIPELINE_ENTRY',
    regex: /\.\s*draftAiMessage(?:IfAbsent)?\s*\(/,
    what: 'the child-message writer facade `draftAiMessage(IfAbsent)`',
  },
  {
    id: 'DELIVER_NOW',
    kind: 'PIPELINE_ENTRY',
    regex: /\.\s*deliverNow\s*\(/,
    what: '`SmartNotificationIntegrationService.deliverNow`, the routing terminal',
  },
  {
    id: 'NOTIFY_EVENT',
    kind: 'PIPELINE_ENTRY',
    regex: /\.\s*(?:notifyEvent|processSignals)\s*\(/,
    what: 'the delivery pipeline entry below the engine',
  },
]);

type BypassClass = 'SYSTEM' | 'TRANSACTIONAL';

interface AllowlistEntry {
  /** Repo-relative, POSIX separators — the path as a reviewer would cite it. */
  readonly file: string;
  readonly classification: BypassClass;
  /** ONE LINE. This is the audit trail; if it needs a paragraph it needs a review. */
  readonly reason: string;
}

/**
 * ============================================================================
 * THE ALLOW-LIST — AND IT IS THE AUDIT TRAIL, NOT A SUPPRESSION FILE.
 * ============================================================================
 *
 * `TRANSACTIONAL` means: this file is part of the engine's own delivery
 * machinery, or it is a human-initiated transaction that no domain event ever
 * fires. It is BELOW or BESIDE the decision, never instead of it.
 *
 * `SYSTEM` means: this notification is safety- or integrity-critical and must
 * reach the parent even when scoring, fatigue caps or quiet hours would refuse
 * it. There are exactly two, and each names the thing that would otherwise be
 * silent.
 *
 * WHAT IS NOT AN ACCEPTABLE REASON, stated so it cannot be added quietly:
 * "the engine was inconvenient here", "this predates the engine", "it is only
 * one notification". Every one of those is `PF-E-006` again.
 */
const ENGINE_BYPASS_ALLOWLIST: readonly AllowlistEntry[] = Object.freeze([
  {
    file: 'src/modules/life-intelligence/application/services/smart-notification-integration.service.ts',
    classification: 'TRANSACTIONAL',
    reason:
      'IS the delivery pipeline the engine calls — it owns `notifyEvent`/`deliverNow` and routes to the two single writers; it decides nothing.',
  },
  {
    file: 'src/modules/pairing/infrastructure/repositories/prisma-runtime-alert.repository.ts',
    classification: 'TRANSACTIONAL',
    reason:
      'The single writer of `notifications` (B9); reached only from `deliverNow`, and the unique index on (family_id, source_event_id, user_id) lives here.',
  },
  {
    file: 'src/modules/life-intelligence/infrastructure/repositories/prisma-communication.repository.ts',
    classification: 'TRANSACTIONAL',
    reason: 'The single writer of `child_messages`; owns the (family_id, source_event_id) idempotency catch.',
  },
  {
    file: 'src/modules/life-intelligence/application/services/family-communication.service.ts',
    classification: 'TRANSACTIONAL',
    reason:
      'The approval-gated child writer; enforces the CHILD safety policy at the child’s own age band before anything is persisted (PG-001).',
  },
  {
    file: 'src/modules/life-intelligence/application/services/quiet-hours-release.service.ts',
    classification: 'TRANSACTIONAL',
    reason:
      'The release arm of the engine’s own DEFER decision — it re-enters `deliverNow` rather than holding a second copy of the routing rules.',
  },
  {
    file: 'src/modules/pairing/application/services/runtime-alert.service.ts',
    classification: 'SYSTEM',
    reason:
      'Device runtime-integrity alert (accessibility / device-admin disabled): the enforcement surface is OFF, so a fatigue cap must not silence it.',
  },
  {
    file: 'src/modules/ai-core/application/services/distress-escalation.service.ts',
    classification: 'SYSTEM',
    reason: 'Child-distress escalation to a parent — safety-critical, and deliberately not subject to scoring or quiet hours.',
  },
  {
    file: 'src/modules/life-intelligence/presentation/controllers/life-intelligence.controller.ts',
    classification: 'TRANSACTIONAL',
    reason:
      'A parent drafting their own message over HTTP; a human-initiated request, not a domain event the engine could ever have decided about.',
  },
]);

/**
 * ============================================================================
 * THE ANALYSER — pure, and it takes its files as data so RULE B4 can feed it a
 * bypass that does not exist on disk.
 * ============================================================================
 */
export interface SourceFile {
  /** Repo-relative, POSIX separators. */
  readonly file: string;
  readonly content: string;
}

export interface ProducerSite {
  readonly file: string;
  readonly line: number;
  readonly patternId: string;
  readonly kind: PatternKind;
  readonly what: string;
}

export interface Violation extends ProducerSite {
  readonly rule: 'B1';
  readonly detail: string;
}

/**
 * Removes `//` and block comments, and single/double/backtick string bodies.
 *
 * WHY STRINGS TOO. `notification-class.ts` carries a justification string that
 * names `createForFamilyOwner`, and `retention-targets.ts` carries one naming
 * `child_messages`. Those are prose that happens to live in a string literal,
 * and a guard that cannot tell prose from a call is a guard that gets muted.
 * The replacement preserves NEWLINES so reported line numbers stay true.
 */
export function stripCommentsAndStrings(source: string): string {
  const keepNewlines = (match: string): string => match.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, keepNewlines)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length))
    .replace(/'(?:\\.|[^'\\\n])*'/g, keepNewlines)
    .replace(/"(?:\\.|[^"\\\n])*"/g, keepNewlines)
    .replace(/`(?:\\.|[^`\\])*`/g, keepNewlines);
}

export function findProducerSites(files: readonly SourceFile[]): ProducerSite[] {
  const sites: ProducerSite[] = [];
  for (const { file, content } of files) {
    const code = stripCommentsAndStrings(content);
    const lines = code.split('\n');
    lines.forEach((text, index) => {
      for (const pattern of PRODUCER_PATTERNS) {
        if (pattern.regex.test(text)) {
          sites.push({
            file,
            line: index + 1,
            patternId: pattern.id,
            kind: pattern.kind,
            what: pattern.what,
          });
        }
      }
    });
  }
  return sites;
}

export function findBypassViolations(
  files: readonly SourceFile[],
  allowlist: readonly AllowlistEntry[] = ENGINE_BYPASS_ALLOWLIST,
): Violation[] {
  const allowed = new Set(allowlist.map((e) => e.file));
  const enginePrefix = ENGINE_DIR.split(path.sep).join('/');
  return findProducerSites(files)
    .filter((site) => !site.file.startsWith(enginePrefix) && !allowed.has(site.file))
    .map((site) => ({
      ...site,
      rule: 'B1' as const,
      detail:
        `${site.what} outside the Smart Notification Engine and not on ENGINE_BYPASS_ALLOWLIST. ` +
        `Route it through SmartNotificationEngineService.handleEvent, or add an entry classified ` +
        `SYSTEM/TRANSACTIONAL with a one-line reason in notification-engine-bypass.guard.spec.ts.`,
    }));
}

/** Every `.ts` under `src/`, excluding nothing: a bypass in a `.dto.ts` is a bypass. */
function readAllSourceFiles(dir: string = SRC): SourceFile[] {
  const out: SourceFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readAllSourceFiles(abs));
    } else if (entry.name.endsWith('.ts')) {
      out.push({
        file: path.relative(BACKEND_ROOT, abs).split(path.sep).join('/'),
        content: fs.readFileSync(abs, 'utf8'),
      });
    }
  }
  return out;
}

describe('ARCHITECTURE GUARD — no production notification producer bypasses the Smart Notification Engine', () => {
  const files = readAllSourceFiles();
  const sites = findProducerSites(files);

  it('RULE B3 (anti-vacuity) — the scan finds real producers, in the files that own them', () => {
    // If this fails, the regexes have stopped matching and RULE B1 has been
    // passing for free. That is the failure mode this whole block exists for.
    expect(files.length).toBeGreaterThan(300);
    expect(sites.length).toBeGreaterThan(8);

    const byPattern = new Set(sites.map((s) => s.patternId));
    // Every pattern EXCEPT the raw-SQL ones must be live: this codebase writes
    // both tables through Prisma today, and a raw INSERT appearing is exactly
    // the event that pattern is watching for.
    for (const id of [
      'PRISMA_NOTIFICATION_WRITE',
      'PRISMA_CHILD_MESSAGE_WRITE',
      'RUNTIME_ALERT_FACADE',
      'CHILD_MESSAGE_FACADE',
      'DELIVER_NOW',
      'NOTIFY_EVENT',
    ]) {
      expect(`${id}:${byPattern.has(id)}`).toBe(`${id}:true`);
    }

    // And they are where the architecture says they are: exactly one writer per
    // table, named. This is the assertion that fails if somebody adds a second.
    const writersOf = (patternId: string): string[] =>
      [...new Set(sites.filter((s) => s.patternId === patternId).map((s) => s.file))].sort();
    expect(writersOf('PRISMA_NOTIFICATION_WRITE')).toEqual([
      'src/modules/pairing/infrastructure/repositories/prisma-runtime-alert.repository.ts',
    ]);
    expect(writersOf('PRISMA_CHILD_MESSAGE_WRITE')).toEqual([
      'src/modules/life-intelligence/infrastructure/repositories/prisma-communication.repository.ts',
    ]);
    expect(writersOf('RAW_SQL_NOTIFICATION_WRITE')).toEqual([]);

    // The engine itself must be a producer — if `handleEvent` stopped reaching
    // the pipeline, the child half of the product would be silent again and
    // every other assertion here would still pass.
    const engineSites = sites.filter((s) => s.file.startsWith('src/modules/notification-engine/'));
    expect(engineSites.map((s) => s.patternId)).toContain('NOTIFY_EVENT');
  });

  it('RULE B1 — every producer is inside the engine or on the classified allow-list', () => {
    const violations = findBypassViolations(files);
    const rendered = violations.map((v) => `${v.file}:${v.line} [${v.patternId}] ${v.detail}`);
    expect(rendered).toEqual([]);
  });

  it('RULE B2 — no dead allow-list entries: every entry exists and still produces', () => {
    const dead: string[] = [];
    for (const entry of ENGINE_BYPASS_ALLOWLIST) {
      const abs = path.join(BACKEND_ROOT, entry.file);
      if (!fs.existsSync(abs)) {
        dead.push(`${entry.file} — allow-listed but the file no longer exists`);
        continue;
      }
      if (!sites.some((s) => s.file === entry.file)) {
        dead.push(`${entry.file} — allow-listed but contains no producer pattern; delete the entry`);
      }
    }
    expect(dead).toEqual([]);
  });

  it('RULE B2 — every allow-list entry carries a classification and a real one-line reason', () => {
    for (const entry of ENGINE_BYPASS_ALLOWLIST) {
      expect(['SYSTEM', 'TRANSACTIONAL']).toContain(entry.classification);
      // A reason short enough to be nothing is the same as no reason.
      expect(`${entry.file}:${entry.reason.length > 40}`).toBe(`${entry.file}:true`);
      expect(entry.reason).not.toMatch(/\n/);
    }
    // No duplicate entries — two reasons for one file means neither is the reason.
    const paths = ENGINE_BYPASS_ALLOWLIST.map((e) => e.file);
    expect(paths).toHaveLength(new Set(paths).size);
    // SYSTEM is the exceptional class and stays countable.
    const system = ENGINE_BYPASS_ALLOWLIST.filter((e) => e.classification === 'SYSTEM');
    expect(system.map((e) => e.file).sort()).toEqual([
      'src/modules/ai-core/application/services/distress-escalation.service.ts',
      'src/modules/pairing/application/services/runtime-alert.service.ts',
    ]);
  });

  /**
   * ========================================================================
   * RULE B4 — THE NEGATIVE CONTROL, WIRED IN.
   * ========================================================================
   *
   * A guard that passes vacuously is worse than none. The manual proof (add a
   * bypassing producer to `src/`, watch RULE B1 go red, remove it) was run once
   * and is recorded in the phase report — but a manual proof does not survive
   * the next refactor of these regexes. These cases are the same proof, run on
   * every CI pass, one per pattern family.
   */
  describe('RULE B4 — negative control: a bypassing producer IS caught', () => {
    const BYPASSER = 'src/modules/screen-time/application/services/rogue-notifier.service.ts';

    const cases: ReadonlyArray<{ readonly patternId: string; readonly code: string }> = [
      {
        patternId: 'PRISMA_NOTIFICATION_WRITE',
        code: `async alert(familyId: string) {\n  await this.prisma.notification.create({ data: { familyId, title: 't', body: 'b' } });\n}`,
      },
      {
        patternId: 'PRISMA_CHILD_MESSAGE_WRITE',
        code: `async tell(childId: string) {\n  await this.prisma.childMessage.create({ data: { childId, title: 't', body: 'b' } });\n}`,
      },
      {
        patternId: 'RAW_SQL_NOTIFICATION_WRITE',
        code: `async alert(familyId: string) {\n  await this.prisma.$executeRawUnsafe(\n    INSERT INTO notifications (family_id) VALUES (x)\n  );\n}`,
      },
      {
        patternId: 'RUNTIME_ALERT_FACADE',
        code: `async alert(familyId: string) {\n  await this.alerts.createForFamilyOwner({ familyId, title: 't', body: 'b' });\n}`,
      },
      {
        patternId: 'CHILD_MESSAGE_FACADE',
        code: `async tell(childId: string, familyId: string) {\n  await this.comms.draftAiMessageIfAbsent(childId, familyId, 'BADGE_EARNED', 't', 'b');\n}`,
      },
      {
        patternId: 'DELIVER_NOW',
        code: `async push(childId: string, familyId: string) {\n  await this.pipeline.deliverNow(childId, familyId, candidate);\n}`,
      },
      {
        patternId: 'NOTIFY_EVENT',
        code: `async push(childId: string, familyId: string) {\n  await this.pipeline.notifyEvent(childId, familyId, candidate);\n}`,
      },
    ];

    it.each(cases)('$patternId in an un-allow-listed file is a RULE B1 violation', ({ patternId, code }) => {
      const violations = findBypassViolations([{ file: BYPASSER, content: code }]);
      expect(violations.map((v) => v.patternId)).toContain(patternId);
      expect(violations[0].file).toBe(BYPASSER);
    });

    it('the SAME bypass inside the engine, or on the allow-list, is NOT a violation — so B1 is discriminating, not indiscriminate', () => {
      const code = `async push() { await this.pipeline.notifyEvent(c, f, candidate); }`;
      expect(
        findBypassViolations([
          { file: 'src/modules/notification-engine/application/services/smart-notification-engine.service.ts', content: code },
        ]),
      ).toEqual([]);
      expect(
        findBypassViolations([
          {
            file: 'src/modules/life-intelligence/application/services/quiet-hours-release.service.ts',
            content: code,
          },
        ]),
      ).toEqual([]);
    });

    it('prose that NAMES a producer is not a producer — the comment/string strip is load-bearing', () => {
      const prose = [
        '/** It used to call `createForFamilyOwner` directly, and that was the defect. */',
        "const REASON = 'never write child_messages here; INSERT INTO notifications is forbidden';",
        '// this.prisma.notification.create({}) — deliberately not done',
        'export const NOTE = `deliverNow is the routing terminal`;',
      ].join('\n');
      expect(findBypassViolations([{ file: BYPASSER, content: prose }])).toEqual([]);
    });
  });
});
