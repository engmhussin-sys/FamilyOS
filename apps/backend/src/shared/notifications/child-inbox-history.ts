/**
 * ============================================================================
 * THE ONE DEFINITION OF «THE CHILD'S NOTIFICATION HISTORY».
 * ============================================================================
 *
 * WHAT WAS THERE. Two copies of one query, in two modules that may not import
 * each other:
 *
 *   `NotificationContextAssembler.readChildInbox`      (notification-engine)
 *   `PrismaCommunicationRepository.findRecentNotificationsForChild`
 *                                                      (life-intelligence)
 *
 * Same table, same window predicate, same `source_event_id IS NOT NULL` test,
 * same `category`-as-type mapping, same three selected columns — and each
 * docstring named the OTHER as «the definition not to drift from». That is a
 * comment, and a comment is not a constraint: it cannot fail a build, it cannot
 * be executed, and the two copies have already drifted once in this sprint (one
 * side gained an upper bound at `now`; the other did not, and a `child_messages`
 * row stamped with the DATABASE's clock counted as «just now» against a decision
 * evaluated at a January instant).
 *
 * THIS MODULE IS THAT DEFINITION, WITH NOTHING ELSE IN IT.
 *
 * WHY IT LIVES IN `shared/notifications/`. Both consumers are notification
 * layers, neither module may own the other, and the two files already here —
 * `notification-class.ts` (which category is a type) and
 * `notification-source-key.ts` (what makes a notification the same
 * notification) — are exactly this kind of thing: a single vocabulary that
 * several modules must agree on, expressed as code rather than as prose.
 *
 * FRAMEWORK-FREE AND PRISMA-FREE, deliberately. It takes a DELEGATE — the
 * narrowest structural type that `prisma.childMessage` satisfies — rather than
 * a `PrismaService`, so `shared/` acquires no dependency on the ORM, on Nest, or
 * on either module's repository base class, and a unit test can hand it an
 * object literal.
 *
 * WHAT IT IS NOT. It is not a repository, it is not a port token, and it does
 * not decide anything: it answers ONE question — «which notifications reached
 * this child between two instants» — and returns three columns.
 *
 * ---------------------------------------------------------------------------
 * WHO CONSUMES IT TODAY, AND WHAT THE OTHER OWNER HAS LEFT TO DO.
 *
 * `NotificationContextAssembler.readChildInbox` consumes it now: it hands over
 * `prisma.childMessage` as the delegate and maps the three facts into its own
 * `RecentNotificationFact`. Its copy of the query is gone.
 *
 * `PrismaCommunicationRepository.findRecentNotificationsForChild` (owned by
 * `modules/life-intelligence`) is UNCHANGED and still holds the second copy,
 * deliberately: adopting it means editing files that module owns, and reaching
 * across a module boundary to do it would be the same mistake in a new place.
 * The adoption is four small edits and no behaviour change:
 *
 *   1. `prisma-communication.repository.ts` — take `until: Date` as a third
 *      parameter and replace the body with
 *      `return readChildInboxHistory(this.prisma.childMessage, { childId, since, until });`
 *      Its declared return type is already
 *      `Array<{ type; createdAt; sourceEventId }>`, which IS
 *      `ChildInboxHistoryFact[]`.
 *   2. `smart-notification-integration.service.ts:fetchHistory` — pass the `now`
 *      it already holds as `until`, and drop its
 *      `.filter((m) => m.createdAt.getTime() <= now.getTime())`, which the query
 *      now performs in PostgreSQL instead of in memory.
 *   3. `quiet-hours-release.service.ts:fetchHistory` — the same two changes on
 *      its own CHILD branch.
 *   4. Delete the «this must not drift from `readChildInbox`» paragraphs. The
 *      shared file makes that true by construction instead of by promise, and
 *      `test/notifications/child-inbox-history.spec.ts` fails if any clause of
 *      it moves.
 */

/**
 * THE THREE COLUMNS A FATIGUE DECISION IS MADE OF, and no more.
 *
 * NO `title`, NO `body`, NO `data`. A cap needs to know THAT a message
 * happened, what kind it was and when; it has never needed to know what it
 * said. This is CONTEXT §3 principle 8 (data minimisation) applied to the one
 * table in this product that holds sentences written to a child.
 */
