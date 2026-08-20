/**
 * ============================================================================
 * ARCHITECTURE GUARD — `BADGE_EARNED` HAS NO PRODUCER AND NO READER, AND THE
 * ANNOUNCEMENT IT WOULD HAVE DUPLICATED STILL EXISTS.
 * ============================================================================
 *
 * THE DEFECT SHAPE, WHICH THIS REPOSITORY KEEPS PRODUCING. An event with a
 * producer and no reader is INDISTINGUISHABLE FROM A WORKING FEATURE. It
 * appears in `DOMAIN_EVENT_TYPES`, it has an idempotency-key rule, it is
 * written to the outbox, the relay publishes it, the relay marks it PUBLISHED —
 * and nothing happens, forever, because `IEventSubscriber` is a typed per-type
 * registry with NO WILDCARD (`event-bus.port.ts`, deliberately) and nobody ever
 * called `register('BADGE_EARNED', …)`.
 *
 * WHAT WAS DONE ABOUT IT, AND THE ARGUMENT. The PRODUCER WAS DELETED, from
 * `rewards-engine/application/consumers/reward-side-effect.consumer.ts`. The
 * alternative — give it a reader — was rejected on a fact rather than a
 * preference: THE BADGE ANNOUNCEMENT ALREADY HAPPENS, to BOTH audiences, on the
 * working path. `RewardsEngineService.processTriggerEvent` makes two
 * `notifyGrant` calls in one `if (granted)` branch — `BADGE_EARNED` for the
 * child and `BADGE_EARNED_PARENT` for the parent — synchronously, on the
 * request that earned the badge. A consumer of this event would therefore have
 * been a SECOND announcement: two notifications for one badge.
 *
 * (The producer was also UNREACHABLE: its branch needs a `BADGE` ledger row
 * under an achievement's key prefix, which needs a `RewardRule` with
 * `eventType: 'ACHIEVEMENT_VERIFIED'`, and none of the nine badge rules
 * migration 0026 seeds has one. But unreachability is not why it was deleted —
 * a reachable writer with no reader would have been deleted for the same
 * reason.)
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE CANNOT GO STALE, WHICH IS THE ONLY PROPERTY THAT MATTERS.
 *
 * The design is `test/architecture/dormant-schema.guard.spec.ts`'s and
 * `notification-producer-chain.guard.spec.ts`'s: a SCANNER that measures
 * production, a DECLARATION that must agree with it, and NEGATIVE CONTROLS that
 * prove the scanner actually discriminates rather than passing vacuously.
 *
 *   RULE B1  NEGATIVE CONTROL. The scanner finds `REWARD_GRANTED` — a REAL
 *            event with a real producer and a real reader. A scanner that found
 *            nothing would satisfy B2 and B3 while measuring nothing.
 *   RULE B2  NO PRODUCER. No file in `src/` emits `BADGE_EARNED`.
 *   RULE B3  NO READER. No file in `src/` registers for `BADGE_EARNED`.
 *   RULE B4  THE ANNOUNCEMENT SURVIVES. `RewardsEngineService` still notifies
 *            BOTH audiences for a badge. THIS IS THE RULE THAT MAKES B2 AND B3
 *            HONEST: without it they could be satisfied by deleting the feature.
 *   RULE B5  THE DECLARATION AGREES. `DOMAIN_EVENT_CATALOGUE.BADGE_EARNED` says «no
 *            producer, no consumers», so the written record and the scan cannot
 *            drift apart.
 *   RULE B6  NEGATIVE CONTROL. Fed source text that DOES re-add the producer or
 *            a reader, the scanner flags it. This is what proves B2/B3 would go
 *            red on a revert rather than being true of any input.
 *
 * If someone re-adds the emission, B2 and B6 disagree and B2 goes red naming the
 * file. If someone wires a consumer, B3 goes red. If someone removes the real
 * announcement in favour of an event-driven one, B4 goes red and the question it
 * forces is the right one: WHICH producer owns the badge announcement, because
 * two would be two notifications for one badge.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { DOMAIN_EVENT_CATALOGUE } from '../../src/shared/events/event-types';

const SRC = join(__dirname, '..', '..', 'src');

/** The catalogue is a DECLARATION of every event name; it names `BADGE_EARNED`
 *  by definition and is asserted separately by RULE B5. Scanning it for the
 *  literal would be scanning the map for the territory. */
