/**
 * PHASE D (GROWTH) — THE PRODUCT-ANALYTICS EVENT CATALOGUE.
 *
 * TWO CATALOGUES, ON PURPOSE, AND THE DISTINCTION IS NOT COSMETIC.
 *
 *   `src/shared/events/event-types.ts` — the DOMAIN event catalogue. Those
 *   events have CONSUMERS that change state: a `HABIT_COMPLETED` grants a
 *   reward, an `ACHIEVEMENT_VERIFIED` moves a ledger. They go through the
 *   Outbox because losing one loses money or a child's progress.
 *
 *   THIS FILE — the GROWTH event catalogue. These events have exactly one
 *   consumer, the analytics store, and they change nothing. `APP_INSTALLED`
 *   grants nothing. If one is lost, a chart is 0.01% wrong.
 *
 * MERGING THEM WOULD BE THE WRONG KIND OF REUSE. Putting `APP_INSTALLED` into
 * `DOMAIN_EVENT_TYPES` would put it into the Outbox, give it a mandatory
 * `family_id` (an install has no family — that is the whole point of an
 * install), and make the reward engine's `COMPLETION_EVENT_TYPES` iteration
 * walk past nineteen events it must never see. CONTEXT §3 principle 1 says one
 * source of truth per DOMAIN; growth telemetry and reward-bearing domain facts
 * are two domains, and this file is the single source of truth for one of them.
 *
 * WHAT IS SHARED IS THE PIPE, NOT THE CATALOGUE: every growth event goes
 * through `EventCollectorService` — the same collector, the same
 * `PrivacyFilter`, the same self-hosted store, the same optional PostHog mirror
 * — and several of them are EMITTED BY a domain-event consumer, so the domain
 * bus really is the trigger. See `growth-event-emitter.service.ts`.
 *
 * PRIVACY (CONTEXT §3 principle 8). This is children's data. Two structural
 * rules, both enforced by code in the emitter rather than by review:
 *   1. A growth payload may only contain keys from `ALLOWED_PAYLOAD_KEYS`. It
 *      is an ALLOW-list, not a deny-list, because a deny-list is a list of the
 *      leaks somebody already thought of.
 *   2. No child identifier, no child name, no birth date, no message content,
 *      no app-usage detail ever appears. `childCount` is a number; `childId` is
 *      not in the allow-list at all. A growth funnel does not need to know
 *      WHICH child completed a goal, and a system that could answer that
 *      question from its analytics store is one query away from behavioural ad
 *      profiling of minors — which CONTEXT §3.8 forbids outright.
 */

export const GROWTH_EVENT_NAMES = [
  // -- acquisition (no family yet; keyed on the anonymous session) --
  'APP_INSTALLED',
  'ACCOUNT_CREATED',
  // -- onboarding --
  'FAMILY_CREATED',
  'CHILD_ADDED',
  'DEVICE_PAIRED',
  // -- the value loop --
  'GOAL_CREATED',
  'GOAL_STARTED',
  'GOAL_COMPLETED',
  'REWARD_GRANTED',
  'REWARD_REDEEMED',
  // -- THE activation event. See `activation.ts` for the precise definition. --
  'CHILD_COMPLETES_FIRST_MEANINGFUL_GOAL',
  // -- AI engagement --
  'AI_MESSAGE_SENT',
  'AI_MESSAGE_RECEIVED',
  // -- commercial (revenue facts come from Phase D tables; these are markers) --
  'TRIAL_STARTED',
  'SUBSCRIPTION_STARTED',
  'PAYMENT_SUCCESS',
  'PAYMENT_FAILED',
  'SUBSCRIPTION_CANCELLED',
  // -- referral --
  'REFERRAL_SENT',
  'REFERRAL_CONVERTED',
] as const;

export type GrowthEventName = (typeof GROWTH_EVENT_NAMES)[number];

const GROWTH_EVENT_NAME_SET: ReadonlySet<string> = new Set(GROWTH_EVENT_NAMES);

export function isGrowthEventName(value: string): value is GrowthEventName {
  return GROWTH_EVENT_NAME_SET.has(value);
}

/** Which funnel step an event advances, or `null` when it is not a funnel step. */
export type FunnelStep =
  | 'IMPRESSION'
  | 'VISIT'
  | 'INSTALL'
  | 'REGISTRATION'
  | 'FAMILY_CREATED'
  | 'CHILD_ADDED'
  | 'FIRST_GOAL'
  | 'FIRST_REWARD'
  | 'TRIAL'
  | 'PAID'
  | 'RENEWAL';

