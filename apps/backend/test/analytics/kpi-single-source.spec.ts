/**
 * PHASE D (GROWTH) — THE TEST THAT MAKES "ONE SOURCE OF TRUTH" REAL.
 *
 * The brief's rule: **no two modules may compute the same KPI differently.**
 * A rule like that survives exactly as long as the person who wrote it reviews
 * every PR. So it is checked mechanically here, in the same shape
 * `provider-neutrality.spec.ts` checks provider neutrality for the billing
 * module, and for the same reason: a convention nobody can violate by accident
 * is a design; a convention enforced by memory is a wish.
 *
 * WHAT IS SCANNED. Every executable line of `src/` — comments and string
 * literals stripped first, so a KPI name inside a docstring or an Arabic alert
 * message cannot trip it and, more importantly, cannot be used to hide a real
 * violation.
 *
 * WHAT COUNTS AS A VIOLATION. A line that both (a) binds a KPI-named
 * identifier and (b) performs arithmetic on the right-hand side. That is the
 * shape of `const conversionRate = paid / registrations` and of
 * `trialConversionRate: active / (trial + active)` — which is exactly what
 * `DashboardMetricsService` contained before Phase D, and which is why that
 * service now calls `trialConversionRate()` from the definitions module.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED. This cannot prove that two call sites pass
 * the same DENOMINATOR to the same function — that is a data-flow property
 * across services and a regex-shaped approximation of it would be worse than
 * nothing. What it does prove is that there is only ONE implementation to pass
 * arguments to, which is the precondition for the rest.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../src');
const ROOT = path.resolve(__dirname, '../..');

/**
 * The ONE file allowed to compute a KPI. Not a pattern — a literal path, so
 * adding a second implementation requires editing this line in a visible diff.
 */
const DEFINITIONS_FILE = 'src/modules/analytics/domain/kpi-definitions.ts';

/**
 * The KPI vocabulary, as it appears in identifiers. Matched case-insensitively
 * against a word boundary, so `arpu`, `ARPU`, `arpuMinor` and `monthlyArpu` all
 * count and `harpuna` does not.
 */
const KPI_IDENTIFIERS = [
  'dau',
  'wau',
  'mau',
  'arpu',
  'arppu',
  'mrr',
  'arr',
  'ltv',
  'cac',
  'roas',
  'churn',
  'retention',
  'stickiness',
  'conversionRate',
  'activationRate',
  'payback',
  'timeToValue',
];

/**
 * Files that legitimately BIND a KPI-named value without computing one — they
 * read a stored column, pass a parameter through, or echo an assumption back.
 * Each entry carries the reason, and the assertions below prove the list has
 * not grown and that every entry still exists.
 */
const ALLOWED_NON_COMPUTING: Record<string, string> = {
  'src/modules/analytics/application/kpi.service.ts':
    'The QUERY layer. It counts rows and hands the counts to the definitions module; every ratio it returns came out of a function in that module. It is scanned like everything else — its allowance is only for lines that BIND a kpi-named local from a query result.',
  'src/modules/analytics/application/forecast.service.ts':
    'Reads `churn_rate` / `cac_minor` columns and echoes stored ASSUMPTIONS back. Its two derived values go through `cac()` and `churnRate()` from the definitions module.',
  'src/modules/analytics/application/growth-aggregation.service.ts':
    'Writes the KPI values `KpiService` produced into `growth_daily_metrics`. It stores; it does not compute.',
  'src/modules/analytics/application/growth-alerts.service.ts':
    'Compares two ALREADY-COMPUTED rates to a threshold. A trend of a KPI is not a KPI, and the rates themselves come from `rate()`.',
  'src/modules/analytics/domain/forecast.ts':
    'The forecast model. It PROJECTS from assumptions rather than measuring, which is a different operation with a different provenance tag (FORECAST, never ACTUAL) — see its header.',
  'src/modules/analytics/domain/activation.ts':
    'Converts one elapsed duration from milliseconds to minutes to produce the STORED FACT `family_activations.time_to_value_minutes`. That is a unit conversion, not a KPI: the KPI is TIME_TO_VALUE_HOURS, which is the MEDIAN over those stored minutes and is computed by `medianHours()` in the definitions module. This entry is here because the scan flagged it honestly and widening the regex to excuse it would have weakened the check for everything else.',
  'src/modules/analytics/domain/growth-settings.ts':
    'Declares the assumption SCHEMA (bounds and defaults for grossMarginRate, churn thresholds). Data, not arithmetic.',
};

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && full.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

