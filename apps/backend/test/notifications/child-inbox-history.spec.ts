/**
 * ============================================================================
 * THE SHARED DEFINITION OF «THE CHILD'S NOTIFICATION HISTORY», PINNED.
 * ============================================================================
 *
 * WHY THIS FILE EXISTS AT ALL. Two modules asked the identical question of
 * `child_messages` in two places —
 * `NotificationContextAssembler.readChildInbox` (notification-engine) and
 * `PrismaCommunicationRepository.findRecentNotificationsForChild`
 * (life-intelligence) — and each docstring named the OTHER as «the definition
 * not to drift from». A comment cannot fail a build, and they HAD drifted: one
 * side gained an upper bound at `now` and the other had not, so a row stamped
 * with the database's own clock counted as history against a decision evaluated
 * at a frozen January instant.
 *
 * `shared/notifications/child-inbox-history.ts` is now the one definition. This
 * spec is the thing that makes it a constraint rather than a second comment: it
 * asserts the QUERY ITSELF — the exact `where`, `select` and `orderBy` handed to
 * the delegate — so a silent change to any clause fails here, in the module that
 * owns the shared file, before it can diverge in either consumer.
 *
 * PURE. No database, no Nest, no Prisma. The port takes a structural delegate
 * precisely so this is possible; a fake records what it was asked.
 */
import {
  readChildInboxHistory,
  type ChildInboxDelegate,
} from '../../src/shared/notifications/child-inbox-history';

const CHILD = '22222222-2222-2222-2222-222222222222';
const SINCE = new Date('2026-01-15T05:00:00.000Z');
const UNTIL = new Date('2026-01-16T05:00:00.000Z');

interface Recorded {
  args: any;
}

function fakeDelegate(
  rows: Array<{ category: string; createdAt: Date; sourceEventId: string | null }>,
): ChildInboxDelegate & Recorded {
  const recorded: any = {
    args: undefined,
    findMany: async (args: any) => {
      recorded.args = args;
      return rows;
    },
  };
  return recorded;
}

describe('the shared child-inbox history definition', () => {
  it('asks for the window BOUNDED AT BOTH ENDS — a row above `until` is never fetched', async () => {
    const delegate = fakeDelegate([]);
    await readChildInboxHistory(delegate, { childId: CHILD, since: SINCE, until: UNTIL });

    // THE CEILING IS IN THE QUERY, not only in a filter afterwards: the rows a
    // decision must not see never leave PostgreSQL. `lte` rather than `lt`,
    // because a row written AT the instant being evaluated has already happened.
    expect(delegate.args.where.createdAt).toEqual({ gte: SINCE, lte: UNTIL });
    expect(delegate.args.where.childId).toBe(CHILD);
  });

  it('asks the «is this a notification, or did a human write it?» question the table\'s own way', async () => {
    const delegate = fakeDelegate([]);
    await readChildInboxHistory(delegate, { childId: CHILD, since: SINCE, until: UNTIL });

    // `child_messages.source_event_id` is NULLABLE precisely because this table
    // ALSO holds PARENT-AUTHORED messages, and NULL there means «a human wrote
    // this». A parent typing «أحسنت» to their child is a conversation, and
    // counting it towards a fatigue cap would let a warm parent mute the
    // product's own feedback loop.
    expect(delegate.args.where.sourceEventId).toEqual({ not: null });
  });

  it('selects THREE COLUMNS — never a title, never a body, never the payload', async () => {
    const delegate = fakeDelegate([]);
    await readChildInboxHistory(delegate, { childId: CHILD, since: SINCE, until: UNTIL });

    // CONTEXT §3 principle 8, applied to the one table in this product that
    // holds sentences written to a child. A cap needs to know THAT a message
    // happened, what kind it was and when; it has never needed to know what it
    // said. `toEqual` rather than `objectContaining`, so an added column is a
    // failure and not a silent widening.
    expect(delegate.args.select).toEqual({
      category: true,
      createdAt: true,
      sourceEventId: true,
    });
    expect(delegate.args.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('maps `category` to `type`, because that column HOLDS the notification type on this path', async () => {
    const rows = [
      { category: 'REWARD_GRANTED_CHILD', createdAt: UNTIL, sourceEventId: 'evt:1:child' },
      { category: 'HYDRATION_REMINDER', createdAt: SINCE, sourceEventId: 'evt:2:child' },
    ];
    const facts = await readChildInboxHistory(fakeDelegate(rows), {
      childId: CHILD,
      since: SINCE,
      until: UNTIL,
    });

    // `deliverNow` passes `candidate.type` into `draftAiMessageIfAbsent`'s
    // `category` parameter, so this column carries the same vocabulary
    // `IRecentNotification.type` carries on the PARENT branch — which is what
    // lets the per-type cooldown and the category cap read the same strings for
    // both audiences.
    expect(facts).toEqual([
      { type: 'REWARD_GRANTED_CHILD', createdAt: UNTIL, sourceEventId: 'evt:1:child' },
      { type: 'HYDRATION_REMINDER', createdAt: SINCE, sourceEventId: 'evt:2:child' },
    ]);
  });

  it('returns the causal key AS PERSISTED — faceted, never un-faceted here', async () => {
    // Both consumers compose the CANDIDATE's key forwards with the same
    // `forAudience` / `forChildAudience` the writer used, so the two strings are
    // the output of one function. An inverse would have to guess what a
    // 200-character clamp did to the facet, which is how two conventions get
    // compared as if they were one.
    const key = 'evt:a-very-long-producer-key:child';
    const [fact] = await readChildInboxHistory(
      fakeDelegate([{ category: 'BADGE_EARNED', createdAt: UNTIL, sourceEventId: key }]),
      { childId: CHILD, since: SINCE, until: UNTIL },
    );
    expect(fact.sourceEventId).toBe(key);
  });
});
