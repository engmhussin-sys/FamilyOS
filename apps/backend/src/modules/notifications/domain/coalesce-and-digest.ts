import {
  RELEASE_DEFAULTS,
  type DeferredNotificationRow,
  type ResolutionReason,
} from './notification-delivery.types';
import { formatNumber } from './engine/notification-copy';

/**
 * PHASE D — THE ANTI-FLOOD DECISION, AS A PURE FUNCTION.
 *
 * THE PROBLEM DEFERRAL CREATES. Fixing `PC-D-005` naively — hold everything,
 * release everything at 07:00 — replaces «the parent never hears about it» with
 * «the parent's phone buzzes eleven times at 07:00», and the second failure is
 * the one that makes people turn notifications off. A deferral mechanism
 * without a release policy is not a fix, it is a delay.
 *
 * THE POLICY, IN THE ORDER IT IS APPLIED, and the reasoning for each step:
 *
 *   1. COALESCE BY (audience, type). Eleven `HYDRATION_REMINDER`s are ONE
 *      fact stated eleven times. The NEWEST survives and the older ones are
 *      resolved `COALESCED` — newest rather than oldest because the content of
 *      a repeated notification is a snapshot ("you're 400ml behind") and the
 *      most recent snapshot is the only true one at release. This step alone
 *      removes the pathological case, and it removes it WITHOUT losing a
 *      distinct fact: two different types never collapse into each other.
 *
 *   2. ORDER: priority first, then oldest-first inside a priority. Chronology
 *      inside a band is what makes a queue readable — a parent scrolling three
 *      notifications should be reading their night in the order it happened,
 *      not in the order a `SELECT` returned. Priority outranks chronology
 *      because a CRITICAL that was somehow deferred must not be third.
 *
 *   3. CAP AT `maxIndividualPerAudience` (3). The first three go out
 *      individually.
 *
 *   4. DIGEST THE REMAINDER, but only if the remainder is at least
 *      `minDigestSize` (2). Replacing one notification with a digest that says
 *      «you have 1 update» is strictly worse than the notification, so a
 *      remainder of one is delivered rather than digested — the rule bends
 *      towards sending the real thing.
 *
 * WHY COALESCE **AND** DIGEST RATHER THAN EITHER ALONE. Coalescing alone still
 * floods a busy household: eight distinct types is eight notifications.
 * Digesting alone loses the newest-wins semantics and produces «you have 11
 * updates» when the honest number is 4. Together the parent gets: the three
 * things that matter, plus one line for the rest, and nothing is deleted — every
 * suppressed row keeps its reason and stays queryable.
 *
 * PURE ON PURPOSE. No clock read, no database, no `Date.now()`. `now` is a
 * parameter. That is what makes the flood behaviour provable in a unit test
 * rather than asserted in a report.
 */

export interface DigestPlan {
  /** Delivered individually, in the order they should be sent. */
  readonly deliver: readonly DeferredNotificationRow[];
  /** Resolved without delivery, each with the reason that will be persisted. */
  readonly resolve: readonly { readonly row: DeferredNotificationRow; readonly reason: ResolutionReason }[];
  /** The rows a digest stands for; empty when no digest is warranted. */
  readonly digestOf: readonly DeferredNotificationRow[];
  /** Which audience this plan is for. */
  readonly audience: 'PARENT' | 'CHILD';
}

const PRIORITY_RANK: Readonly<Record<string, number>> = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

function rank(priority: string): number {
  return PRIORITY_RANK[priority] ?? PRIORITY_RANK.NORMAL;
}

/**
 * Plans one audience's release. Call once per audience — a parent's queue and a
 * child's queue are separate products and must never cap each other.
 */
