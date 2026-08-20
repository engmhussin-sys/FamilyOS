import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const REPO_ROOT = join(__dirname, '..', '..');
const AI_CORE_DIR = join(REPO_ROOT, 'src', 'modules', 'ai-core');
const SRC_DIR = join(REPO_ROOT, 'src');

/**
 * B8 — THE AI SAFETY BOUNDARY, AS A BLOCKING TEST.
 *
 * `07-AI-Architecture.md §2.2` names seven enforcement layers and calls E5 —
 * "scan every file under the AI module and assert the absence of any Prisma
 * write outside an allow-list" — a BLOCKING CI assertion. Phase A (PA-B-025)
 * verified by reading that `ai-core` wrote to exactly two tables. Reading is
 * not enforcement: it is true on the day someone reads it.
 *
 * THIS FILE IS THE ENFORCEMENT. It fails the build the moment the AI module
 * gains write access to any repository outside `ai_usage_logs` and
 * `ai_memory_entries` — which is exactly the regression F4/B4 made newly
 * possible by giving the AI a reward program to propose.
 *
 * WHY A SOURCE SCAN AND NOT A RUNTIME ASSERTION. A runtime test can only prove
 * that the paths it happens to exercise did not write. A source scan proves
 * that no path CAN, including the ones nobody wrote a test for — which is the
 * only version of this claim worth making about a safety boundary.
 */

/**
 * THE THREE TABLES `ai-core` MAY WRITE.
 *
 * `aiAlert` IS THE THIRD, AND IT WAS ADDED THE WAY THIS FILE INTENDS: BY
 * FAILING. Phase A measured two, and the two-entry list stood until a
 * schema-liveness audit found that `ai_alerts` — described in
 * `prisma/schema.prisma` as «the AI layer's output contract — parents see
 * alerts, never raw monitored content» — HAD READERS AND NO WRITER.
 * `GrowthAlertsService.aiSafetyIncident` scanned it for un-reviewed CRITICAL
 * rows under a comment reading «one is one too many» and scanned an empty table
 * on every tick, so the offline child-safety classifier could fire and no
 * parent would ever get a durable alert. The fix is a writer, and a writer
 * needed this line.
 *
 * WHY WIDENING IS SAFE HERE, STATED RATHER THAN ASSUMED. E5's rule is that the
 * AI is a DATA PRODUCT and not a privileged client: it must not be able to
 * grant a reward, move a limit, change a setting, or approve anything.
 * `ai_alerts` is none of those — it is the AI's own OUTPUT, the table the schema
 * declares to be this layer's product, and a row in it changes no entitlement,
 * no policy and no balance. It is written through `IRecordAiAlertInput`, which
 * has no field capable of holding a child's text, and the `aiAlert` writes are
 * pinned to ONE file by the test below, so this entry cannot quietly become a
 * licence for the rest of the module.
 *
 * The list is still a ratchet. A FOURTH entry must fail here first, for the
 * same reason this third one did.
 */
const AI_WRITE_ALLOWLIST = ['aiUsageLog', 'aiMemoryEntry', 'aiAlert'];

/** `aiAlert` writes are permitted in exactly one file — the single writer. */
const AI_ALERT_WRITER = 'src/modules/ai-core/infrastructure/prisma-ai-alert.repository.ts';

const WRITE_OPERATIONS = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
];

interface PrismaWrite {
  readonly file: string;
  readonly model: string;
  readonly operation: string;
  readonly line: number;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * `this.prisma.<model>.<op>(` / `tx.<model>.<op>(` / `prisma.<model>.<op>(`.
 *
 * THE RECEIVER LIST IS EXACT, AND IT COST A FALSE POSITIVE TO LEARN WHY. A
 * first draft also matched `client`, and immediately flagged
 * `this.client.messages.create()` — the Anthropic SDK call itself — as a write
 * to a table called `messages`. A boundary test that cries wolf gets its
 * assertion relaxed by the next person under time pressure, so the receivers
 * are the four names this codebase actually binds a Prisma client to, and
 * nothing else. `tx` is included because an interactive transaction is exactly
 * where someone would put a bypass.
 */
const PRISMA_WRITE_RE = new RegExp(
  String.raw`\b(?:this\.)?(?:prisma|tx|trx|transaction)\s*\.\s*([A-Za-z][A-Za-z0-9_]*)\s*\.\s*(${WRITE_OPERATIONS.join('|')})\s*\(`,
  'g',
);

function scanPrismaWrites(files: readonly string[]): PrismaWrite[] {
  const violations: PrismaWrite[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      // Comments describing the rule must not trip the rule.
      const code = text.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      let match: RegExpExecArray | null;
      PRISMA_WRITE_RE.lastIndex = 0;
      while ((match = PRISMA_WRITE_RE.exec(code)) !== null) {
        violations.push({
          file: relative(REPO_ROOT, file),
          model: match[1],
          operation: match[2],
          line: index + 1,
        });
      }
    });
  }
  return violations;
}