export interface ChildInboxHistoryFact {
  /**
   * THE NOTIFICATION TYPE, read out of `child_messages.category`.
   *
   * That column HOLDS the notification type on this path —
   * `SmartNotificationIntegrationService.deliverNow` passes `candidate.type`
   * into `draftAiMessageIfAbsent`'s `category` parameter — so it carries the
   * same vocabulary `IRecentNotification.type` carries on the PARENT branch,
   * and the per-type cooldown, the category cap and the scorer's
   * `notificationCategoryOf` all read the same strings for both audiences.
   */
  readonly type: string;
  readonly createdAt: Date;
  /**
   * THE CAUSAL KEY AS PERSISTED, `:child`-faceted, and deliberately NOT
   * un-faceted here: both consumers compose the candidate's key FORWARDS with
   * the same `forAudience` / `forChildAudience` the writer used, so the two
   * strings are the output of one function rather than of two conventions. An
   * inverse would have to guess what a 200-character clamp did to the facet.
   */
  readonly sourceEventId: string | null;
}

/**
 * THE WINDOW, AND ITS UPPER BOUND IS REQUIRED.
 *
 * `until` is not optional and that is the whole point of extracting this. Every
 * consumer of this query evaluates an INSTANT that is not necessarily the wall
 * clock — a replayed decision, a back-dated import, a deferral released at its
 * scheduled instant, a test that names its own `now`, a replica whose clock
 * runs behind the database's. A row stamped AFTER the instant being evaluated
 * is not history, and an open-ended window silently counts it: `now -
 * createdAt` is NEGATIVE, which is smaller than any window, so a future row
 * reads as «two seconds ago» in every rule that measures age.
 *
 * `evaluateFatigue` already states this in its own words («HISTORY IS WHAT
 * ALREADY HAPPENED — bounded ABOVE by `now`») and applies the identical filter
 * at the top of its body. Making the bound a REQUIRED field here rather than an
 * optional one means the next call site has to state which instant it is asking
 * about, instead of inheriting an unbounded default that is wrong in exactly
 * the cases that are hardest to notice.
 */
export interface ChildInboxWindow {
  readonly childId: string;
  /** Inclusive lower bound — the start of the window being counted. */
  readonly since: Date;
  /** Inclusive upper bound — the instant the decision is being made AT. */
  readonly until: Date;
}

/**
 * The narrowest thing that can answer this question. `prisma.childMessage`
 * satisfies it structurally; so does an object literal in a unit test.
 */
export interface ChildInboxDelegate {
  findMany(args: {
    where: {
      childId: string;
      createdAt: { gte: Date; lte: Date };
      sourceEventId: { not: null };
    };
    select: { category: true; createdAt: true; sourceEventId: true };
    orderBy: { createdAt: 'desc' };
  }): Promise<Array<{ category: string; createdAt: Date; sourceEventId: string | null }>>;
}

/**
 * ==========================================================================
 * THE QUERY. Read it once, here, and nowhere else.
 * ==========================================================================
 *
 * `source_event_id IS NOT NULL` IS THE «IS THIS A NOTIFICATION?» TEST, and it
 * is the table's own: `child_messages.source_event_id` is documented NULLABLE
 * precisely because this table ALSO holds PARENT-AUTHORED messages, and NULL
 * there means «a human wrote this». A parent typing «أحسنت» to their child is a
 * conversation, not a notification, and counting it towards a notification
 * fatigue cap would let a warm parent mute the product's own feedback loop.
 *
 * TENANCY IS NOT THIS FUNCTION'S JOB and it does not attempt it. The delegate
 * handed in is already the tenant-extended client (`tenant.extension.ts` scopes
 * `child_messages` by `family_id` on every read), and a `familyId` accepted
 * here would be a second, weaker copy of a guarantee that is structural. The
 * key this function takes — `childId` — is server-derived at every call site.
 *
 * DESCENDING BY `created_at`, because both consumers want «the most recent
 * first» and a caller that re-sorts is a caller that has an opinion about the
 * order this query does not state.
 */
export async function readChildInboxHistory(
  messages: ChildInboxDelegate,
  window: ChildInboxWindow,
): Promise<ChildInboxHistoryFact[]> {
  const rows = await messages.findMany({
    where: {
      childId: window.childId,
      createdAt: { gte: window.since, lte: window.until },
      sourceEventId: { not: null },
    },
    select: { category: true, createdAt: true, sourceEventId: true },
    orderBy: { createdAt: 'desc' },
  });

  return rows.map((row) => ({
    type: row.category,
    createdAt: row.createdAt,
    sourceEventId: row.sourceEventId,
  }));
}
