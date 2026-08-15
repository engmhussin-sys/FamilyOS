/**
 * B9 (PA-B-007 / PA-B-008) — THE NOTIFICATION SOURCE KEY.
 *
 * CONTEXT §5 declares one rule: ONE BUSINESS EVENT => ONE REWARD => ONE
 * TIMELINE ENTRY => ONE NOTIFICATION. Phase A measured every link in that
 * chain and found that all of them except the last are held by a UNIQUE index
 * in PostgreSQL, and the last one was held by a `findFirst` over a five-minute
 * window followed by a `create`. A window is not a constraint: it cannot see a
 * concurrent writer, and it forgets. The project's own «KNOWN LIMIT» test
 * measured the consequence — marker deleted, six minutes later, one reward,
 * TWO notifications.
 *
 * This module is the other half of the fix. The database half is
 * `notifications (family_id, source_event_id, user_id)` and
 * `child_messages (family_id, source_event_id)`. This half is the DELIBERATE
 * COMPOSITION of that key, one function per producer class, so that "what
 * makes this notification the same notification" is a written decision at the
 * call site rather than an accident of whichever fields a `where` clause
 * happened to list.
 *
 * WHY IT IS NOT ONE FUNCTION. The seven producer paths do not have the same
 * kind of cause, and pretending they do is how the original bug was written:
 *
 *   CAUSED BY A DOMAIN EVENT (the outbox paths). `domain_events.id` is a
 *   permanent, unique, server-assigned identity for the thing that happened.
 *   A key built on it is exact and eternal — redelivery in six minutes or six
 *   months collides. `forDomainEvent` is the STRONGEST form and every path
 *   that has an event id must use it.
 *
 *   CAUSED BY A SERVER-SIDE DECISION WITH ITS OWN IDENTITY (a badge award, a
 *   level-up). There is no event row, but there IS a stable business identity
 *   — this child, this badge; this child, this level. `forEntity` builds on
 *   that, so the notification is unique for as long as the fact is.
 *
 *   CAUSED BY A REPEATING OBSERVATION (a hydration reminder, a device
 *   protection alert, a wellbeing critical event). These have NO identity at
 *   all: the same real-world condition legitimately recurs, and the product
 *   wants a notification the second time — tomorrow, not sixty seconds later.
 *   `forRecurringSignal` therefore quantises time into a bucket and puts the
 *   bucket in the key.
 *
 * THE HONEST LIMIT OF THE THIRD FORM, stated here rather than discovered
 * later: a bucket boundary is not a sliding window. Two identical alerts 30
 * seconds apart but on opposite sides of a bucket edge produce two DIFFERENT
 * keys and the database will accept both. That is why the five-minute
 * `findFirst` in `PrismaRuntimeAlertRepository` and the sliding DUPLICATE rule
 * in `NotificationFatigueGuard` are KEPT rather than replaced: they remain the
 * product behaviour, and the constraint is the backstop underneath them — the
 * same relationship `consumed_messages` has with the ledger's unique index.
 * For the outbox paths, which are the ones the KNOWN LIMIT test exercises and
 * the ones a relay actually redelivers, the key is exact and the backstop is
 * total.
 *
 * Framework-free on purpose (no NestJS, no Prisma), like `verification.ts` and
 * `idempotency.ts` beside it: this is a contract, and both the producers and
 * the tests import the same one.
 */

/** `notifications.source_event_id` / `child_messages.source_event_id` are
 * `VARCHAR(200)`. Every composer below truncates to fit rather than letting
 * PostgreSQL raise 22001 at the end of a business transaction that already
 * succeeded. */
export const NOTIFICATION_SOURCE_KEY_MAX_LENGTH = 200;

/**
 * The bucket width for `forRecurringSignal`, deliberately equal to
 * `NotificationFatigueGuard`'s own `DUPLICATE_WINDOW_MS` and to
 * `PrismaRuntimeAlertRepository`'s `DEDUP_WINDOW_MS`. Three numbers that must
 * agree, named once.
 */
export const NOTIFICATION_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Producer tags. A closed union rather than a free string so that adding an
 * eighth notification producer is a compile-time event that forces its author
 * to choose a composition, which is the whole point of this module.
 */
export type NotificationProducer =
  | 'outbox'
  | 'reward'
  | 'badge'
  | 'levelup'
  | 'signal'
  | 'wellbeing'
  | 'runtime';

function clamp(key: string): string {
  return key.length <= NOTIFICATION_SOURCE_KEY_MAX_LENGTH
    ? key
    : key.slice(0, NOTIFICATION_SOURCE_KEY_MAX_LENGTH);
}

function segment(value: string): string {
  // `:` is the separator, so it cannot appear inside a segment — otherwise
  // ('a:b', 'c') and ('a', 'b:c') would compose to the same key.
  return value.replace(/:/g, '_');
}

/**
 * THE STRONGEST FORM. Use it whenever a `domain_events.id` exists.
 *
 * `facet` exists for the one legitimate case of two notifications from one
 * event: a milestone that genuinely deserves both a child's encouragement and
 * a parent's visibility. It is REQUIRED to be spelled out at the call site —
 * there is no default — precisely so that "this event notifies twice" is a
 * sentence someone wrote, not a consequence of `type` being in a unique index.
 */
export function forDomainEvent(domainEventId: string, facet?: string): string {
  const base = `evt:${segment(domainEventId)}`;
  return clamp(facet ? `${base}:${segment(facet)}` : base);
}

/**
 * For a server-side fact that has a stable business identity but no event row:
 * a badge a child can only ever earn once, the moment a child crossed into
 * level 7. Redelivering the trigger recomputes the same key, so the second
 * notification is refused by the database.
 */
export function forEntity(
  producer: NotificationProducer,
  childId: string,
  entityId: string,
  facet?: string,
): string {
  const base = `${producer}:${segment(childId)}:${segment(entityId)}`;
  return clamp(facet ? `${base}:${segment(facet)}` : base);
}

/**
 * For an observation that recurs and SHOULD notify again later — a hydration
 * reminder, a protection-disabled alert, a wellbeing critical event.
 *
 * The bucket is `floor(now / NOTIFICATION_DEDUPE_WINDOW_MS)`, computed from
 * epoch milliseconds and therefore timezone-free: this is a
 * "same-occurrence?" question about instants, not a calendar question. Every
 * question this codebase asks about a family's DAY — quiet hours, the daily
 * cap, the category cap — still goes through `FamilyDateService`, and B9
 * changes none of them.
 */
export function forRecurringSignal(
  producer: NotificationProducer,
  childId: string,
  discriminator: string,
  now: Date,
  windowMs: number = NOTIFICATION_DEDUPE_WINDOW_MS,
): string {
  const bucket = Math.floor(now.getTime() / windowMs);
  return clamp(`${producer}:${segment(childId)}:${segment(discriminator)}:w${bucket}`);
}

/**
 * The prefix migration 0008 backfilled onto every pre-B9 row. Exported so that
 * a test can assert "no NEW notification carries a legacy key" instead of
 * hardcoding the string in two places.
 */
export const LEGACY_SOURCE_KEY_PREFIX = 'legacy:';
