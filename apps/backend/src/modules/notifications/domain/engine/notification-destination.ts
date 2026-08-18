/**
 * PHASE F (`F6-007`) — WHERE A NOTIFICATION TAP LANDS, AND THE ONLY PLACE THAT
 * QUESTION IS ANSWERED.
 *
 * WHAT WAS MEASURED. A repo-wide search for `deepLink` / `actionUrl` across
 * `apps/backend/src`, `apps/parent-app` and `apps/child-app` returned NOTHING.
 * The original `NotificationDecision` contract listed a destination as a
 * required output and it was never built, so every notification this product
 * has ever sent ends in a sentence that says «افتح التطبيق» and a tap that does
 * nothing. `COPY_CATALOGUE` answers WHAT the reader is told; this file answers
 * WHERE the reader is taken, and it sits beside the catalogue for the reason the
 * catalogue sits where it does: this is PRODUCT KNOWLEDGE, and two Flutter
 * clients that each hold their own copy of it will drift from each other and
 * from the server inside a sprint.
 *
 * THE SERVER IS AUTHORITATIVE. The client receives a resolved URI on the
 * notification's `data` payload and routes on it. It does not map types to
 * screens, it does not parse the Arabic body, and it does not decide anything —
 * a client that decided would be a third opinion nobody can audit.
 *
 * ---------------------------------------------------------------------------
 * THE URI SCHEME, canonical: `abny://<surface>[/<id>]`. Nothing else — no query
 * string, no fragment, no host, no absolute URL, and never a token.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE RULES THIS FILE ENFORCES, each asserted by
 * `test/notifications/notification-destination.spec.ts`:
 *
 *   1. EVERY COPY KEY RESOLVES. `DESTINATION_RULES` is keyed on the same keys as
 *      `COPY_CATALOGUE`, and the spec enumerates the CATALOGUE — so a key added
 *      tomorrow without a destination fails a test today rather than shipping a
 *      dead tap. A hand-written list of thirty keys rots in a week; the
 *      catalogue is the list.
 *   2. A TAP ALWAYS LANDS. `resolveNotificationDestination` is TOTAL: an unknown
 *      key, a malformed key, a rule that somehow throws — every one of them
 *      returns `abny://notifications`, the inbox. Never `null`, never `''`,
 *      never an exception on a delivery path.
 *   3. AUDIENCE DECIDES. The same fact sends a child and a parent to different
 *      places: a granted reward is `abny://rewards` for the child who earned it
 *      and the goal — or the progress view — for the parent, who is being asked
 *      to encourage rather than to collect. The catalogue already splits those
 *      into two keys (`REWARD_GRANTED_CHILD` vs `REWARD_GRANTED`) because
 *      `audience` is a property of the ENTRY, so this file inherits the split
 *      instead of re-deriving it. Where a surface exists in only ONE app the
 *      audience is checked here as well, so a later edit cannot point a
 *      child-facing key at a parent-only screen.
 *   4. ONLY IDS THE SERVER ALREADY HAS AT EMISSION — and today that is NONE.
 *      See «WHY EVERY LINK IS ID-LESS TODAY» below. Nothing here reads a row to
 *      manufacture an id, and a surface whose id is absent emits its LIST form
 *      (`abny://goals`, never `abny://goal/undefined`). A link to a resource the
 *      recipient cannot open is worse than a link to a list.
 *   5. SAFE TO HAND TO A CLIENT. No `familyId` and no other identifier of a
 *      person or a tenant ever appears in a link; no token, no e-mail, no
 *      absolute URL; and NO USER-CONTROLLED STRING — every id, if one is ever
 *      supplied, is validated as a UUID before it is interpolated, so a producer
 *      payload that reaches this layer (`DigitalWellbeingEngineService` spreads
 *      a DEVICE-supplied `metadata` object into `data`) cannot inject a path
 *      segment.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY LINK IS ID-LESS TODAY, stated here because it is a product decision
 * and not an omission:
 *
 *   a. NO PRODUCER CARRIES A ROW ID TO THIS LAYER. `NotificationRewardConsumer`
 *      holds `achievementSummaryAr` — a TITLE written for humans — and never a
 *      `RewardProgram.id`; `GoalFacts` on the context is a title and two
 *      counters; `DigitalWellbeingEngineService` notifies from the EVENT, before
 *      any alert row exists. Rule 4 forbids manufacturing one: a lookup here
 *      would be this layer reaching into another module's rows to decorate a
 *      URI, and a wrong id is a tap into someone else's goal.
 *   b. `notifications.data` IS PINNED IDENTIFIER-FREE. `e2e-13 STEP 14` reads
 *      the parent's row back and asserts the serialised payload contains none of
 *      `familyId`, `childId`, `deviceId`, `programId`, `achievementId` — «CONTEXT
 *      §3 principle 8 requires of this payload just as much as of the FCM one».
 *      The link travels ON that payload, so `abny://child/<childId>` would put
 *      an identifier back into the field the product has decided keeps none.
 *      That is why the parent's reward notification lands on the goal or the
 *      progress view rather than on one child's detail page.
 *
 * The id-bearing branch below is LIVE CODE, not aspiration: the day a producer
 * carries a `programId` and the payload rule is revisited, `abny://goal/<id>`
 * starts being emitted with no edit to any rule.
 *
 * ---------------------------------------------------------------------------
 * WHY A DERIVED FIELD AND NOT A COLUMN. The destination is a pure function of
 * (copy key, audience, ids in hand). A column would add a migration, a second
 * source of truth and a backfill, and would freeze today's product map into
 * every historical row — a screen renamed next month would leave a thousand rows
 * pointing at a screen that no longer exists. `notifications.data` is already
 * persisted, already carried verbatim across a quiet-hours deferral, and already
 * read by the parent app (`PD-N-004`), so the link costs nothing to deliver.
 */

