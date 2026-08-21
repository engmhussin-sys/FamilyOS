import { adminGet, adminPost, adminQuery as query } from '../../../shared/lib/adminHttp';

/**
 * THE PLATFORM OWNER'S TWO OPERATOR ENDPOINTS, transcribed from the
 * controllers rather than from a document:
 *
 *   GET  /system/accounts
 *     apps/backend/src/modules/system-diagnostics/presentation/controllers/accounts-console.controller.ts
 *   GET  /system/billing/grants  ·  POST /system/billing/grants/features
 *   POST /system/billing/grants/revoke
 *     apps/backend/src/modules/billing/presentation/controllers/billing-operations.controller.ts
 *
 * Both are behind `InternalAdminGuard`, so both go through `adminHttp`, which
 * attaches the operator key from memory and never from storage.
 */

/** One household. Every field exists on `IAccountRow` in the backend. */
export interface AccountRow {
  familyId: string;
  familyName: string;
  countryCode: string | null;
  createdAt: string;
  ownerEmail: string | null;
  ownerStatus: string | null;
  memberCount: number;
  childCount: number;
  deviceCount: number;
  subscriptionStatus: string | null;
  planTier: string | null;
  lastSeenAt: string | null;
  hasLiveEntitlement: boolean;
}

export interface AccountsPage {
  rows: AccountRow[];
  /** null when this is the last page — the ONLY signal that it is. */
  nextCursor: string | null;
}

/**
 * The six entitlement keys, mirroring `ENTITLEMENT_KEYS` in
 * `apps/backend/src/modules/billing/domain/billing.types.ts`. The backend
 * validates against its own copy and answers 400 naming the valid keys, so a
 * drift here is a visible error rather than a silent grant of nothing.
 */
export const ENTITLEMENT_KEYS = [
  'ai_diagnostics',
  'family_insights',
  'multiple_children',
  'unlimited_devices_per_child',
  'behavioral_trend_analysis',
  'priority_support',
] as const;

export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

export interface EntitlementState {
  familyId: string;
  features: EntitlementKey[];
  validUntil: string | null;
  planTier: string | null;
}

export interface GrantResult {
  familyId: string;
  planTier: string;
  validUntil: string;
  features: EntitlementKey[];
}

export const platformAccountsApi = {
  list(params: { limit?: number; cursor?: string | null; search?: string | null }): Promise<AccountsPage> {
    return adminGet<AccountsPage>(
      `/system/accounts${query({
        limit: params.limit,
        cursor: params.cursor ?? undefined,
        search: params.search ?? undefined,
      })}`,
    );
  },

  entitlements(email: string): Promise<EntitlementState> {
    return adminGet<EntitlementState>(`/system/billing/grants${query({ email })}`);
  },

  grantFeatures(input: {
    email: string;
    features: EntitlementKey[];
    planTier: string;
    days: number;
    reason: string;
  }): Promise<GrantResult> {
    return adminPost<GrantResult>('/system/billing/grants/features', input);
  },

  /**
   * GRANT A WHOLE TIER — `POST /system/billing/grants`, the route that has been
   * built, guarded and audited since the operator console landed and that no
   * button in this dashboard has ever called.
   *
   * It grants whatever the TIER says, read from `plan_definitions`, which is
   * the difference that matters: a feature grant comps six named keys, while
   * this comps «PREMIUM, as PREMIUM is currently defined», and follows the
   * catalogue if the catalogue is later edited.
   *
   * IT FAILS WITH A NAMED CODE ON AN EMPTY CATALOGUE. `PLAN_CATALOGUE_EMPTY`
   * (409) is not an error to smooth over — it is the backend saying «this
   * platform has not decided what PREMIUM includes». The panel surfaces it as
   * itself and points at the catalogue screen, because granting a tier that
   * lists no features would write rows that unlock nothing and look successful.
   */
  grantPlan(input: { email: string; planTier: string; days: number; reason: string }): Promise<GrantResult> {
    return adminPost<GrantResult>('/system/billing/grants', input);
  },

  revoke(input: { email: string; reason: string }): Promise<{ familyId: string; revokedCount: number }> {
    return adminPost<{ familyId: string; revokedCount: number }>('/system/billing/grants/revoke', input);
  },
};

/** One household in detail. Mirrors `IHouseholdDetail` on the backend. */
export interface HouseholdDetail {
  familyId: string;
  familyName: string;
  countryCode: string | null;
  timezone: string;
  createdAt: string;
  members: {
    userId: string;
    email: string;
    fullName: string;
    role: string;
    status: string;
    emailVerifiedAt: string | null;
    joinedAt: string;
  }[];
  /**
   * A child appears by first name and AGE BAND. There is no date of birth in
   * this type because there is none in the response — the backend query does
   * not select the column at all.
   */
  children: { childId: string; firstName: string; ageYears: number | null; createdAt: string }[];
  devices: { deviceId: string; platform: string | null; status: string | null; lastSeenAt: string | null }[];
  subscription: {
    planTier: string;
    status: string;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
  } | null;
  entitlements: { featureKey: string; status: string; source: string; validUntil: string | null }[];
  audit: { action: string; actorType: string; createdAt: string; metadata: unknown }[];
}

export interface StatusChange {
  userId: string;
  familyId: string | null;
  from: string;
  to: string;
}

export const householdApi = {
  detail: (familyId: string) => adminGet<HouseholdDetail>(`/system/accounts/${familyId}`),

  /**
   * `status: 'ACTIVE'` means RESTORE what suspension replaced, not "set to
   * ACTIVE" — a newly registered user is PENDING_VERIFICATION, and promoting
   * one to ACTIVE from here would mark an unverified email as verified. The
   * backend reads the prior status from its own audit row and refuses when
   * there is none.
   */
  setStatus: (input: { userId: string; status: 'ACTIVE' | 'SUSPENDED'; reason: string }) =>
    adminPost<StatusChange>('/system/accounts/actions/status', input),
};