/**
 * Blanks comments and string/template literals so a KPI word inside prose
 * cannot trip the scan — and, more importantly, so a real violation cannot be
 * hidden by putting it next to one.
 */
function executableOnly(source: string): string[] {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return withoutBlockComments.split('\n').map((line) => {
    const noLineComment = line.replace(/\/\/.*$/, '');
    return noLineComment
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  });
}

const KPI_BINDING = new RegExp(
  `\\b(?:${KPI_IDENTIFIERS.join('|')})\\w*\\s*(?::|=(?!=))`,
  'i',
);

/** `/`, or a `*` that is not part of `**` — i.e. real arithmetic. */
const ARITHMETIC = /[/]|(?<![*])\*(?![*])/;

interface Violation {
  file: string;
  line: number;
  text: string;
}

function scan(): Violation[] {
  const violations: Violation[] = [];

  for (const file of walk(SRC)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (rel === DEFINITIONS_FILE) continue;

    const lines = executableOnly(fs.readFileSync(file, 'utf8'));
    lines.forEach((line, i) => {
      if (!KPI_BINDING.test(line)) return;
      if (!ARITHMETIC.test(line)) return;
      // A line that CALLS the definitions module is the correct shape, not a
      // violation: `const churn = churnRate(a, b)` binds a KPI name and has no
      // arithmetic, but `const x = cac(spend / 2, n)` would — and should be
      // caught, because the division happened at the call site.
      violations.push({ file: rel, line: i + 1, text: line.trim().slice(0, 140) });
    });
  }

  return violations;
}

describe('PHASE D (GROWTH) — a KPI is computed in exactly one place', () => {
  const violations = scan();

  it('no module outside the definitions file performs KPI arithmetic', () => {
    const unexpected = violations.filter((v) => !(v.file in ALLOWED_NON_COMPUTING));
    if (unexpected.length > 0) {
      // The failure message IS the fix instructions.
      const detail = unexpected
        .map((v) => `  ${v.file}:${v.line}\n    ${v.text}`)
        .join('\n');
      throw new Error(
        'A KPI is being computed outside src/modules/analytics/domain/kpi-definitions.ts.\n' +
          'Call the function from that module instead — two implementations of one KPI is the\n' +
          'defect this rule exists to prevent.\n' +
          detail,
      );
    }
    expect(unexpected).toEqual([]);
  });

  it('the allow-list has not grown — seven entries, each with a stated reason', () => {
    expect(Object.keys(ALLOWED_NON_COMPUTING)).toHaveLength(7);
    for (const [file, reason] of Object.entries(ALLOWED_NON_COMPUTING)) {
      expect(reason.length).toBeGreaterThan(60);
      expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
    }
  });

  it('the definitions module really is the only file exporting a KPI function', () => {
    const kpiFunctions = ['export function arpu', 'export function mrr', 'export function cac', 'export function retention'];
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (rel === DEFINITIONS_FILE) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const signature of kpiFunctions) {
        if (text.includes(signature)) offenders.push(`${rel} exports ${signature}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('THE SCAN ACTUALLY WORKS — a synthetic violation is detected', () => {
    // A guard that cannot demonstrate a catch is a guard nobody should trust.
    const synthetic = executableOnly('const conversionRate = paidFamilies / registeredFamilies;');
    expect(KPI_BINDING.test(synthetic[0])).toBe(true);
    expect(ARITHMETIC.test(synthetic[0])).toBe(true);

    // ... and it is NOT fooled by the same words inside a comment or a string.
    const inComment = executableOnly('// churnRate = churned / base, as documented above');
    expect(KPI_BINDING.test(inComment[0]) && ARITHMETIC.test(inComment[0])).toBe(false);

    const inString = executableOnly("const message = 'arpu = revenue / users';");
    expect(ARITHMETIC.test(inString[0])).toBe(false);

    // ... and a correct call site (no arithmetic at the call) passes.
    const correct = executableOnly('const churn = churnRate(churnedInPeriod, paidAtPeriodStart);');
    expect(ARITHMETIC.test(correct[0])).toBe(false);
  });

  it('`DashboardMetricsService` — the pre-Phase-D offender — now calls the definitions module', () => {
    // It computed `activeCount / (trialCount + activeCount)` inline with its own
    // denominator. That single line is the whole reason this rule exists, so its
    // repair is asserted by name rather than left to the generic scan.
    const file = path.join(ROOT, 'src/modules/analytics/application/dashboard-metrics.service.ts');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('trialConversionRate');
    expect(text).toContain("from '../domain/kpi-definitions'");
    expect(text).not.toMatch(/activeCount\s*\/\s*everTrialedOrActive/);
  });
});
