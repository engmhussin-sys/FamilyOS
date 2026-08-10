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
}
