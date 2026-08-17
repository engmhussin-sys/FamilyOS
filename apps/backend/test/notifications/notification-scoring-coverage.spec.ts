/**
 * PHASE F (`PF-E-003`) — THE GUARD FOR A CLASS OF DEFECT, NOT FOR ONE DEFECT.
 *
 * WHAT WAS MEASURED, AND WHY A UNIT TEST WOULD NOT HAVE FOUND IT.
 * `GOAL_COMPLETED_PARENT` is the sentence the Phase F report puts forward as
 * the example of a meaningful parent notification — «محمد أكمل هدفه في سورة
 * الملك، وهذه ثالث مرة هذا الأسبوع». It was written into `COPY_CATALOGUE`,
 * rendered correctly, banded correctly, persisted correctly — and SUPPRESSED
 * every single time, because its type had no row in `notification-class.ts`, no
 * row in `URGENCY_BY_TYPE` and no row in `ACHIEVEMENT_BASELINE_BY_TYPE`. Three
 * absent rows, no error, no warning, a score of ≈23 against a floor of 25, and
 * a decision row that said `SCORE_BELOW_FLOOR` as if the arithmetic had been
 * asked a question and answered it.
 *
 * Every individual piece was green. `notification-copy.spec.ts` proved the
 * sentence rendered. `notification-scoring.spec.ts` proved the arithmetic
 * reconciled. `notification-class.spec.ts` proved every type IT KNEW ABOUT was
 * classified. Nothing asserted the one property that actually matters:
 *
 *   A NOTIFICATION TYPE A PRODUCER CAN EMIT MUST BE ABLE TO ARRIVE.
 *
 * That is what this file asserts, and it asserts it about a set it DISCOVERS
 * rather than a set somebody remembered to list — because «find the hole by
 * hand» is precisely the method that already missed this one for a whole phase.
 *
 * THE THREE OBLIGATIONS, in increasing strength:
 *   1. every reachable type is CLASSIFIED (quiet-hours class, audience,
 *      category) — the Phase D matrix, over a broader producer set;
 *   2. every reachable type has an EXPLICIT row in both scoring tables. An
 *      explicit `0` is a decision («a hydration nudge celebrates nothing»); a
 *      missing row is an accident that reads identically in the output and
 *      differs entirely in intent;
 *   3. every reachable type CLEARS THE SUPPRESSION FLOOR in the household state
 *      a producer that supplies no extra facts actually creates. Not the best
 *      case — the best case would have scored `GOAL_COMPLETED_PARENT` at 41 and
 *      this file would have shipped green next to the defect.
 */
import * as fs from 'fs';
import * as path from 'path';

import { NOTIFICATION_CLASSES } from '../../src/shared/notifications/notification-class';
import {
  ACHIEVEMENT_BASELINE_BY_TYPE,
  URGENCY_BY_TYPE,
  scoreNotification,
} from '../../src/modules/notifications/domain/engine/notification-scoring';
import { COPY_CATALOGUE } from '../../src/modules/notifications/domain/engine/notification-copy';
import { resolveNotificationPolicy } from '../../src/modules/notifications/domain/engine/notification-policy';
import type { NotificationContext } from '../../src/modules/notifications/domain/engine/notification-context';
import { notificationCategoryOf } from '../../src/shared/notifications/notification-class';

const SRC = path.resolve(__dirname, '../../src');

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && full.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

/**
 * THE FOUR DOORS INTO THE NOTIFICATION SURFACE. A file that calls one of them
 * is, by definition, a producer.
 *
 *   `handleEvent`          — `SmartNotificationEngineService`, the F6 entry point.
 *   `notifyEvent`          — `SmartNotificationIntegrationService`, Sprint 16.2's.
 *   `deliverNow`           — the release path and the digest.
 *   `createForFamilyOwner` — the repository itself. Two safety producers still
 *                            write through it directly (`RuntimeAlertService`,
 *                            `DistressEscalationService`), which is a Phase D
 *                            decision this phase did not overturn. They are
 *                            IN this guard anyway: a type that reaches a parent
 *                            by a shorter road is still a type that reaches a
 *                            parent, and its tables must be complete for the day
 *                            it is routed.
 *
 * Discovered rather than listed, so a producer added tomorrow is inside this
 * guard on the day it is written and not on the day somebody remembers it.
 */