import type { ToneAudience } from './notification-tone';

/** The scheme. One word, and not negotiable at this layer. */
export const DEEP_LINK_SCHEME = 'abny';

/**
 * THE CANONICAL SURFACES. Both clients switch on exactly this list, which is why
 * it is a list and not a set of string literals scattered across rules.
 */
export const DEEP_LINK_SURFACES = [
  /** the goal / program list */
  'goals',
  /** one goal, id = `RewardProgram.id` */
  'goal',
  /** the parent's pending-approval queue */
  'approvals',
  /** one item awaiting a parent, id = achievement id */
  'approval',
  /** the rewards surface */
  'rewards',
  /** progress / streaks */
  'progress',
  /** the AI coach */
  'coach',
  /** screen-time / wellbeing */
  'screen-time',
  /** one safety event, id = alert id */
  'safety',
  /** one child's detail — PARENT APP ONLY */
  'child',
  /** subscription & billing */
  'subscription',
  /** the inbox, and the universal fallback */
  'notifications',
] as const;

export type DeepLinkSurface = (typeof DEEP_LINK_SURFACES)[number];

/** The surfaces whose URI takes an id. Everything else is a list or a tab. */
const ID_BEARING_SURFACES: ReadonlySet<DeepLinkSurface> = new Set<DeepLinkSurface>([
  'goal',
  'approval',
  'safety',
  'child',
]);

/**
 * Surfaces that exist in the PARENT app only. A child-facing key resolving here
 * would hand a child a route their app cannot service — a silent no-op, which is
 * the exact defect this file exists to remove.
 */
const PARENT_ONLY_SURFACES: ReadonlySet<DeepLinkSurface> = new Set<DeepLinkSurface>([
  'child',
  'approvals',
  'approval',
  'subscription',
]);

/** THE UNIVERSAL FALLBACK. Every failure mode in this file ends here. */
export const NOTIFICATION_INBOX_LINK = `${DEEP_LINK_SCHEME}://notifications`;

/**
 * The key the link travels under on `notifications.data`. Exported so the
 * engine, the tests and the clients agree on one spelling — a payload contract
 * with two spellings is a payload contract with none.
 */