export function planRelease(
  rows: readonly DeferredNotificationRow[],
  audience: 'PARENT' | 'CHILD',
  limits: {
    maxIndividual?: number;
    minDigestSize?: number;
  } = {},
): DigestPlan {
  const maxIndividual = limits.maxIndividual ?? RELEASE_DEFAULTS.maxIndividualPerAudience;
  const minDigestSize = limits.minDigestSize ?? RELEASE_DEFAULTS.minDigestSize;

  const mine = rows.filter((r) => r.targetAudience === audience);
  const resolve: { row: DeferredNotificationRow; reason: ResolutionReason }[] = [];

  // -- 1. coalesce by type, newest wins --------------------------------------
  const newestByType = new Map<string, DeferredNotificationRow>();
  for (const row of mine) {
    const current = newestByType.get(row.type);
    if (!current) {
      newestByType.set(row.type, row);
      continue;
    }
    // Ties broken by id so the outcome is deterministic for two rows written in
    // the same millisecond — otherwise the same input could produce two
    // different plans on two replicas.
    const rowIsNewer =
      row.createdAt.getTime() > current.createdAt.getTime() ||
      (row.createdAt.getTime() === current.createdAt.getTime() && row.id > current.id);
    if (rowIsNewer) {
      newestByType.set(row.type, row);
      resolve.push({ row: current, reason: 'COALESCED' });
    } else {
      resolve.push({ row, reason: 'COALESCED' });
    }
  }

  // -- 2. order: priority, then chronology -----------------------------------
  const survivors = [...newestByType.values()].sort((a, b) => {
    const byPriority = rank(a.priority) - rank(b.priority);
    if (byPriority !== 0) return byPriority;
    const byTime = a.createdAt.getTime() - b.createdAt.getTime();
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });

  // -- 3 + 4. cap, then digest the tail --------------------------------------
  if (survivors.length <= maxIndividual) {
    return { deliver: survivors, resolve, digestOf: [], audience };
  }

  const head = survivors.slice(0, maxIndividual);
  const tail = survivors.slice(maxIndividual);

  if (tail.length < minDigestSize) {
    // A one-row tail is delivered rather than summarised: «1 more update» is
    // never better than the update.
    return { deliver: [...head, ...tail], resolve, digestOf: [], audience };
  }

  for (const row of tail) resolve.push({ row, reason: 'DIGESTED' });
  return { deliver: head, resolve, digestOf: tail, audience };
}

/**
 * The digest's own text. Arabic, and deliberately CONTENTLESS beyond a count:
 * CONTEXT §3 principle 8 (no child's name, no habit title in a push payload)
 * applies to the summary exactly as it applies to the notifications it replaces
 * — `docs/06 §8.3` makes the FCM message a pointer and the app fetches the
 * content over an authenticated GET.
 */
export function digestText(
  count: number,
  /**
   * `PG-002` — THE AUDIENCE, BECAUSE THE CHILD HAS A CEILING AND THE PARENT
   * DOES NOT.
   *
   * MEASURED, NOT INFERRED. This function returned ONE pair of strings for both
   * audiences, and `writeDigest` passes the result straight into `deliverNow`,
   * whose CHILD branch writes `child_messages`. The body is ELEVEN WORDS.
   * `age-band.ts` caps band `6-8` at EIGHT. So the digest a six-to-eight-year-old
   * received was outside the §11.3 ceiling every other child-facing string in
   * this product is held to — and it carried WESTERN DIGITS («لديك 5 تحديثات»),
   * which `PF-E-002` is the record of this product rejecting.
   *
   * IT WAS INVISIBLE BECAUSE NOTHING ENFORCED THE CEILING ON THIS PATH: the only
   * filter behind `FamilyCommunicationService` was the PARENT policy, which has
   * no notion of length. `PG-001` put the CHILD policy at that door and this was
   * the first thing it found. The honest fix is not to widen the ceiling — it is
   * a shorter sentence for the audience that has one.
   *
   * Defaulted to `'PARENT'`, so the parent digest is byte-identical to what it
   * has always been and `coalesce-and-digest.spec.ts`' existing assertion keeps
   * asserting the string it was written about.
   */
  audience: 'PARENT' | 'CHILD' = 'PARENT',
): { title: string; body: string } {
  if (audience === 'CHILD') {
    return {
      // Six words, Arabic-Indic digits, inside the NARROWEST band's ceiling — so
      // ONE sentence is correct for all four bands rather than four sentences
      // each correct for one. `formatNumber` is the copy catalogue's own helper;
      // the digits are not re-implemented here.
      title: 'ملخّص الليلة',
      body: `لديك ${formatNumber(count, 'ar')} تحديثات جديدة. افتح التطبيق.`,
    };
  }
  return {
    title: 'ملخّص إشعارات الليلة',
    body: `لديك ${count} تحديثات أخرى من الليلة الماضية. افتح التطبيق لرؤية التفاصيل.`,
  };
}
