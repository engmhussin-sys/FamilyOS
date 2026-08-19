/**
 * ============================================================================
 * THE RATCHET — «ASSESSMENT_SCORE is refused BECAUSE nothing writes
 * LearningAssessment», asserted as a measurement rather than as a belief.
 * ============================================================================
 *
 * THE DEFECT THIS GUARDS.
 *
 * `ASSESSMENT_SCORE`'s only score source is `LearningAssessment.scorePercent`,
 * read by `prisma-reward-program.repository.ts latestAssessmentScore`. Nothing
 * in `src/` writes a `LearningAssessment` row — `prisma-learning.repository.ts`
 * creates `LearningSession` and stops there — so that read returns `null` for
 * every child, forever. Measured end to end against a real database before the
 * fix: the parent got `201 Created`, and the CHILD was told «لا يوجد تقييم
 * مسجَّل لهذه المادة بعد» three times, FAILED, until attempt exhaustion
 * escalated the request. Zero ledger entries. Nothing said the strategy could
 * not work.
 *
 * `UNAVAILABLE_VERIFICATION_METHODS.ASSESSMENT_SCORE` is the guard that stops
 * a parent configuring it. THIS FILE IS THE REASON THAT GUARD IS ALLOWED TO
 * EXIST, AND THE MECHANISM THAT TAKES IT AWAY.
 *
 * ---------------------------------------------------------------------------
 * WHY IT CANNOT ROT — the property that matters, and the only one.
 *
 * The design is `test/architecture/dormant-schema.guard.spec.ts`'s (read, not
 * edited): a SCANNER that measures production, a declaration that carries its
 * reason, and NEGATIVE CONTROLS that prove the scanner discriminates.
 *
 * RULE A1 is the ratchet, and it is an EQUIVALENCE, not an implication:
 *
 *     a writer exists  <=>  the entry is gone
 *
 * so it fails in BOTH directions. Land a `LearningAssessment` writer and this
 * file goes red the same day, naming the file that writes it and demanding the
 * entry be DELETED — the guard comes down by itself, the create gate stops
 * firing, `assessmentSourceAvailable` becomes `true` at the call site with no
 * edit, and the strategy's `ASSESSMENT_NOT_FOUND` branch comes back to life.
 * Delete the entry while the table is still dormant and it goes red too,
 * because a parent would silently regain a program that can never pay.
 *
 * Nobody has to remember anything. That is the whole point.
 *
 * ---------------------------------------------------------------------------
 * WHAT «WRITER» MEANS HERE, stated so nobody trusts this further than it goes.
 *
 * A writer is something in `src/` that can ORIGINATE A ROW: a delegate
 * `create`/`createMany`/`upsert`, a nested relation `create`/`connectOrCreate`,
 * or a raw `INSERT INTO learning_assessments`. A READER IS NOT A WRITER —
 * `latestAssessmentScore` and the compliance export both read the table and
 * neither can put a row in it, which is exactly the shape that looks like
 * coverage and is not. This guard cannot prove a write site is REACHED at
 * runtime, and it cannot see a row written through a dynamic delegate lookup
 * (`prisma[name].create(...)`), which this codebase does not do.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  UNAVAILABLE_VERIFICATION_METHODS,
  VERIFICATION_METHODS,
  isVerificationMethodAvailable,
  verificationMethodUnavailability,
  type VerificationMethod,
} from '../../src/shared/rewards/verification';

const SRC = path.join(__dirname, '..', '..', 'src');

/** The Prisma delegate and the mapped table for the score source. */
const DELEGATE = 'learningAssessment';
const TABLE = 'learning_assessments';
/** How a row could be originated through a relation instead of the delegate. */
const RELATION_FIELD = 'learningAssessments';

const WRITE_OPS = ['create', 'createMany', 'upsert', 'createManyAndReturn'] as const;
const READ_OPS = ['findFirst', 'findUnique', 'findMany', 'count', 'aggregate', 'groupBy'] as const;
const NESTED_WRITE_OPS = ['create', 'createMany', 'connectOrCreate', 'upsert'] as const;

interface SourceFile {
  readonly file: string;
  readonly content: string;
}

export interface Site {
  readonly file: string;
  readonly line: number;
  readonly kind: 'WRITE' | 'READ';
  readonly how: string;
}

/**
 * Comments out, strings intact. A `.learningAssessment.create(` inside a
 * comment — including the comment at the top of this very sentence's
 * neighbours in `verification.ts` — is prose, not a writer, and counting it
 * would take the guard down on the strength of a docstring. The negative
 * controls below prove this discriminates.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        // Newlines are kept so line numbers stay honest.
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** Every site in `files` that touches the score source, classified. Pure in
 * `files`, which is what lets the negative controls run it on a codebase that
 * does not exist. */