export const NOTIFICATION_DEEP_LINK_DATA_KEY = 'deepLink';

/**
 * THE IDS THIS LAYER MAY USE. All optional, all absent on every producer path
 * today (see the header), and NONE of them identifies a person or a tenant:
 * there is deliberately no `familyId`, no `childId` and no `userId` here, so
 * rule 5 is a property of the TYPE rather than of the care taken by each rule.
 */
export interface NotificationDestinationFacts {
  /** Which app is being addressed — the provider's own resolved audience. */
  readonly audience: ToneAudience;
  /** `RewardProgram.id`, when a producer ever carries one. */
  readonly programId?: string | null;
  /** The achievement awaiting a parent, when a producer ever carries one. */
  readonly achievementId?: string | null;
  /** The safety alert row, when one exists before the notification does. */
  readonly alertId?: string | null;
}

export interface NotificationDestinationRequest extends NotificationDestinationFacts {
  /** A key in `COPY_CATALOGUE`. An unknown or malformed value resolves to the
   * inbox; it never throws. */
  readonly copyKey: string;
}

/**
 * A USABLE ID IS A UUID AND NOTHING ELSE.
 *
 * This is the whole of rule 5's «no user-controlled string». Every id in this
 * schema is a `@db.Uuid`, so anything that is not a UUID did not come from a
 * primary key — it came from a payload, and a payload does not get to choose a
 * path segment. A rejected id degrades to the list form rather than being
 * escaped, because an id we cannot vouch for names a row we cannot vouch for.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUsableDeepLinkId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** `abny://<surface>` — the id-less form. */
function surfaceLink(surface: DeepLinkSurface): string {
  return `${DEEP_LINK_SCHEME}://${surface}`;
}

/**
 * `abny://<surface>/<id>` when the id is real, and the caller's own stated
 * fallback when it is not. The fallback is a PARAMETER rather than the inbox,
 * because «the list this thing is in» beats «the inbox» wherever it exists.
 */
function idLink(surface: DeepLinkSurface, id: string | null | undefined, fallback: string): string {
  return isUsableDeepLinkId(id) ? `${DEEP_LINK_SCHEME}://${surface}/${id}` : fallback;
}

/** ONE GOAL IF WE KNOW WHICH ONE, THE GOAL LIST OTHERWISE. Today always the
 * list — see «WHY EVERY LINK IS ID-LESS TODAY» (a). */
function goalDestination(facts: NotificationDestinationFacts): string {
  return idLink('goal', facts.programId, surfaceLink('goals'));
}

/**
 * A SAFETY EVENT, DEGRADING ONCE. The alert row if we have it; otherwise the
 * screen-time & protection surface, which is where a parent actually acts on
 * every one of these four alerts.
 */
function safetyDestination(facts: NotificationDestinationFacts): string {
  return idLink('safety', facts.alertId, surfaceLink('screen-time'));
}

/** THE PARENT'S QUEUE, one item if we know which, the queue otherwise. */
function approvalDestination(facts: NotificationDestinationFacts): string {
  return idLink('approval', facts.achievementId, surfaceLink('approvals'));
}

type DestinationRule = (facts: NotificationDestinationFacts) => string;

/**
 * THE MAP. One row per `COPY_CATALOGUE` key, and the spec enumerates the
 * CATALOGUE rather than this table — so «somebody added a sentence and forgot
 * the tap» is a red test, not a support ticket.
 *
 * DELIBERATELY NOT KEYED ON CATEGORY. Two keys in one category go to different
 * places — `SCREEN_TIME_EXCEEDED` is the wellbeing screen and `CHILD_REQUEST` is
 * the approval queue, and both are `SAFETY` — so a category-shaped map would
 * have forced them together, which is how a destination map goes wrong faster
 * than the copy it accompanies.
 */
