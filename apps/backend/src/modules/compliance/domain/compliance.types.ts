/** Mirrors the ConsentType enum in prisma/schema.prisma exactly — kept as
 * a plain TS union (not imported from @prisma/client) so the domain layer
 * doesn't depend on the ORM's generated types, consistent with the rest
 * of this codebase's layering (see auth-module.md's `toFamilyRole` note
 * for the same reasoning applied elsewhere). */
export const CONSENT_TYPES = [
  'DATA_COLLECTION',
  'LOCATION_TRACKING',
  'APP_USAGE_MONITORING',
  'AI_BEHAVIOR_ANALYSIS',
  'KEYBOARD_BEHAVIOR_ANALYSIS',
  'HEALTH_DATA',
] as const;

export type ConsentTypeValue = (typeof CONSENT_TYPES)[number];

export interface ISetConsentInput {
  consentType: ConsentTypeValue;
  granted: boolean;
}

export interface IConsentRecord {
  consentType: string;
  granted: boolean;
  grantedAt: Date;
  revokedAt: Date | null;
}

/** A single child's exportable data — deliberately scoped to ONE child at
 * a time (not a whole-family dump). This mirrors how GDPR/COPPA "right to
 * access" requests are actually scoped in practice (a specific data
 * subject's data) and lets this reuse ChildrenService/ScreenTimeService/
 * ConsentService directly instead of a new cross-cutting raw-Prisma query. */
export interface IChildDataExport {
  exportedAt: Date;
  child: {
    id: string;
    firstName: string;
    lastName: string | null;
    dateOfBirth: Date;
    gender: string | null;
    isActive: boolean;
    createdAt: Date;
  };
  activeScreenTimePolicy: {
    dailyLimitMinutes: number | null;
    bedtimeStart: string | null;
    bedtimeEnd: string | null;
    focusModeEnabled: boolean;
  } | null;
  consents: IConsentRecord[];
  /** CLOSES A REAL GAP found during a proactive compliance review:
   * the Digital Wellbeing Engine's data (app usage, pickups, night
   * usage, blocked attempts) had zero representation in a data
   * subject's own export until this field \u2014 a genuine right-to-access
   * gap for a Child Sensitive data category. `null` when the child has
   * no wellbeing history yet (honest absence, not a fabricated empty
   * object). */
  digitalWellbeing: {
    windowDays: number;
    averageDailyScreenMinutes: number;
    averagePickups: number;
    averageNightUsageMinutes: number;
    totalBlockedAttempts: number;
    daysWithData: number;
  } | null;
  /** CLOSES THE REST OF THE GAP. Identity, one screen-time policy, consents
   * and a wellbeing average were the whole export — the child's messages,
   * their rewards ledger, their habit / health / learning history and the fact
   * that location data is held about them at all had no representation in
   * their own subject-access response. See `IChildDataExportRecords`, and
   * `IExportedLocationSummary` for the one category that is deliberately
   * summarised rather than enumerated. */
  records: IChildDataExportRecords;
}

/**
 * A BOUNDED ENUMERATION, and the reason this shape exists rather than a plain
 * array.
 *
 * A subject-access export must be complete enough to be honest and small
 * enough to be produced. A family that has been on the product for two years
 * has tens of thousands of habit completions and hydration entries; loading
 * them all into one JSON response is how an export endpoint becomes an
 * out-of-memory incident, and this endpoint is a synchronous HTTP GET with no
 * streaming and no pagination.
 *
 * So every enumerated category returns the NEWEST `limit` rows and states, as
 * data, exactly what it did: `total` is a real `COUNT` over the whole
 * category, `returned` is what is in `items`, and `truncated` says whether the
 * two differ. A reader is never left guessing whether an empty array means
 * «none» or «too many» — and a data subject who needs the remainder can be
 * told a true number rather than shown a silent cut.
 */
export interface IBoundedExportSet<T> {
  /** Every row in this category for this child. A real count, never an estimate. */
  total: number;
  /** How many are in `items`. */
  returned: number;
  /** `true` when `total > returned`. */
  truncated: boolean;
  /** The cap that produced the truncation. */
  limit: number;
  /** The newest `returned` rows, newest first. */
  items: T[];
}

export interface IExportedChildMessage {
  createdAt: Date;
  /** PARENT | AI | SYSTEM. Deliberately NOT the author's user id or name. */
  authorType: string;
  approvalStatus: string;
  category: string;
  title: string;
  body: string;
  deliveredAt: Date | null;
  acknowledgedAt: Date | null;
}