export function scanScoreSource(files: readonly SourceFile[]): Site[] {
  const sites: Site[] = [];
  const allOps = [...WRITE_OPS, ...READ_OPS];

  for (const f of files) {
    const code = stripComments(f.content);

    // --- delegate operations -------------------------------------------------
    const delegateRe = new RegExp(`\\.${DELEGATE}\\s*\\.\\s*(${allOps.join('|')})\\s*[(<]`, 'g');
    let m: RegExpExecArray | null;
    while ((m = delegateRe.exec(code)) !== null) {
      const op = m[1] as string;
      sites.push({
        file: f.file,
        line: lineOf(code, m.index),
        kind: (WRITE_OPS as readonly string[]).includes(op) ? 'WRITE' : 'READ',
        how: `.${DELEGATE}.${op}(`,
      });
    }

    // --- nested relation writes ---------------------------------------------
    const nestedRe = new RegExp(
      `\\b${RELATION_FIELD}\\s*:\\s*\\{\\s*(?:${NESTED_WRITE_OPS.join('|')})\\s*:`,
      'g',
    );
    while ((m = nestedRe.exec(code)) !== null) {
      sites.push({ file: f.file, line: lineOf(code, m.index), kind: 'WRITE', how: m[0].trim() });
    }

    // --- raw SQL naming the mapped table ------------------------------------
    // `"tbl"`, `tbl`, `public."tbl"` — never a longer identifier that merely
    // starts with it.
    const t = `(?:"?public"?\\s*\\.\\s*)?(?:"${TABLE}"|\\b${TABLE}\\b)`;
    for (const lit of code.matchAll(/`[^`]*`/g)) {
      const text = lit[0];
      if (new RegExp(`INSERT\\s+INTO\\s+${t}`, 'i').test(text)) {
        sites.push({
          file: f.file,
          line: lineOf(code, lit.index ?? 0),
          kind: 'WRITE',
          how: `raw INSERT INTO "${TABLE}"`,
        });
      } else if (new RegExp(`(?:FROM|JOIN)\\s+${t}`, 'i').test(text)) {
        sites.push({
          file: f.file,
          line: lineOf(code, lit.index ?? 0),
          kind: 'READ',
          how: `raw SELECT on "${TABLE}"`,
        });
      }
    }
  }
  return sites;
}

function readSourceFiles(dir: string = SRC): SourceFile[] {
  const out: SourceFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readSourceFiles(full));
    else if (entry.name.endsWith('.ts')) {
      out.push({ file: path.relative(path.join(SRC, '..'), full), content: fs.readFileSync(full, 'utf8') });
    }
  }
  return out;
}

const sites = scanScoreSource(readSourceFiles());
const writers = sites.filter((s) => s.kind === 'WRITE');
const readers = sites.filter((s) => s.kind === 'READ');
const describeSites = (list: readonly Site[]): string =>
  list.map((s) => `${s.file}:${s.line} (${s.how})`).join(', ') || 'none';

describe(`the ASSESSMENT_SCORE ratchet — ${TABLE} has ${writers.length} writer(s) in src/`, () => {
  // ==========================================================================
  // RULE A1 — THE RATCHET ITSELF
  // ==========================================================================
  it('ASSESSMENT_SCORE is refused if and only if nothing in src/ writes LearningAssessment', () => {
    const listed = !isVerificationMethodAvailable('ASSESSMENT_SCORE');

    if (writers.length > 0) {
      // The day this fires is the day the feature became real. Do NOT relax
      // this assertion — DELETE the entry.
      expect(
        `${TABLE} now has a writer (${describeSites(writers)}). The ASSESSMENT_SCORE guard has ` +
          `served its purpose: DELETE UNAVAILABLE_VERIFICATION_METHODS.ASSESSMENT_SCORE in ` +
          `src/shared/rewards/verification.ts, delete the LearningAssessment entry from ` +
          `test/architecture/dormant-schema.guard.spec.ts, and delete this expectation. ` +
          `The create gate, the catalogue flag and assessmentSourceAvailable all follow that ` +
          `one deletion with no further edits.`,
      ).toBe('');
    }

    expect(listed).toBe(writers.length === 0);
  });

  it('the refusal names the model it is actually about, and points at the reader that is starved', () => {
    const spec = verificationMethodUnavailability('ASSESSMENT_SCORE');
    // Guarded so this file still reads correctly on the day A1 above deletes
    // the entry: with no entry there is nothing to be self-consistent about.
    if (!spec) {
      expect(writers.length).toBeGreaterThan(0);
      return;
    }
    expect(spec.scoreSourceModel).toBe('LearningAssessment');
    expect(spec.method).toBe('ASSESSMENT_SCORE');
    expect(spec.readerReference).toContain('latestAssessmentScore');

    // And the reader it names is real: the repository does read the delegate.
    const repo = fs.readFileSync(
      path.join(SRC, 'modules/rewards-engine/infrastructure/repositories/prisma-reward-program.repository.ts'),
      'utf8',
    );
    expect(stripComments(repo)).toContain(`${DELEGATE}.findFirst`);
  });

  // ==========================================================================
  // RULE A2 — A READER IS NOT A WRITER, which is the shape that looks like
  // coverage. The table is READ in more than one place today; not one of those
  // reads can put a row in it.
  // ==========================================================================
  it('the score source is read by src/ and written by nothing — the starved-reader shape', () => {
    if (writers.length > 0) return; // A1 owns this case and has already failed.
    expect(readers.length).toBeGreaterThan(0);
    expect(describeSites(writers)).toBe('none');
  });

  // ==========================================================================
  // RULE A3 — the declaration is usable by a human: Arabic, specific, and it
  // does not blame the child.
  // ==========================================================================
  it('every unavailable method carries an Arabic message for the parent AND one for the child', () => {
    for (const [method, spec] of Object.entries(UNAVAILABLE_VERIFICATION_METHODS)) {
      expect(VERIFICATION_METHODS).toContain(method as VerificationMethod);
      expect(spec!.method).toBe(method);
      for (const text of [spec!.messageAr, spec!.childMessageAr]) {
        expect(text.length).toBeGreaterThan(20);
        // Arabic script, not a code and not an English sentence.
        expect(text).toMatch(/[؀-ۿ]/);
        expect(text).not.toMatch(/[A-Za-z]{4,}/);
      }
      // Non-punitive (CONTEXT §3 principle 7): the child's copy must not say
      // they failed, because they did not.
      expect(spec!.childMessageAr).not.toMatch(/فشل|رسبت|خطؤك/);
      expect(spec!.code).toBe('VERIFICATION_METHOD_UNAVAILABLE');
    }
  });

  // ==========================================================================
  // RULE A4 — NEGATIVE CONTROLS. A scanner that has never been shown to
  // discriminate proves nothing by reporting zero writers.
  // ==========================================================================
  describe('the scanner discriminates (negative controls)', () => {
    const scan = (content: string): Site[] => scanScoreSource([{ file: 'synthetic.ts', content }]);

    it('DETECTS a delegate create', () => {
      const found = scan(`await this.db.${DELEGATE}.create({ data: { childId, scorePercent: 90 } });`);
      expect(found.filter((s) => s.kind === 'WRITE')).toHaveLength(1);
    });

    it('DETECTS createMany and upsert too', () => {
      expect(scan(`this.prisma.${DELEGATE}.createMany({ data })`).filter((s) => s.kind === 'WRITE')).toHaveLength(1);
      expect(scan(`this.prisma.${DELEGATE}.upsert({ where, create, update })`).filter((s) => s.kind === 'WRITE')).toHaveLength(
        1,
      );
    });

    it('DETECTS a nested relation write, which never names the delegate', () => {
      const found = scan(`prisma.child.update({ data: { ${RELATION_FIELD}: { create: { scorePercent: 80 } } } })`);
      expect(found.filter((s) => s.kind === 'WRITE')).toHaveLength(1);
    });

    it('DETECTS a raw INSERT', () => {
      const found = scan('const SQL = `INSERT INTO learning_assessments (id, score_percent) VALUES ($1, $2)`;');
      expect(found.filter((s) => s.kind === 'WRITE')).toHaveLength(1);
    });

    it('does NOT count a read as a writer — the whole point of the guard', () => {
      const found = scan(`await this.db.${DELEGATE}.findFirst({ where: { childId } });`);
      expect(found.filter((s) => s.kind === 'WRITE')).toHaveLength(0);
      expect(found.filter((s) => s.kind === 'READ')).toHaveLength(1);
    });

    it('does NOT count a raw SELECT as a writer', () => {
      const found = scan('const SQL = `SELECT score_percent FROM learning_assessments WHERE child_id = $1`;');
      expect(found.filter((s) => s.kind === 'WRITE')).toHaveLength(0);
      expect(found.filter((s) => s.kind === 'READ')).toHaveLength(1);
    });

    it('does NOT count a write written in a COMMENT — a docstring is not a producer', () => {
      expect(scan(`// this.db.${DELEGATE}.create({ data });`)).toHaveLength(0);
      expect(scan(`/* someday: this.db.${DELEGATE}.create({ data }); */`)).toHaveLength(0);
      expect(scan(`/**\n * ${DELEGATE}.create is what this table is waiting for.\n */`)).toHaveLength(0);
    });

    it('does NOT match a different model whose name merely starts the same way', () => {
      expect(scan('await this.db.learningSession.create({ data });')).toHaveLength(0);
      expect(scan('const SQL = `INSERT INTO learning_assessments_archive (id) VALUES ($1)`;')).toHaveLength(0);
    });

    it('the stripper keeps strings intact, so a write is not lost to a URL in one', () => {
      const found = scan(`const doc = 'see https://x/y'; await this.db.${DELEGATE}.create({ data });`);
      expect(found.filter((s) => s.kind === 'WRITE')).toHaveLength(1);
    });
  });
});