/**
 * THE FUNNEL, IN ORDER. Index position IS the ordering — a step cannot be
 * counted higher than its predecessor, and `funnel.service.ts` asserts that
 * monotonicity on every response rather than trusting the queries.
 */
export const FUNNEL_STEPS: readonly FunnelStep[] = [
  'IMPRESSION',
  'VISIT',
  'INSTALL',
  'REGISTRATION',
  'FAMILY_CREATED',
  'CHILD_ADDED',
  'FIRST_GOAL',
  'FIRST_REWARD',
  'TRIAL',
  'PAID',
  'RENEWAL',
];

/**
 * WHERE EACH STEP'S NUMBER COMES FROM, stated per step so nobody has to guess
 * which of them the backend can actually observe.
 *
 * `EXTERNAL` is the honest label for the first two: this server never sees an
 * ad impression or a landing-page visit. Those numbers are REPORTED by an
 * operator from the ad platform into `campaign_daily_spend`, and the API tags
 * them so a dashboard can render them differently from the steps we measure.
 */
export type FunnelStepSource = 'EXTERNAL_REPORTED' | 'ANALYTICS_EVENT' | 'DOMAIN_TABLE';

export interface FunnelStepDefinition {
  readonly step: FunnelStep;
  readonly source: FunnelStepSource;
  readonly measuredBy: string;
  readonly note: string;
}

export const FUNNEL_STEP_DEFINITIONS: Readonly<Record<FunnelStep, FunnelStepDefinition>> = {
  IMPRESSION: {
    step: 'IMPRESSION',
    source: 'EXTERNAL_REPORTED',
    measuredBy: 'campaign_daily_spend.impressions',
    note: 'The backend cannot observe an ad impression. Reported by an operator from the ad platform; tagged EXTERNAL_REPORTED so it is never mistaken for a measurement.',
  },
  VISIT: {
    step: 'VISIT',
    source: 'EXTERNAL_REPORTED',
    measuredBy: 'campaign_daily_spend.visits',
    note: 'A landing-page visit happens on a marketing site this server does not host. Same treatment as IMPRESSION.',
  },
  INSTALL: {
    step: 'INSTALL',
    source: 'ANALYTICS_EVENT',
    measuredBy: "analytics_events WHERE event_name = 'APP_INSTALLED'",
    note: 'Emitted by the app on first launch with an anonymous session id and NO family — the family does not exist yet. This is why AnalyticsEvent.family_id is nullable and PLATFORM_ANNOTATED.',
  },
  REGISTRATION: {
    step: 'REGISTRATION',
    source: 'DOMAIN_TABLE',
    measuredBy: 'families.created_at',
    note: 'Counted from the FAMILY row, not from the event, because the row is the fact and the event is a copy of it. If they ever disagree, the row wins.',
  },
  FAMILY_CREATED: {
    step: 'FAMILY_CREATED',
    source: 'DOMAIN_TABLE',
    measuredBy: 'families.created_at',
    note: 'In this product registration CREATES the family in the same transaction, so this step equals REGISTRATION by construction. It is kept as a distinct step because the brief names it and because a future invite-to-existing-family flow would separate them.',
  },
  CHILD_ADDED: {
    step: 'CHILD_ADDED',
    source: 'DOMAIN_TABLE',
    measuredBy: 'DISTINCT children.family_id',
    note: 'Families with ≥1 child, not the number of children. The funnel counts families through steps, and a family with three children has not passed this step three times.',
  },
  FIRST_GOAL: {
    step: 'FIRST_GOAL',
    source: 'ANALYTICS_EVENT',
    measuredBy: "analytics_events WHERE event_name = 'GOAL_CREATED'",
    note: 'Families with at least one goal ever created (habit, task, learning goal or reward program — all four flow through the same emitter).',
  },
  FIRST_REWARD: {
    step: 'FIRST_REWARD',
    source: 'DOMAIN_TABLE',
    measuredBy: 'DISTINCT rewards_ledger_entries.family_id',
    note: 'Counted from the LEDGER, which is the only authority on whether a reward exists (Phase C PC-B-001 established exactly this).',
  },
  TRIAL: {
    step: 'TRIAL',
    source: 'DOMAIN_TABLE',
    measuredBy: 'trials.family_id',
    note: 'Phase D: one lifetime trial per family, enforced by a UNIQUE constraint, so this count needs no DISTINCT to be correct.',
  },
  PAID: {
    step: 'PAID',
    source: 'DOMAIN_TABLE',
    measuredBy: "DISTINCT payment_transactions.family_id WHERE status = 'SUCCEEDED'",
    note: 'A verified, server-side money movement. Never a client claim, never a subscription row without a transaction behind it.',
  },
  RENEWAL: {
    step: 'RENEWAL',
    source: 'DOMAIN_TABLE',
    measuredBy: 'families with ≥2 SUCCEEDED payment transactions',
    note: 'The second successful charge IS the renewal. Reading `auto_renewing` instead would count intent rather than money.',
  },
};

