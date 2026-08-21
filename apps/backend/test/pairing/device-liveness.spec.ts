import * as fs from 'fs';
import * as path from 'path';

import {
  DEVICE_LIVENESS_BATCH_SIZE,
  DEVICE_STALE_AFTER_HOURS,
  isStale,
  staleCutoff,
} from '../../src/modules/pairing/domain/device-liveness';
import { DEVICE_LIVENESS_SWEEP_JOB } from '../../src/modules/scheduler/application/jobs/device-liveness-sweep.job';

/**
 * ===========================================================================
 * THE RULE, PROVEN WITHOUT A DATABASE — and the producer, proven to EXIST.
 * ===========================================================================
 *
 * Two different claims are made here and they need different kinds of proof.
 *
 * THE THRESHOLD IS A PURE FUNCTION, so its boundary is provable with three
 * dates and no infrastructure — the same discipline `job-schedule.spec.ts`
 * applies to the scheduler's own «is this family due» decision.
 *
 * THE PRODUCER EXISTING AT ALL is a claim about the SHAPE OF THE REPOSITORY,
 * not about a value, and it is the claim that matters most. `HEARTBEAT_MISSED`
 * sat in the enum and in the transition table with no writer for the entire
 * life of this product, and nothing failed — that is precisely why nobody
 * noticed. A unit test of the threshold would have passed just as happily on
 * the day before this producer was written. So the last test in this file goes
 * looking through `src/` for a writer, and fails if it disappears again.
 */

const ROOT = path.resolve(__dirname, '../..');

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.ts')) yield full;
  }
}

const HOUR = 3_600_000;
const NOW = new Date('2026-08-21T12:00:00.000Z');

describe('device liveness — when a device has stopped reporting', () => {
  it('the threshold is twenty-four hours, and the cutoff is derived from it', () => {
    expect(DEVICE_STALE_AFTER_HOURS).toBe(24);
    expect(staleCutoff(NOW).toISOString()).toBe('2026-08-20T12:00:00.000Z');
    // The cutoff is a pure function of `now`: same instant in, same instant out.
    expect(staleCutoff(NOW).getTime()).toBe(staleCutoff(NOW).getTime());
  });

  it('a device that beat a moment ago is not stale, and neither is one at exactly the threshold', () => {
    expect(isStale(new Date(NOW.getTime() - 30_000), NOW)).toBe(false);
    expect(isStale(new Date(NOW.getTime() - 23 * HOUR), NOW)).toBe(false);
    // EXCLUSIVE boundary: a device beating on a perfectly regular 24h schedule
    // must not be flagged by a sweep that happens to run a microsecond late.
    expect(isStale(new Date(NOW.getTime() - 24 * HOUR), NOW)).toBe(false);
  });

  it('a device silent for more than a day is stale', () => {
    expect(isStale(new Date(NOW.getTime() - 24 * HOUR - 1), NOW)).toBe(true);
    expect(isStale(new Date(NOW.getTime() - 72 * HOUR), NOW)).toBe(true);
  });

  it('a night, a school day and a doze window are all BELOW the threshold', () => {
    // This is the assertion the number exists for. A shorter threshold would
    // mark every device degraded every morning, which is a rooster, not a
    // signal — so the ordinary offline windows are pinned here by name.
    const overnight = 10 * HOUR;
    const schoolDayNoSignal = 8 * HOUR;
    const longDoze = 16 * HOUR;
    for (const window of [overnight, schoolDayNoSignal, longDoze]) {
      expect(isStale(new Date(NOW.getTime() - window), NOW)).toBe(false);
    }
  });

  it('never reports a device that has never sent a heartbeat', () => {
    // `null` is answered deliberately rather than left to a missing branch: a
    // device that never beat has never been HEALTHY, so HEARTBEAT_MISSED would
    // be an illegal transition for it anyway, and counting it as stale would
    // only produce a refusal that means something different from every other
    // refusal in the skip count.
    expect(isStale(null, NOW)).toBe(false);
  });

  it('is bounded, like every other sweep in this codebase', () => {
    expect(DEVICE_LIVENESS_BATCH_SIZE).toBeGreaterThan(0);
    expect(DEVICE_LIVENESS_BATCH_SIZE).toBeLessThanOrEqual(1_000);
  });

  /**
   * THE RATCHET. Everything above would have passed on the day before the
   * producer existed.
   */
  describe('the producer exists — the property that was missing for the whole life of this product', () => {
    const sources = [...walk(path.join(ROOT, 'src'))].map((file) => ({
      file,
      text: fs.readFileSync(file, 'utf8'),
    }));

    it('something in src/ actually emits HEARTBEAT_MISSED as an event, not just as a type', () => {
      const emitters = sources.filter(
        (s) =>
          /event:\s*'HEARTBEAT_MISSED'/.test(s.text) &&
          !s.file.includes(`${path.sep}domain${path.sep}`),
      );

      expect(emitters.map((s) => path.relative(ROOT, s.file))).toEqual([
        path.join('src', 'modules', 'pairing', 'application', 'services', 'device-liveness.service.ts'),
      ]);
    });

    it('the sweep is a registered job name, so the emitter has a clock', () => {
      expect(DEVICE_LIVENESS_SWEEP_JOB).toBe('device-liveness-sweep');

      const migrations = path.join(ROOT, 'prisma', 'migrations');
      const seeded = fs
        .readdirSync(migrations)
        .map((dir) => path.join(migrations, dir, 'migration.sql'))
        .filter((file) => fs.existsSync(file))
        .map((file) => fs.readFileSync(file, 'utf8'))
        .join('\n');

      // A producer with no `scheduled_jobs` row is the exact failure this whole
      // file exists to prevent, one layer up: an implementation with no
      // trigger, which never runs and never fails.
      expect(seeded).toContain(`'${DEVICE_LIVENESS_SWEEP_JOB}'`);
    });

    it('the sweep only ever looks at CHILD devices', () => {
      const service = sources.find((s) => s.file.endsWith('device-liveness.service.ts'));
      // Parent devices never call the heartbeat endpoint, so every one of them
      // is permanently stale. Dropping this filter would ship a sweep whose
      // findings are 100% false positives.
      expect(service?.text).toContain(`owner_type = 'CHILD'`);
    });

    it('the sweep has no "recovered" writer of its own', () => {
      const service = sources.find((s) => s.file.endsWith('device-liveness.service.ts'));
      // DEGRADED -> HEALTHY is already owned by `recordHeartbeat`. A second
      // writer for one state is how two writers disagree.
      expect(service?.text).not.toContain('HEARTBEAT_RECEIVED');
    });
  });
});