const PRODUCER_ENTRY_POINTS = /\.(handleEvent|notifyEvent|deliverNow|createForFamilyOwner)\s*\(/;

/**
 * The files that DEFINE those methods rather than calling them. Excluded by
 * path because they mention every type in their own docstrings, and a guard
 * that counted a comment as a producer would be a guard nobody could keep
 * green.
 */
const IMPLEMENTATION_FILES = [
  'modules/life-intelligence/application/services/smart-notification-integration.service.ts',
  'modules/notification-engine/application/services/smart-notification-engine.service.ts',
].map((p) => path.join(SRC, p));

/**
 * THE ONE THING THE STATIC SWEEP CANNOT SEE, stated explicitly rather than
 * left to a regex that would have to understand TypeScript.
 *
 * `DigitalWellbeingEngineService.recordCriticalEvent` passes
 * `input.eventType` — a `CriticalWellbeingEventType`, whose five members live
 * in `modules/life-intelligence/domain/digital-wellbeing.types.ts`. The union
 * is READ from that file rather than copied here, so adding a sixth member
 * puts it inside this guard automatically.
 */
function criticalWellbeingEventTypes(): string[] {
  const text = fs.readFileSync(
    path.join(SRC, 'modules/life-intelligence/domain/digital-wellbeing.types.ts'),
    'utf8',
  );
  const union = /export type CriticalWellbeingEventType =([\s\S]*?);/.exec(text);
  expect(union).not.toBeNull();
  return [...(union as RegExpExecArray)[1].matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]);
}

/**
 * Types reachable from a producer, discovered statically.
 *
 * A literal counts when it appears in a producer file AND is a key of the
 * matrix. That rule is DELIBERATELY GENEROUS in one direction — a type
 * mentioned in a producer's comment counts — for the reason
 * `notification-class.spec.ts` gives about its own sweep: a false positive
 * costs one table row, a false negative costs a notification that can never
 * arrive and that nobody will look for.
 *
 * Exported constants are followed one hop (`QUIET_HOURS_DIGEST_TYPE` is
 * declared in `notification-delivery.types.ts` and used by the release path),
 * because a producer that names its type through a shared constant is being
 * MORE careful, not less, and must not thereby fall out of the guard.
 */
function reachableNotificationTypes(): string[] {
  const files = walk(SRC);
  const classified = new Set(Object.keys(NOTIFICATION_CLASSES));

  // One hop: `export const NAME = 'CLASSIFIED_TYPE'`.
  const constants = new Map<string, string>();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/export const ([A-Z][A-Z0-9_]+)\s*=\s*'([A-Z][A-Z0-9_]+)'/g)) {
      if (classified.has(match[2])) constants.set(match[1], match[2]);
    }
  }

  const reachable = new Set<string>(criticalWellbeingEventTypes());
  for (const file of files) {
    if (IMPLEMENTATION_FILES.includes(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!PRODUCER_ENTRY_POINTS.test(text)) continue;
    for (const match of text.matchAll(/'([A-Z][A-Z0-9_]{3,})'/g)) {
      if (classified.has(match[1])) reachable.add(match[1]);
    }
    for (const [name, type] of constants) {
      if (new RegExp(`\\b${name}\\b`).test(text)) reachable.add(type);
    }
  }
  return [...reachable].sort();
}