const DESTINATION_RULES: Readonly<Record<string, DestinationRule>> = Object.freeze({
  // ===================================================================== CHILD
  //
  // The child's app is single-child by construction, so nothing here needs — or
  // is allowed — an identifier to say WHO. It only has to say WHAT.

  /** The goal itself is the point of the sentence. */
  GOAL_DEADLINE_NEAR: goalDestination,
  GOAL_ALMOST_DONE: goalDestination,
  DAILY_GOAL_COMPLETED: goalDestination,
  LEARNING_GOAL_ACHIEVED: goalDestination,
  STUDY_REMINDER: goalDestination,
  /** «راجع {goalTitle} مع أهلك» — the review happens ON the goal. */
  ACHIEVEMENT_VERIFIED: goalDestination,
  ACHIEVEMENT_REJECTED: goalDestination,

  /** Streaks, badges and levels are all read on the progress surface — it is
   * where the streak counter and the badge shelf live. */
  STREAK_AT_RISK: () => surfaceLink('progress'),
  STREAK_ACHIEVED: () => surfaceLink('progress'),
  EXERCISE_ENCOURAGEMENT: () => surfaceLink('progress'),
  BADGE_EARNED: () => surfaceLink('progress'),
  LEVEL_UP: () => surfaceLink('progress'),

  /** «حصلت على مكافأة جديدة» — the child who earned the thing lands on the
   * thing. The parent's half of this same event lands elsewhere; see
   * `REWARD_GRANTED` below, and rule 3. */
  REWARD_GRANTED_CHILD: () => surfaceLink('rewards'),

  /** «مرّ وقت طويل على الشاشة — استراحة قصيرة» is a WELLBEING sentence, and the
   * wellbeing surface shows the stretch it is talking about. */
  HYDRATION_REMINDER: () => surfaceLink('screen-time'),

  // ==================================================================== PARENT

  /** The parent's goal surface: where they see what they set, and set the next
   * one. Both goal sentences are ABOUT a goal, so both land on it. */
  GOAL_COMPLETED_PARENT: goalDestination,
  GOAL_STALLED_PARENT: goalDestination,

  /**
   * THE AUDIENCE SPLIT, and this is the pair rule 3 is written for.
   *
   * The child's sentence is «حصلت على مكافأة» and their tap opens the reward.
   * The parent's sentence is «محمد أكمل … وحصل على ٢٠ نقطة. افتح التطبيق
   * لتشجيعه» — an invitation to ENCOURAGE, not to collect — so their tap opens
   * THE WORK: the goal when the sentence named one, the progress view when the
   * cause was a habit tick or a streak and no goal is known. Sending a parent to
   * the reward catalogue, which is a configuration screen in their app, would
   * answer a question they did not ask.
   */
  REWARD_GRANTED_WITH_GOAL: goalDestination,
  REWARD_GRANTED: () => surfaceLink('progress'),
  BADGE_EARNED_PARENT: () => surfaceLink('progress'),

  /** The four device alerts land where a parent can act: screen-time and
   * protection. `POLICY_VIOLATION` reads «هناك ما يستحق مراجعتك في إعدادات
   * {childName}» — the settings it means are that surface's. */
  SCREEN_TIME_EXCEEDED: safetyDestination,
  POLICY_VIOLATION: safetyDestination,
  ACCESSIBILITY_DISABLED: safetyDestination,
  PROTECTION_BYPASS_ATTEMPT: safetyDestination,

  /**
   * «ظهرت إشارات تستحق اطمئنانك على {childName} الآن» — the distress-escalation
   * alert, and the most important sentence this product sends anyone.
   *
   * IT USED TO RESOLVE TO `abny://coach`, on the argument that the next step is
   * a CONVERSATION rather than a setting. The argument was right about the
   * product and wrong about the tap: `coach` is `unavailable` in the parent app
   * (`deep_link_router.dart`), because `CoachingScreen` needs a `childId` AND a
   * `childName` and this payload is pinned identifier-free — so a link there is
   * a link the recipient cannot open, which rule 4's own words call worse than
   * a link to a list. `screen-time`/`safety` IS openable, and `SafetyScreen`
   * was built listing exactly the notifications the server classifies SAFETY —
   * `notification-class.ts` classifies this key SAFETY, alongside the four
   * device alerts that already resolve here.
   *
   * So it takes `safetyDestination` like its four siblings: the alert row when
   * a producer ever carries one, and the protection surface — where the parent
   * sees this alert next to everything else about this child's safety, and one
   * tap from the child's page — until then.
   */
  CHILD_WELLBEING_CHECKIN: safetyDestination,

  /** «أرسل {childName} طلبًا ينتظر ردّك» — a request waiting for an answer IS
   * the approval queue. */
  CHILD_REQUEST: approvalDestination,

  SUBSCRIPTION_EXPIRING: () => surfaceLink('subscription'),
  PAYMENT_FAILED: () => surfaceLink('subscription'),

  /** A device alert with no surface of its own — its two producers still do not
   * reach the DECISION engine (see `COPY_CATALOGUE.RUNTIME_ALERT`), though they
   * now reach THIS map, from the single writer. The inbox, where the alert
   * itself is, remains the honest answer rather than a guess: `RUNTIME_ALERT`
   * is the generic type, and the two facts it carries today (a device unlinked,
   * a protection service disabled) are read in the alert itself. */
  RUNTIME_ALERT: () => NOTIFICATION_INBOX_LINK,
  /** A digest of N things cannot point at one of them. The inbox is not a
   * fallback here — it is the correct answer. */
  QUIET_HOURS_DIGEST: () => NOTIFICATION_INBOX_LINK,
  /** The contentless entry: «لديك تحديث جديد داخل التطبيق» — and the inbox is
   * where the update is. */
  GENERIC: () => NOTIFICATION_INBOX_LINK,
});

