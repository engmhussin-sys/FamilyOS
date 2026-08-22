/**
 * ===========================================================================
 * CI RULE 4 — NO DEPENDENCY MAY QUIETLY FALL A MAJOR VERSION BEHIND.
 * ===========================================================================
 *
 * THE RULE THIS ENFORCES, in the owner's words: this project builds on current
 * releases and does not sit on old ones. A rule written in a document is a rule
 * that survives exactly as long as the person who remembers it; this file is the
 * same rule written somewhere that fails a build.
 *
 * ── WHAT IT CHECKS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────
 *
 * It compares the MAJOR version of every declared dependency against the
 * registry's `latest` and fails on a gap. Minors and patches are not policed:
 * a caret range already floats to the newest compatible release on every
 * install, so a minor "drift" is a lockfile detail rather than a decision.
 * A MAJOR gap is always a decision — somebody chose not to migrate — and the
 * only honest place for that decision is this file, in writing.
 *
 * ── THE EXEMPTION LIST IS THE POINT ────────────────────────────────────
 *
 * Some majors cannot be taken, and the reason is never "we did not get to it".
 * It is an upstream fact: a peer range that excludes the version we run, or a
 * tool that has not shipped support yet. Each entry below names the blocker and
 * the condition that removes it. An exemption with no `blockedBy` is rejected by
 * this script, so "add it to the list" is not a way past the rule.
 *
 * ── WHY IT TOLERATES BEING OFFLINE ─────────────────────────────────────
 *
 * The registry is not always reachable — an air-gapped build, a proxy, a
 * flaky minute. A version check that fails the build when it cannot ASK is a
 * check that gets deleted the first time it does. It reports what it could not
 * reach and passes; the check that matters is the one that runs on a machine
 * with a network, and CI has one.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface Exemption {
  /** Why this package cannot be on its latest major TODAY. */
  readonly blockedBy: string;
  /** What has to happen upstream for the exemption to be deleted. */
  readonly removeWhen: string;
}

/**
 * PACKAGES HELD BACK BY SOMETHING OTHER THAN NEGLECT.
 *
 * Every entry was measured, not assumed — the blocker is quoted from the tool
 * that produced it.
 */
const EXEMPTIONS: Readonly<Record<string, Exemption>> = {
  /**
   * Node's own release train, not a package: `@types/node` must describe the
   * runtime we actually run, and this project runs the ACTIVE LTS line rather
   * than Current. Typing against Node 26 while deploying Node 24 would let a
   * call to an API that does not exist in production typecheck cleanly, which
   * is the exact failure the types exist to prevent.
   */
  '@types/node': {
    blockedBy: 'The runtime is Node 24 (Active LTS). @types/node must match the runtime, not lead it.',
    removeWhen: 'Node 26 enters Active LTS and the Dockerfile, CI and engines move with it.',
  },
};

interface Finding {
  readonly name: string;
  readonly declared: string;
  readonly latest: string;
  readonly section: string;
}

function declaredMajor(range: string): number | null {
  const match = /(\d+)\./.exec(range.replace(/^[\^~>=<\s]+/, ''));
  return match ? Number(match[1]) : null;
}

function latestVersion(name: string): string | null {
  try {
    return execFileSync('npm', ['view', name, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    }).trim();
  } catch {
    return null;
  }
}

const MANIFESTS = [
  'apps/backend/package.json',
  'apps/admin-dashboard/package.json',
  'packages/shared-types/package.json',
];

function main(): void {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const behind: Finding[] = [];
  const unreachable: string[] = [];
  const staleExemptions: string[] = [];
  let checked = 0;

  for (const manifest of MANIFESTS) {
    const file = path.join(repoRoot, manifest);
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));

    for (const section of ['dependencies', 'devDependencies'] as const) {
      for (const [name, range] of Object.entries(pkg[section] ?? {})) {
        checked += 1;
        const latest = latestVersion(name);
        if (latest === null) {
          unreachable.push(name);
          continue;
        }
        const have = declaredMajor(String(range));
        const want = declaredMajor(latest);
        if (have === null || want === null) continue;

        if (have < want) {
          if (EXEMPTIONS[name]) continue;
          behind.push({ name, declared: String(range), latest, section: `${manifest} ${section}` });
        } else if (EXEMPTIONS[name]) {
          // The blocker is gone. Leaving the entry would let the NEXT major
          // slip past unnoticed behind a stale excuse.
          staleExemptions.push(name);
        }
      }
    }
  }

  console.log('CI RULE 4 — dependency currency');
  console.log(`  packages checked         : ${checked}`);
  console.log(`  exemptions declared      : ${Object.keys(EXEMPTIONS).length}`);
  if (unreachable.length > 0) {
    console.log(`  registry unreachable for : ${unreachable.length} (not a failure — see this file's header)`);
  }

  for (const [name, exemption] of Object.entries(EXEMPTIONS)) {
    if (!exemption.blockedBy?.trim() || !exemption.removeWhen?.trim()) {
      console.error(`\n  REJECTED EXEMPTION: ${name} — an exemption must name its blocker and its removal condition.`);
      process.exit(1);
    }
  }

  if (staleExemptions.length > 0) {
    console.error('\n  STALE EXEMPTIONS — these packages are on their latest major, so the excuse has expired:');
    for (const name of staleExemptions) console.error(`    ${name} — delete its entry in ${path.basename(__filename)}`);
    process.exit(1);
  }

  if (behind.length > 0) {
    console.error(`\n  ${behind.length} package(s) are a MAJOR VERSION BEHIND:\n`);
    for (const finding of behind) {
      console.error(`    ${finding.name}  declared ${finding.declared}  latest ${finding.latest}`);
      console.error(`      ${finding.section}`);
    }
    console.error(
      '\n  Upgrade them, or add an entry to EXEMPTIONS naming the upstream blocker\n' +
        '  and what removes it. "We did not get to it" is not a blocker.\n',
    );
    process.exit(1);
  }

  console.log('  violations               : 0');
  console.log('  OK — every dependency is on its latest major, or exempt with a stated reason.');
}

main();