/**
 * THE SET THIS FILE ACTUALLY GOVERNS: a producer emits it, OR the localisation
 * catalogue has a written sentence for it.
 *
 * THE SECOND HALF IS WHY THE GUARD IS WORTH HAVING. `GOAL_COMPLETED_PARENT` —
 * `PF-E-003` itself — has no producer even now; the sentence the Phase F report
 * advertises as the example of a meaningful parent notification was written,
 * shipped, and left waiting for a caller. A guard scoped to producers alone
 * would have declared it out of scope and stayed green next to the defect it
 * exists for.
 *
 * WRITING THE SENTENCE IS THE COMMITMENT. Somebody sat down, chose a register,
 * wrote the Arabic and the English, and put it in the catalogue — that is the
 * product saying it intends to send this. From that moment the scoring tables
 * owe it an answer, and «it scores 23 against a floor of 25» must be a
 * DELIBERATE answer rather than three rows nobody wrote.
 *
 * A type with NEITHER a producer NOR a sentence is not yet a feature. Those are
 * enumerated by the last test in this file, so the transition is visible.
 */
function advertisedNotificationTypes(): string[] {
  const withCopy = Object.keys(COPY_CATALOGUE).filter((key) => key in NOTIFICATION_CLASSES);
  return [...new Set([...reachableNotificationTypes(), ...withCopy])].sort();
}

/**
 * THE HOUSEHOLD A PRODUCER ACTUALLY CREATES, and the reason this file catches
 * `PF-E-003` where a "best case" fixture would not.
 *
 * Every field below is the value `NotificationContextAssembler` produces for a
 * producer that supplies nothing beyond the four required inputs: no activity
 * facts (so `isEngagedNow` is false, `minutesSinceLastActivity` is `null` and
 * `completionsToday` is 0), no goal, no reward, no streak, the default
 * appetite, an empty history and a quiet-hours window that is not active. That
 * is the WEAKEST honest context, and it is the one every domain-event producer
 * in this codebase hands over today.
 *
 * A type that cannot clear the floor from here cannot be delivered by the
 * product, whatever it scores in a fixture built to flatter it.
 */
function bareContext(eventType: string): NotificationContext {
  return {
    familyId: '00000000-0000-0000-0000-000000000001',
    childId: '00000000-0000-0000-0000-000000000002',
    childAgeYears: 10,
    toneBand: '8-10',
    safetyBand: '9-11',
    locale: 'ar',
    timeZone: 'Africa/Cairo',
    countryCode: null,
    event: { eventType, sourceEventId: `guard:${eventType}`, trigger: 'DOMAIN_EVENT', variables: {} },
    recentActivity: { completionsToday: 0, minutesSinceLastActivity: null, isEngagedNow: false },
    recentNotifications: [],
    goal: null,
    reward: null,
    streak: null,
    preferences: { parentCategories: {}, childCategories: {}, parentAppetite: 0.6 },
    quietHours: { startHHMM: '21:00', endHHMM: '07:00', isActiveNow: false, localTimeHHMM: '17:00' },
    subscription: { plan: 'FREE', isActive: false },
    now: new Date('2026-01-15T15:00:00.000Z'),
    childDisplayName: 'محمد',
  };
}