export interface IExportedLedgerEntry {
  createdAt: Date;
  /** EARN | REDEEM. */
  type: string;
  rewardType: string;
  /** Unsigned magnitude, as stored. */
  amount: number;
  /** Signed movement — the column a balance is actually `SUM`med from. */
  delta: number;
  source: string;
  businessDate: Date | null;
}

export interface IExportedHabitCompletion {
  date: Date;
  completedAt: Date;
  status: string;
  habitTitle: string;
}

export interface IExportedNutritionLog {
  date: Date;
  mealType: string;
  calories: number | null;
}

export interface IExportedHydrationLog {
  loggedAt: Date;
  amountMl: number;
}

export interface IExportedSleepLog {
  date: Date;
  sleepStart: Date;
  sleepEnd: Date;
  quality: number | null;
}

export interface IExportedActivityLog {
  date: Date;
  activityType: string;
  durationMinutes: number;
  socialContext: string;
}

export interface IExportedMeasurementLog {
  date: Date;
  heightCm: number | null;
  weightKg: number | null;
}

export interface IExportedHealthScore {
  date: Date;
  score: number;
}

export interface IExportedLearningSession {
  date: Date;
  subject: string;
  durationMinutes: number;
  progressNote: string | null;
}

export interface IExportedLearningAssessment {
  takenAt: Date;
  subject: string;
  scorePercent: number;
  source: string;
}

/**
 * LOCATION IS SUMMARISED, NOT ENUMERATED, AND THAT IS A PRIVACY DECISION
 * BEFORE IT IS A SIZE ONE.
 *
 * `location_events` stores coordinates ENCRYPTED at rest (`latitude_enc` /
 * `longitude_enc`) precisely so that a plaintext movement history of a child
 * exists nowhere in this system. Enumerating them into an export means
 * decrypting them into a downloadable file — manufacturing exactly the artefact
 * the column-level encryption was chosen to prevent, and handing it to whoever
 * has the parent's session. A right-of-access request is answered by telling
 * the subject WHAT is held about them; it does not require the product to
 * create a new, more dangerous copy of it.
 *
 * The size argument points the same way. A device that pings every few minutes
 * produces hundreds of thousands of rows a year — the single largest table in
 * a family's data and the one that would OOM this endpoint first.
 *
 * So this reports the shape of what is held: how many events, of which kinds,
 * over which period, against which named safe zones, and when the rows are due
 * to be deleted under retention. `null` when the child has no location history
 * at all — an honest absence, not a zeroed summary.
 */
export interface IExportedLocationSummary {
  totalEvents: number;
  /** Event type -> count. */
  eventCounts: Record<string, number>;
  firstRecordedAt: Date;
  lastRecordedAt: Date;
  /** Names only — a safe zone's own coordinates are not the child's data. */
  safeZoneNames: string[];
  /** The earliest retention expiry among the stored events. */
  earliestExpiresAt: Date | null;
}

/**
 * Everything this export adds beyond identity, screen-time policy, consents
 * and the wellbeing summary — the categories a review found completely absent
 * from a supposedly subject-access export.
 */
export interface IChildDataExportRecords {
  messages: IBoundedExportSet<IExportedChildMessage>;
  rewards: {
    /** The reconcilable cache of the ledger. `null` if the child has no account. */
    account: { xp: number; coins: number; stars: number; level: number; updatedAt: Date } | null;
    /** Signed `SUM(delta)` per reward type, computed in SQL over the WHOLE ledger —
     * so a truncated `ledger.items` never implies a wrong balance. */
    balancesFromLedger: Record<string, number>;
    ledger: IBoundedExportSet<IExportedLedgerEntry>;
  };
  habits: {
    definitions: Array<{ title: string; category: string; recurrence: string; isActive: boolean; createdAt: Date }>;
    completions: IBoundedExportSet<IExportedHabitCompletion>;
  };
  health: {
    nutrition: IBoundedExportSet<IExportedNutritionLog>;
    hydration: IBoundedExportSet<IExportedHydrationLog>;
    sleep: IBoundedExportSet<IExportedSleepLog>;
    activity: IBoundedExportSet<IExportedActivityLog>;
    measurements: IBoundedExportSet<IExportedMeasurementLog>;
    dailyScores: IBoundedExportSet<IExportedHealthScore>;
  };
  learning: {
    goals: Array<{ subject: string; title: string; status: string; targetDate: Date | null; createdAt: Date }>;
    sessions: IBoundedExportSet<IExportedLearningSession>;
    assessments: IBoundedExportSet<IExportedLearningAssessment>;
  };
  /** See `IExportedLocationSummary` for why this is a summary and not a list. */
  location: IExportedLocationSummary | null;
}