/** Whether a growth event is tenant-attributable at the moment it is emitted. */
export type GrowthEventTenancy = 'FAMILY_SCOPED' | 'ANONYMOUS';

export interface GrowthEventDefinition {
  readonly name: GrowthEventName;
  readonly tenancy: GrowthEventTenancy;
  /** Which funnel step this event advances, if any. */
  readonly funnelStep: FunnelStep | null;
  /** The module that is allowed to emit it. */
  readonly producer: string;
  /**
   * TRUE when the underlying fact already had a DOMAIN event before Phase D
   * Growth — i.e. this growth event is a projection of an existing signal
   * rather than new instrumentation. The inventory in the Phase D Growth report
   * is generated from this field, not written by hand.
   */
  readonly hadPriorDomainSignal: boolean;
  readonly priorSignal: string | null;
}

export const GROWTH_EVENT_CATALOGUE: Readonly<Record<GrowthEventName, GrowthEventDefinition>> = {
  APP_INSTALLED: {
    name: 'APP_INSTALLED',
    tenancy: 'ANONYMOUS',
    funnelStep: 'INSTALL',
    producer: 'Parent/Child app first launch → POST /analytics/growth/install',
    hadPriorDomainSignal: false,
    priorSignal: null,
  },
  ACCOUNT_CREATED: {
    name: 'ACCOUNT_CREATED',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: 'REGISTRATION',
    producer: 'AuthService.register',
    hadPriorDomainSignal: false,
    priorSignal: null,
  },
  FAMILY_CREATED: {
    name: 'FAMILY_CREATED',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: 'FAMILY_CREATED',
    producer: 'AuthService.register (same transaction as the family row)',
    hadPriorDomainSignal: false,
    priorSignal: null,
  },
  CHILD_ADDED: {
    name: 'CHILD_ADDED',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: 'CHILD_ADDED',
    producer: 'ChildrenService.create',
    hadPriorDomainSignal: false,
    priorSignal: null,
  },
  DEVICE_PAIRED: {
    name: 'DEVICE_PAIRED',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: null,
    producer: 'GrowthDomainEventBridge (subscribes to the DEVICE_PAIRED domain event)',
    hadPriorDomainSignal: true,
    priorSignal: 'DEVICE_PAIRED domain event (F3)',
  },
  GOAL_CREATED: {
    name: 'GOAL_CREATED',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: 'FIRST_GOAL',
    producer: 'RewardProgramService / HabitEngine / SmartTaskEngine via GrowthEventEmitter',
    hadPriorDomainSignal: true,
    priorSignal: 'REWARD_PROGRAM_CREATED domain event (F4) — programs only',
  },
  GOAL_STARTED: {
    name: 'GOAL_STARTED',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: null,
    producer: 'GrowthDomainEventBridge (ACHIEVEMENT_REQUESTED)',
    hadPriorDomainSignal: true,
    priorSignal: 'ACHIEVEMENT_REQUESTED domain event (F4)',
  },
  GOAL_COMPLETED: {
    name: 'GOAL_COMPLETED',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: null,
    producer: 'GrowthDomainEventBridge (every COMPLETION_EVENT_TYPES member)',
    hadPriorDomainSignal: true,
    priorSignal: 'COMPLETION_EVENT_TYPES — 9 domain events (F3/F4)',
  },
  REWARD_GRANTED: {
    name: 'REWARD_GRANTED',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: 'FIRST_REWARD',
    producer: 'GrowthDomainEventBridge (REWARD_GRANTED domain event)',
    hadPriorDomainSignal: true,
    priorSignal: 'REWARD_GRANTED domain event (F3) — emitted only after a real ledger grant',
  },
  REWARD_REDEEMED: {
    name: 'REWARD_REDEEMED',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: null,
    producer: 'RewardsEngineService redemption path via GrowthEventEmitter',
    hadPriorDomainSignal: false,
    priorSignal: null,
  },
  CHILD_COMPLETES_FIRST_MEANINGFUL_GOAL: {
    name: 'CHILD_COMPLETES_FIRST_MEANINGFUL_GOAL',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: null,
    producer: 'ActivationService (derived — see activation.ts for the four gates)',
    hadPriorDomainSignal: false,
    priorSignal: null,
  },
  AI_MESSAGE_SENT: {
    name: 'AI_MESSAGE_SENT',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: null,
    producer: 'AiCoreOrchestratorService via GrowthEventEmitter',
    hadPriorDomainSignal: false,
    priorSignal: null,
  },
  AI_MESSAGE_RECEIVED: {
    name: 'AI_MESSAGE_RECEIVED',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: null,
    producer: 'AiCoreOrchestratorService via GrowthEventEmitter',
    hadPriorDomainSignal: false,
    priorSignal: null,
  },
  TRIAL_STARTED: {
    name: 'TRIAL_STARTED',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: 'TRIAL',
    producer: 'TrialManagerService via GrowthEventEmitter',
    hadPriorDomainSignal: false,
    priorSignal: null,
  },
  SUBSCRIPTION_STARTED: {
    name: 'SUBSCRIPTION_STARTED',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: 'PAID',
    producer: 'SubscriptionService via GrowthEventEmitter',
    hadPriorDomainSignal: false,
    priorSignal: null,
  },
  PAYMENT_SUCCESS: {
    name: 'PAYMENT_SUCCESS',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: 'PAID',
    producer: 'PaymentVerificationService / PaymentWebhookService via GrowthEventEmitter',
    hadPriorDomainSignal: false,
    priorSignal: null,
  },
  PAYMENT_FAILED: {
    name: 'PAYMENT_FAILED',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: null,
    producer: 'PaymentWebhookService via GrowthEventEmitter',
    hadPriorDomainSignal: false,
    priorSignal: null,
  },
  SUBSCRIPTION_CANCELLED: {
    name: 'SUBSCRIPTION_CANCELLED',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: null,
    producer: 'SubscriptionService / PaymentWebhookService via GrowthEventEmitter',
    hadPriorDomainSignal: false,
    priorSignal: null,
  },
  REFERRAL_SENT: {
    name: 'REFERRAL_SENT',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: null,
    producer: 'ReferralService.recordSent',
    hadPriorDomainSignal: false,
    priorSignal: null,
  },
  REFERRAL_CONVERTED: {
    name: 'REFERRAL_CONVERTED',
    tenancy: 'FAMILY_SCOPED',
    funnelStep: null,
    producer: 'ReferralService.qualify',
    hadPriorDomainSignal: false,
    priorSignal: null,
  },
};

