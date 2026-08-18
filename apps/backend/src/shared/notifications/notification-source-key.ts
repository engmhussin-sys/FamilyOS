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
  | 'runtime'
  /** PHASE D — the quiet-hours digest. Producer 8, and naming it here rather
   * than letting it default is exactly the compile-time event this union exists
   * to force; `forQuietHoursDigest` below states the composition it chose. */
  | 'digest'
  /**
   * SPRINT F1 — BILLING. Producer 9, and the first whose cause belongs to a
   * HOUSEHOLD rather than to a child: a card is declined for a SUBSCRIPTION,
   * a renewal approaches for a SUBSCRIPTION, and neither fact names a child.
   * `forBillingEvent` below states the composition it chose and why the three
   * existing forms were all wrong for it.
   */
  | 'billing';

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
 * PHASE D (`PC-D-005`) — THE FOURTH FORM: the quiet-hours digest.
 *
 * A digest is caused by neither an event, nor an entity, nor a repeating
 * observation. It is caused by A DAY ENDING for A HOUSEHOLD, which is why its
 * key is `(business date, audience)` and nothing else:
 *
 *   ONE DIGEST PER FAMILY PER BUSINESS DAY PER AUDIENCE, as a database
 *   constraint rather than as a count the release path has to get right. If a
 *   sweep is run twice — an operator pressing «Run now», a replica retrying
 *   after a crash mid-release, two ticks overlapping — the second insert
 *   collides with `notifications (family_id, source_event_id, user_id)` and is
 *   refused. Without that, the anti-flood mechanism would itself be capable of
 *   producing the flood.
 *
 * The family is NOT in the key because `family_id` is already the first column
 * of that unique index; putting it in the string as well would make the key
 * longer and no more unique.
 */
export function forQuietHoursDigest(businessDate: string, audience: 'PARENT' | 'CHILD'): string {
  return clamp(`digest:${segment(businessDate)}:${segment(audience)}`);
}

/**
 * SPRINT F1 — THE FIFTH FORM: A BILLING FACT ABOUT A SUBSCRIPTION.
 *
 * `PAYMENT_FAILED` and `SUBSCRIPTION_EXPIRING` had copy in two languages, a
 * quiet-hours class, two scoring rows and a deep-link destination, and nothing
 * in `src/` produced either. Writing the producers made the key the first
 * question, and none of the four existing forms answers it:
 *
 *   `forDomainEvent`      there is no `domain_events` row. Billing writes to
 *                         `payment_webhook_events` and `subscriptions`; it
 *                         emits no domain event, and inventing one to borrow
 *                         this form would be a new architecture for a string.
 *   `forEntity`           its second parameter is a CHILD id. A declined card
 *                         belongs to a household, and passing a family id in a
 *                         parameter named `childId` is a lie that the next
 *                         reader has to disprove.
 *   `forRecurringSignal`  a five-minute bucket. A renewal notice must not be
 *                         re-sendable four times an hour, and its own docstring
 *                         states that limit honestly.
 *   `forQuietHoursDigest` a day and an audience, with no subject at all.
 *
 * SO: THE SUBJECT IS THE SUBSCRIPTION, AND THE OCCURRENCE IS SPELLED OUT BY
 * THE CALLER. `subscriptions.family_id` is UNIQUE, so a subscription id is a
 * household's billing identity, and `occurrence` is the caller's written
 * answer to «what makes this the same notification»:
 *
 *   `payment_failed:APPLE_IAP:<notificationUUID>` — THE PROVIDER'S OWN EVENT
 *   IDENTITY. `payment_webhook_events (provider, provider_event_id)` is UNIQUE,
 *   so a redelivered webhook recomputes this exact string and the notification
 *   ledger refuses it. A LATER, GENUINELY NEW failure carries a new provider
 *   event id and is allowed to notify, which is the behaviour a parent whose
 *   second retry also failed actually needs.
 *
 *   `expiring:<YYYY-MM-DD>` — THE RENEWAL DAY ON THE FAMILY'S OWN CALENDAR.
 *   The lead-time sweep asks the same question every day for three days and
 *   must notify ONCE; every one of those runs composes the same string. The
 *   NEXT period renews on a different local day and is a different notice.
 *
 * The family id is deliberately NOT in the string: `family_id` is already the
 * first column of `notifications (family_id, source_event_id, user_id)` and of
 * `notification_decisions_cause_uniq`, so repeating it here would make the key
 * longer and no more unique — the same reasoning `forQuietHoursDigest` states.
 *
 * `occurrence` IS NOT PUT THROUGH `segment`, and that is the one deviation
 * here. `segment` exists so that ('a:b','c') and ('a','b:c') cannot compose the
 * same key; that ambiguity needs a separator inside BOTH sides of a pair, and
 * `subscriptionId` is a uuid — it has no colons and is segmented anyway. The
 * occurrence is the LAST field, so its own colons cannot be mistaken for the
 * boundary, and keeping them makes the stored key readable by the support
 * engineer who has to answer «why did this parent get this».
 */
export function forBillingEvent(subscriptionId: string, occurrence: string): string {
  const producer: NotificationProducer = 'billing';
  return clamp(`${producer}:${segment(subscriptionId)}:${occurrence}`);
}

/**
 * The prefix migration 0008 backfilled onto every pre-B9 row. Exported so that
 * a test can assert "no NEW notification carries a legacy key" instead of
 * hardcoding the string in two places.
 */
export const LEGACY_SOURCE_KEY_PREFIX = 'legacy:';