const CATALOGUE_FILE = join('shared', 'events', 'event-types.ts');

function allTypeScriptFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      allTypeScriptFiles(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * COMMENTS ARE NOT CODE, and this guard depends on the difference: the deleted
 * producer left behind a long comment that names `BADGE_EARNED` many times and
 * explains why it must not return. A scanner that could not tell those apart
 * would go red on the very documentation that keeps the fix explained.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** An EMISSION: the event name in the `type:` position of an outbox write. */
const emits = (code: string, eventType: string): boolean =>
  new RegExp(`type:\\s*'${eventType}'`).test(code);

/** A READER: a registration on the typed bus. */
const registers = (code: string, eventType: string): boolean =>
  new RegExp(`register\\(\\s*'${eventType}'`).test(code);

interface Scan {
  readonly producers: string[];
  readonly readers: string[];
}

function scan(eventType: string, opts: { skipCatalogue: boolean }): Scan {
  const producers: string[] = [];
  const readers: string[] = [];
  for (const file of allTypeScriptFiles(SRC)) {
    const relative = file.slice(SRC.length + 1);
    if (opts.skipCatalogue && relative === CATALOGUE_FILE) continue;
    const code = stripComments(readFileSync(file, 'utf8'));
    if (emits(code, eventType)) producers.push(relative);
    if (registers(code, eventType)) readers.push(relative);
  }
  return { producers, readers };
}

describe('GUARD — BADGE_EARNED is dormant, and the badge announcement it would have duplicated is not', () => {
  // =========================================================================
  // RULE B1 — the scanner measures something real.
  // =========================================================================

  describe('RULE B1 — negative control: the scanner finds a genuinely live event', () => {
    it('REWARD_GRANTED has BOTH a producer and a reader, and the scanner sees both', () => {
      const live = scan('REWARD_GRANTED', { skipCatalogue: true });
      // One producer (`RewardsCompletionConsumer`) and at least one reader
      // (`RewardSideEffectConsumer`, `NotificationRewardConsumer`).
      expect(live.producers.length).toBeGreaterThan(0);
      expect(live.readers.length).toBeGreaterThan(0);
      expect(live.producers.some((f) => f.includes('rewards-completion.consumer'))).toBe(true);
      expect(live.readers.some((f) => f.includes('reward-side-effect.consumer'))).toBe(true);
    });
  });

  // =========================================================================
  // RULES B2 / B3 — the measurement.
  // =========================================================================

  describe('RULE B2 — BADGE_EARNED has no producer in src/', () => {
    it('nothing writes a BADGE_EARNED domain event', () => {
      const { producers } = scan('BADGE_EARNED', { skipCatalogue: true });
      expect(producers).toEqual([]);
    });
  });

  describe('RULE B3 — BADGE_EARNED has no reader in src/', () => {
    it('nothing registers a BADGE_EARNED consumer — and the bus has no wildcard to hide one', () => {
      const { readers } = scan('BADGE_EARNED', { skipCatalogue: true });
      expect(readers).toEqual([]);
    });
  });

  // =========================================================================
  // RULE B4 — the rule that makes B2 and B3 honest.
  // =========================================================================

  describe('RULE B4 — the real badge announcement still exists, to BOTH audiences', () => {
    const engine = stripComments(
      readFileSync(
        join(SRC, 'modules', 'life-intelligence', 'application', 'services', 'rewards-engine.service.ts'),
        'utf8',
      ),
    );

    it('RewardsEngineService notifies the CHILD with BADGE_EARNED', () => {
      expect(/notifyGrant\([^)]*'BADGE_EARNED'/.test(engine)).toBe(true);
    });

    it('RewardsEngineService notifies the PARENT with BADGE_EARNED_PARENT', () => {
      expect(/notifyGrant\([^)]*'BADGE_EARNED_PARENT'/.test(engine)).toBe(true);
    });

    /**
     * THE TWO CALLS SHARE ONE CAUSE. They are the reason a reader for the
     * domain event would have been a duplicate rather than a fix, so «are they
     * still both here» is the question this whole guard turns on.
     */
    it('both notifications are issued for the same badge grant, not from two unrelated places', () => {
      const badgeBranch = engine.slice(
        engine.indexOf("rewardType === 'BADGE'"),
        engine.indexOf("rewardType === 'BADGE'") + 3000,
      );
      expect(badgeBranch).toContain("'BADGE_EARNED'");
      expect(badgeBranch).toContain("'BADGE_EARNED_PARENT'");
    });
  });

  // =========================================================================
  // RULE B5 — the written record agrees with the measurement.
  // =========================================================================

  describe('RULE B5 — DOMAIN_EVENT_CATALOGUE declares the dormancy rather than describing a producer', () => {
    it('the catalogue entry names NO producer and NO consumer', () => {
      const entry = DOMAIN_EVENT_CATALOGUE.BADGE_EARNED;
      expect(entry).toBeDefined();
      expect(entry.producer.toLowerCase()).toContain('none');
      expect(entry.consumers).toHaveLength(1);
      expect(entry.consumers[0].toLowerCase()).toContain('none');
    });

    it('and it points at the producer that DOES own the announcement', () => {
      expect(DOMAIN_EVENT_CATALOGUE.BADGE_EARNED.producer).toContain('RewardsEngineService');
    });

    it('it is not device-ingestible — a device could never mint itself a badge event', () => {
      expect(DOMAIN_EVENT_CATALOGUE.BADGE_EARNED.deviceIngestible).toBe(false);
    });
  });

  // =========================================================================
  // RULE B6 — the scanner would actually catch a revert.
  // =========================================================================

  describe('RULE B6 — negative control: the scanner flags a re-added producer or reader', () => {
    it('a re-added outbox emission is detected', () => {
      const reverted = `
        await this.outbox.write({
          type: 'BADGE_EARNED',
          aggregateType: 'ChildBadgeAward',
          childId,
        });
      `;
      expect(emits(stripComments(reverted), 'BADGE_EARNED')).toBe(true);
    });

    it('a re-added consumer registration is detected', () => {
      const reverted = `this.bus.register('BADGE_EARNED', SOME_CONSUMER, (e) => this.handle(e));`;
      expect(registers(stripComments(reverted), 'BADGE_EARNED')).toBe(true);
    });

    /**
     * AND THE COMMENT STRIPPER DOES NOT SWALLOW REAL CODE. The deleted
     * producer's explanation quotes the emission it removed; if `stripComments`
     * were wrong in the other direction — stripping code — B2 and B3 would pass
     * for a codebase that had fully reverted.
     */
    it('the stripper removes only comments, and leaves an emission that follows one', () => {
      const mixed = `
        /* type: 'BADGE_EARNED' — this mention is prose and must NOT count. */
        // type: 'BADGE_EARNED' — so is this one.
        await this.outbox.write({ type: 'BADGE_EARNED' });
      `;
      const stripped = stripComments(mixed);
      expect(stripped).not.toContain('prose');
      expect(emits(stripped, 'BADGE_EARNED')).toBe(true);

      const commentOnly = `
        /* type: 'BADGE_EARNED' — removed; see the argument above. */
        // register('BADGE_EARNED', X, h) used to be here.
      `;
      expect(emits(stripComments(commentOnly), 'BADGE_EARNED')).toBe(false);
      expect(registers(stripComments(commentOnly), 'BADGE_EARNED')).toBe(false);
    });
  });
});