/** Every key that has an explicit destination. The spec compares this set with
 * `copyKeys()` in BOTH directions: a catalogue key with no rule is a dead tap,
 * and a rule with no catalogue key is a rule nobody can reach. */
export function destinationKeys(): readonly string[] {
  return Object.keys(DESTINATION_RULES);
}

/** Whether this key is answered EXPLICITLY rather than by the inbox fallback.
 * The distinction is the whole point of the exhaustiveness test: `resolve` is
 * total, so it cannot itself tell «mapped to the inbox» from «forgotten». */
export function hasExplicitDestination(copyKey: unknown): boolean {
  return (
    typeof copyKey === 'string' && Object.prototype.hasOwnProperty.call(DESTINATION_RULES, copyKey)
  );
}

/**
 * Is this a link both clients can route? Structural and strict: the scheme, a
 * surface from the table, and — only for the four id-bearing surfaces — exactly
 * one UUID segment. Exported because the spec asserts it over every produced
 * link, and because a validator living outside the module that produces the
 * links is a validator that can disagree with them.
 */
export function isValidDeepLink(link: unknown): link is string {
  if (typeof link !== 'string') return false;
  const match = /^abny:\/\/([a-z-]+)(?:\/([^/?#]+))?$/.exec(link);
  if (!match) return false;
  const surface = match[1] as DeepLinkSurface;
  if (!(DEEP_LINK_SURFACES as readonly string[]).includes(surface)) return false;
  const id = match[2];
  if (id === undefined) return !ID_BEARING_SURFACES.has(surface);
  return ID_BEARING_SURFACES.has(surface) && UUID.test(id);
}

/** The surface half of a link this module produced. Never called on untrusted
 * input — `isValidDeepLink` has already run. */
function surfaceOf(link: string): DeepLinkSurface {
  return link.slice(`${DEEP_LINK_SCHEME}://`.length).split('/')[0] as DeepLinkSurface;
}

/**
 * THE ONE ENTRY POINT, AND IT IS TOTAL.
 *
 * Unknown key, empty key, a key that is not a string at all, an inherited
 * property name (`toString`, `constructor`), a rule that throws because somebody
 * writes one that can — every path returns a routable link. A pipeline that
 * threw here would turn a routing gap into a lost reward, which is the same
 * argument `renderNotificationCopy` makes about copy.
 *
 * IT IS ALSO DEFENSIVE ABOUT ITS OWN OUTPUT: whatever a rule returns is
 * validated before it is handed back, so a rule edited into producing something
 * unroutable degrades to the inbox instead of shipping a broken tap.
 */
export function resolveNotificationDestination(request: NotificationDestinationRequest): string {
  if (!hasExplicitDestination(request?.copyKey)) return NOTIFICATION_INBOX_LINK;

  let link: string;
  try {
    link = DESTINATION_RULES[request.copyKey](request);
  } catch {
    /* istanbul ignore next — no rule in the table can throw today; the guard is
       here so that one written tomorrow cannot fail a delivery. */
    return NOTIFICATION_INBOX_LINK;
  }

  if (!isValidDeepLink(link)) return NOTIFICATION_INBOX_LINK;
  // Rule 3, ENFORCED rather than trusted: a parent-only surface is never handed
  // to a child, whatever the rule said.
  if (request.audience !== 'PARENT' && PARENT_ONLY_SURFACES.has(surfaceOf(link))) {
    return NOTIFICATION_INBOX_LINK;
  }
  return link;
}

/**
 * THE SHAPE A CHILD-READABLE ROW MAY CARRY. One field, and it is the SAME field
 * under the SAME spelling as the parent's `notifications.data`, so one decision
 * cannot render two ways in two apps.
 */
export type ChildNotificationPayload = { readonly deepLink: string };

/**
 * PHASE F1 — THE CHILD'S HALF OF THE PAYLOAD, AND IT IS A WHITELIST RATHER THAN
 * A FILTER.
 *
 * `notifications.data` carries the PRODUCER'S payload verbatim, plus the
 * server's link spread over it: `goalTitle`, `points`, and — from
 * `DigitalWellbeingEngineService` — a DEVICE-SUPPLIED `metadata` object whose
 * contents nobody at this layer has enumerated. That is defensible for a
 * parent's row, which is read behind a parent-guarded endpoint and pinned
 * identifier-free by `e2e-13 STEP 14`. It is NOT defensible for
 * `child_messages`, whose every row is served to a CHILD DEVICE by
 * `GET /life-intelligence/self/messages`:
 *
 *   a. A TENANT IDENTIFIER MUST NEVER REACH A CHILD-READABLE ROW. Copying an
 *      open-ended object across would make that guarantee a property of every
 *      producer that writes to `data` today and of every one written after
 *      today. Taking exactly ONE KNOWN KEY makes it a property of THIS
 *      FUNCTION — one place, and a place a test can pin.
 *      `smart-notification-engine.e2e.spec.ts` pins it by firing a child event
 *      whose producer payload carries a `familyId`, a `childId` and a
 *      `deviceId`, and reading the persisted row back out of PostgreSQL.
 *   b. THE TWO AUDIENCES ARE TOLD DIFFERENT THINGS ON PURPOSE. `e2e-13`'s «the
 *      parent gained the detail and the CHILD did not» is an assertion about
 *      the SENTENCE; a verbatim `data` copy would have handed the child the
 *      same detail through the back door, one field at a time.
 *
 * IT RE-VALIDATES THE LINK IT FORWARDS. `SmartNotificationEngineService` spreads
 * the resolved destination onto `data` LAST, so what arrives here is the
 * server's answer and never the producer's — but this function is the last gate
 * in front of a child's screen, and «the caller already checked» is how a gate
 * stops being one. A DEVICE-supplied `deepLink` reaching a producer's payload
 * therefore cannot choose a screen even if the spread order above were ever
 * edited.
 *
 * AND `null` IS A REAL ANSWER, not a failure: it means «this row has no
 * destination». The child app renders a payload-less row as NON-TAPPABLE, and a
 * card that is not tappable beats a tap that opens the wrong screen — which is
 * also why nothing backfills the rows written before this column existed.
 */
export function childSafeNotificationPayload(
  data: Record<string, unknown> | null | undefined,
): ChildNotificationPayload | null {
  const link = data?.[NOTIFICATION_DEEP_LINK_DATA_KEY];
  if (!isValidDeepLink(link)) return null;
  return { [NOTIFICATION_DEEP_LINK_DATA_KEY]: link };
}