/**
 * THE PAYLOAD ALLOW-LIST. A growth event may carry these keys and no others.
 *
 * Read the list and notice what is NOT in it: `childId`, `childName`,
 * `dateOfBirth`, `appPackage`, `messageText`, `email`, `phone`, `deviceId`,
 * `ipAddress`. Not one of the nineteen events needs any of them to move a
 * funnel, and every one of them would turn an aggregate counter into a
 * per-child behavioural record.
 *
 * `GrowthEventEmitter` DROPS an unknown key and logs it at warn. Dropping
 * rather than throwing is deliberate: an over-eager payload must not be able to
 * fail a registration or a payment. The log line is how the drop is noticed.
 */
export const ALLOWED_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  // -- market / platform dimensions --
  'countryCode',
  'currencyCode',
  'platform',
  'locale',
  'appVersion',
  // -- acquisition dimensions --
  'source',
  'medium',
  'campaign',
  'campaignId',
  'channel',
  'content',
  'referralCode',
  // -- commercial dimensions (amounts trace to payment_transactions, which is
  //    the authority; these are for slicing, never for summing revenue) --
  'planTier',
  'billingPeriod',
  'provider',
  'amountMinor',
  'failureReason',
  // -- product dimensions, all of them counts or enums, never identifiers --
  'goalKind',
  'completionKind',
  'rewardType',
  'childCount',
  'deviceCount',
  'grantCount',
  'streakLength',
  'trialDays',
  'timeToValueMinutes',
  'meaningfulGoalRule',
  // -- referral dimensions --
  'referralEventId',
  'referralRewardKind',
]);

/** The growth events that must never be accepted from a client over the wire. */
export const CLIENT_INGESTIBLE_GROWTH_EVENTS: ReadonlySet<GrowthEventName> = new Set([
  // An install is the ONLY growth event a client may originate, because it is
  // the only one that happens before the server knows anything at all. Every
  // other event describes a fact the server itself wrote — a payment, a reward,
  // a family — and accepting a client's word for any of them would let a device
  // manufacture conversions, revenue markers and referral credit.
  'APP_INSTALLED',
]);