describe('AI SAFETY BOUNDARY — the AI is a data product, not a privileged client', () => {
  const aiCoreFiles = walk(AI_CORE_DIR);

  it('scans a non-trivial number of files (the scanner itself is not silently empty)', () => {
    // A boundary test that scans zero files passes forever. This asserts the
    // scanner found the module before any conclusion is drawn from it.
    expect(aiCoreFiles.length).toBeGreaterThan(25);
  });

  it('E5 — the AI module has ZERO Prisma write access outside its two-table allow-list', () => {
    const writes = scanPrismaWrites(aiCoreFiles);
    const violations = writes.filter((w) => !AI_WRITE_ALLOWLIST.includes(w.model));

    expect(
      violations.map((v) => `${v.file}:${v.line} → prisma.${v.model}.${v.operation}()`),
    ).toEqual([]);
  });

  it('the allow-list is exactly three tables — widening it fails here first', () => {
    expect(AI_WRITE_ALLOWLIST).toEqual(['aiUsageLog', 'aiMemoryEntry', 'aiAlert']);

    const writes = scanPrismaWrites(aiCoreFiles);
    const modelsWritten = [...new Set(writes.map((w) => w.model))].sort();
    // Every model actually written must be in the allow-list. (The reverse is
    // not asserted: a release that happens not to write usage logs is fine.)
    for (const model of modelsWritten) {
      expect(AI_WRITE_ALLOWLIST).toContain(model);
    }
  });

  /**
   * THE THIRD ENTRY IS NOT A GENERAL LICENCE.
   *
   * `ai_alerts` is the AI's output contract, so exactly one class may write it:
   * `PrismaAiAlertRepository`, whose input type cannot express a child's text.
   * An engine, a controller or a coach service reaching the table directly
   * would bypass that type — and the copy, the enums and the dedupe key it
   * fixes — so the allow-list entry is scoped to the one file rather than to
   * the module.
   */
  it('`aiAlert` is written from ONE file — the allow-list entry is scoped, not blanket', () => {
    const writes = scanPrismaWrites(aiCoreFiles).filter((w) => w.model === 'aiAlert');

    // The writer exists and really does write — a scoped rule that matches
    // nothing is a rule that passes forever.
    expect(writes.length).toBeGreaterThan(0);
    expect([...new Set(writes.map((w) => w.file.split('\\').join('/')))]).toEqual([AI_ALERT_WRITER]);
  });

  it('the AI module never uses raw SQL — a raw statement is a hole straight through the allow-list', () => {
    const offenders: string[] = [];
    for (const file of aiCoreFiles) {
      const source = readFileSync(file, 'utf8');
      const stripped = source
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, ''))
        .join('\n');
      if (/\$executeRaw|\$queryRaw|\$executeRawUnsafe|\$queryRawUnsafe/.test(stripped)) {
        offenders.push(relative(REPO_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('E2 — the AI module imports NO write-capable service from rewards / policies / auth / billing', () => {
    // The capability is denied by ABSENCE FROM THE OBJECT GRAPH, not by anyone
    // choosing not to call a method they hold a reference to. A signal
    // repository reading `reward_programs` read-only is fine; injecting
    // `RewardProgramService` (which owns `create`) is not.
    const FORBIDDEN_IMPORTS = [
      'rewards-engine/application/services/reward-program.service',
      'rewards-engine/application/services/reward-payout.service',
      'rewards-engine/application/services/achievement.service',
      'rewards-engine/application/services/reward-suggestion.service',
      'life-intelligence/application/services/rewards.service',
      'auth/application/services/auth.service',
      'auth/application/services/token.service',
      'billing/application/services',
      'settings/application/services',
    ];

    const offenders: string[] = [];
    for (const file of aiCoreFiles) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of FORBIDDEN_IMPORTS) {
        if (source.includes(forbidden)) {
          offenders.push(`${relative(REPO_ROOT, file)} imports ${forbidden}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the AI module contains no method named grant / approve / verify / award — not even a private one', () => {
    // A boundary is easiest to breach by writing the method and calling it from
    // one place "temporarily". This makes the FIRST step visible.
    const forbiddenMethod = /^\s*(?:private\s+|public\s+|protected\s+)?(?:async\s+)?(grant|approve|award|verifyAchievement|payout)\s*\(/;
    const offenders: string[] = [];
    for (const file of aiCoreFiles) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (forbiddenMethod.test(line.replace(/\/\/.*$/, ''))) {
            offenders.push(`${relative(REPO_ROOT, file)}:${i + 1} → ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('exactly ONE file in the entire backend imports a vendor AI SDK', () => {
    // The property this project has held since Sprint 4, restated as a test now
    // that a SECOND provider exists. `OpenAiProvider` speaks HTTP deliberately
    // so that adding failover did not add a second SDK import — and this test
    // is what would have caught it if it had.
    const sdkImporters: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const source = readFileSync(file, 'utf8');
      if (/from\s+'@anthropic-ai\/sdk'|from\s+"openai"|from\s+'openai'|require\(['"]openai['"]\)/.test(source)) {
        sdkImporters.push(relative(REPO_ROOT, file));
      }
    }
    expect(sdkImporters).toEqual(['src/modules/ai-core/infrastructure/anthropic-ai-provider.ts']);
  });

  it('NO CHILD FREE TEXT REACHES A PROVIDER — the checkin path has no route to complete()', () => {
    // §11.1's "no open-ended child chat" as a structural fact. The class that
    // handles a child's only free-text field must not hold an AI provider.
    const distress = readFileSync(
      join(AI_CORE_DIR, 'application', 'services', 'distress-escalation.service.ts'),
      'utf8',
    );
    const code = distress
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, ''))
      .join('\n');

    expect(code).not.toMatch(/AI_PROVIDER/);
    expect(code).not.toMatch(/IAIProvider/);
    expect(code).not.toMatch(/\.complete\s*\(/);
  });

  it('the child controller exposes no route that turns child free text into model output', () => {
    const controller = readFileSync(
      join(AI_CORE_DIR, 'presentation', 'controllers', 'child-coach.controller.ts'),
      'utf8',
    );
    // The ONLY @Post on the child surface is `checkin`, and it is handled by
    // the distress service (asserted provider-free above).
    const posts = controller.match(/@Post\(/g) ?? [];
    expect(posts).toHaveLength(1);
    expect(controller).toContain("@Post('checkin')");
    expect(controller).toContain('isChildTopicCode(topicCode)');
  });
});