describe('PHASE F (PF-E-003) — every notification type a producer can emit must be able to arrive', () => {
  const reachable = advertisedNotificationTypes();
  const policy = resolveNotificationPolicy({});

  it('the sweep finds the producers this product actually has — it is not vacuously green', () => {
    // A discovery-based guard that discovers nothing passes forever. These are
    // the types the product demonstrably emits today, on the reward loop, the
    // wellbeing loop and the release path; if the sweep stops seeing them, the
    // sweep is broken and not the code.
    // Emitted by a producer TODAY, over HTTP or over the outbox, verified by
    // the golden suite: the reward loop, the wellbeing loop, the badge and
    // level-up path, the distress escalation and the quiet-hours release.
    expect(reachableNotificationTypes()).toEqual(
      expect.arrayContaining([
        'REWARD_GRANTED',
        'BADGE_EARNED',
        'BADGE_EARNED_PARENT',
        'LEVEL_UP',
        'ACCESSIBILITY_DISABLED',
        'PROTECTION_BYPASS_ATTEMPT',
        'SCREEN_TIME_EXCEEDED',
        'POLICY_VIOLATION',
        'CHILD_REQUEST',
        'CHILD_WELLBEING_CHECKIN',
        'QUIET_HOURS_DIGEST',
      ]),
    );
    expect(reachable.length).toBeGreaterThanOrEqual(20);
  });

  it('1. every reachable type is CLASSIFIED — quiet-hours class, audience and category', () => {
    const missing = reachable.filter((type) => !NOTIFICATION_CLASSES[type]);
    expect(missing).toEqual([]);
  });

  it('2. every reachable type has an EXPLICIT row in URGENCY_BY_TYPE', () => {
    // `?? DEFAULT_URGENCY` is a safety net, and a safety net that a shipped
    // producer is standing on is a decision nobody made.
    const missing = reachable.filter((type) => !(type in URGENCY_BY_TYPE));
    expect(missing).toEqual([]);
  });

  it('2b. every reachable type has an EXPLICIT row in ACHIEVEMENT_BASELINE_BY_TYPE, including the zeros', () => {
    // THE ROW WHOSE ABSENCE WAS `PF-E-003`. An explicit 0 and a missing key
    // produce the identical score and mean opposite things.
    const missing = reachable.filter((type) => !(type in ACHIEVEMENT_BASELINE_BY_TYPE));
    expect(missing).toEqual([]);
  });

  it('3. every reachable type CLEARS THE SUPPRESSION FLOOR from a bare, quiet household', () => {
    const suppressed: string[] = [];
    for (const type of reachable) {
      const context = bareContext(type);
      const score = scoreNotification(context, policy, notificationCategoryOf(type));
      if (score.band === 'SUPPRESS') suppressed.push(`${type}=${score.total}`);
    }
    // Before this phase this array read `['GOAL_COMPLETED_PARENT=23']` and the
    // product's advertised parent sentence could not be delivered by any
    // household in any state.
    expect(suppressed).toEqual([]);
  });

  it('4. every reachable type renders its OWN copy — none of them falls through to GENERIC', () => {
    // A type that clears the floor and then renders «لديك تحديث جديد داخل
    // التطبيق» has arrived and said nothing. The copy key is usually the type;
    // where it is not, the producer names the key and the type still needs an
    // entry, so the assertion is on the type.
    const generic = reachable.filter((type) => !COPY_CATALOGUE[type]);
    expect(generic).toEqual([]);
  });

  it('5. the copy catalogue and the matrix agree about the category of every reachable type', () => {
    // Two tables, one vocabulary. If they disagree, the per-category cap counts
    // against one category and the copy is chosen for another, and the
    // suppression rate becomes uninterpretable.
    const disagreements = reachable
      .filter((type) => COPY_CATALOGUE[type] && COPY_CATALOGUE[type].category !== notificationCategoryOf(type))
      .map((type) => `${type}: copy=${COPY_CATALOGUE[type].category} matrix=${notificationCategoryOf(type)}`);
    expect(disagreements).toEqual([]);
  });

  it('a type NOBODY produces yet is deliberately outside the guard, and the guard says which', () => {
    // The billing and AI surfaces are classified ahead of their producers
    // (`notification-class.ts` argues for that). They are NOT asserted
    // deliverable, because they are not reachable — and the moment a producer
    // ships one, the sweep picks it up and obligations 1-5 apply to it. This
    // test states which types are in that position TODAY, so the transition is
    // visible in a diff rather than silent.
    const notYetAdvertised = Object.keys(NOTIFICATION_CLASSES).filter((t) => !reachable.includes(t));
    expect(notYetAdvertised.sort()).toEqual(
      [
        // The AI and billing surfaces: classified in advance by
        // `notification-class.ts` on purpose, with no producer and no sentence.
        'AI_RECOMMENDATION',
        'FAMILY_INSIGHT',
        'PAYMENT_SUCCEEDED',
        'SUBSCRIPTION_EXPIRED',
      ].sort(),
    );
  });
});
