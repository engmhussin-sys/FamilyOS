#!/usr/bin/env tsx
/**
 * ===========================================================================
 * CI RULE 5 — EVERY PACKAGE `src/` IMPORTS MUST BE A *RUNTIME* DEPENDENCY.
 * ===========================================================================
 *
 * WHY THIS EXISTS. Three separate release-blocking defects of the SAME SHAPE
 * were found in one review, and none of them was reachable by any test:
 *
 *   `dotenv`             imported by `prisma.config.ts`, declared in
 *                        devDependencies. `npm ci --omit=dev` drops it, so the
 *                        Prisma CLI inside the image could not load its own
 *                        configuration.
 *   `@prisma/adapter-pg` imported by `PrismaService` — production code —
 *                        declared in devDependencies. THE CONTAINER CRASHED ON
 *                        STARTUP: `Cannot find module 'pg'`, from inside the
 *                        adapter, because the image got the adapter through the
 *                        Dockerfile's hand-copied `node_modules/@prisma` and
 *                        therefore WITHOUT its own dependency tree.
 *   `prisma`             imported by `prisma.config.ts` for `defineConfig`,
 *                        declared in devDependencies. Present in the image only
 *                        by a hand-maintained COPY line.
 *
 * They were found by reproducing the Docker runtime stage on disk and booting
 * it, because THE TEST SUITE CANNOT SEE THIS. Tests run with the full dev
 * install; the failure only exists in an image built with `--omit=dev`. That is
 * the definition of a gap a guard has to close, because no amount of
 * test-writing will.
 *
 * ── WHAT THIS GUARD DOES *NOT* CATCH, STATED PLAINLY ───────────────────
 *
 * It reads FIRST-PARTY imports. `pg` itself is never imported by `src/` — it
 * arrives as a dependency of `@prisma/adapter-pg`, and npm installs it
 * transitively as soon as the adapter is a runtime dependency. So the guard
 * catches the CAUSE (`@prisma/adapter-pg` in the wrong section) and not the
 * SYMPTOM (`pg` missing), which is the right place to catch it — but do not
 * read this file as proving the whole production tree resolves.
 *
 * The thing that proves THAT is booting the runtime stage, and it is worth
 * doing before any release: reproduce the Dockerfile's runtime COPY set into an
 * empty directory, `npm ci --omit=dev`, copy `.prisma`/`@prisma`/`prisma` from
 * a full install, and start `dist/main.js`. Ten minutes, and it is how the two
 * defects above were found.
 *
 * WHAT IT CHECKS. Every bare module specifier imported anywhere under `src/`
 * resolves to a package named in `dependencies`. Node builtins are skipped;
 * relative paths are skipped; TYPE-ONLY imports are skipped, because
 * `import type` is erased by the compiler and genuinely does not need to exist
 * at runtime.
 *
 * IT ALSO CHECKS THE FILES THE IMAGE RUNS OUTSIDE `src/`: `prisma.config.ts`
 * is loaded by the Prisma CLI in the runtime stage, and it is where the
 * `dotenv` defect actually lived.
 *
 * Run: npm run ci:runtime-deps
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const PACKAGE_JSON = path.join(ROOT, 'package.json');

/**
 * Files outside `src/` that the RUNTIME stage of the Dockerfile copies and
 * executes. Listed by hand, and short on purpose: if the Dockerfile starts
 * copying something else that imports a package, it belongs here.
 */
const EXTRA_RUNTIME_FILES = ['prisma.config.ts'];

interface Violation {
  readonly pkg: string;
  readonly file: string;
  readonly line: number;
}

const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const runtimeDeps = new Set(Object.keys(pkg.dependencies ?? {}));
const devDeps = new Set(Object.keys(pkg.devDependencies ?? {}));

/** Node's own modules, which are never declared and always present. */
const BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'trace_events', 'tty', 'url',
  'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function isBare(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:');
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

/**
 * A line is TYPE-ONLY when the import itself is erased at compile time. Two
 * forms count: `import type ...` and `export type ... from`. An inline
 * `import { type A, B }` still emits a require for `B`, so it is NOT skipped —
 * treating it as type-only is how a guard like this lets a real one through.
 */
function isTypeOnly(line: string): boolean {
  return /^\s*(import|export)\s+type\s/.test(line);
}

const IMPORT_PATTERNS = [
  /(?:^|[^.\w])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]/,
  /(?:^|[^.\w])import\s*\(\s*['"]([^'"]+)['"]\s*\)/,
  /(?:^|[^.\w])require\s*\(\s*['"]([^'"]+)['"]\s*\)/,
  /^\s*import\s+['"]([^'"]+)['"]/,
];

const violations: Violation[] = [];
const seen = new Map<string, number>();

const files = [
  ...walk(SRC),
  ...EXTRA_RUNTIME_FILES.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
];

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (isTypeOnly(line)) return;
    for (const pattern of IMPORT_PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      const specifier = match[1];
      if (!isBare(specifier)) continue;
      const name = packageOf(specifier);
      if (BUILTINS.has(name)) continue;
      seen.set(name, (seen.get(name) ?? 0) + 1);
      if (!runtimeDeps.has(name)) {
        violations.push({ pkg: name, file: path.relative(ROOT, file), line: i + 1 });
      }
      break;
    }
  });
}

console.log('CI RULE 5 — runtime dependency completeness');
console.log(`  files scanned            : ${files.length}`);
console.log(`  distinct packages used   : ${seen.size}`);
console.log(`  declared as dependencies : ${runtimeDeps.size}`);
console.log(`  declared as dev only     : ${devDeps.size}`);

if (violations.length > 0) {
  const byPackage = new Map<string, Violation[]>();
  for (const v of violations) {
    const list = byPackage.get(v.pkg) ?? [];
    list.push(v);
    byPackage.set(v.pkg, list);
  }

  console.log(`\n  violations               : ${byPackage.size}\n`);
  for (const [name, list] of byPackage) {
    const where = devDeps.has(name) ? 'devDependencies' : 'NOT DECLARED AT ALL';
    console.log(`  ✗ ${name}  (${where})`);
    for (const v of list.slice(0, 4)) console.log(`      ${v.file}:${v.line}`);
    if (list.length > 4) console.log(`      … and ${list.length - 4} more`);
  }
  console.log(
    '\n  These are imported by code that RUNS IN PRODUCTION, and the runtime image\n' +
      '  installs with `npm ci --omit=dev`. The container will fail — at startup with\n' +
      '  "Cannot find module", or at deploy time inside the Prisma CLI.\n' +
      '\n  Move each one into `dependencies` in apps/backend/package.json.\n' +
      '  If an import is genuinely types-only, write it as `import type`.\n',
  );
  process.exit(1);
}

console.log('  violations               : 0');
console.log('  OK — every package production code imports is a runtime dependency.');
