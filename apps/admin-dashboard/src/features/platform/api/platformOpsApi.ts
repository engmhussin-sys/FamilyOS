import { adminGet, adminPut } from '../../../shared/lib/adminHttp';

/**
 * The operator endpoints behind `InternalAdminGuard` that answer «is the
 * platform working» and «what does it sell». Transcribed from the controllers:
 *
 *   GET /system/readiness   · GET /system/diagnostics
 *     modules/system-diagnostics/presentation/controllers/system-diagnostics.controller.ts
 *   GET /system/billing/plans · PUT /system/billing/plans
 *     modules/billing/presentation/controllers/billing-operations.controller.ts
 */

export interface ReadinessComponent {
  component: string;
  status: 'READY' | 'NOT_READY' | 'NOT_APPLICABLE';
  detail: string;
}

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checkedAt: string;
  components: ReadinessComponent[];
}

/**
 * `schema` is the field that answers "is this container running on the schema
 * its code expects" — added because a green deploy badge could not. `available:
 * false` means the database has no Prisma migration ledger at all.
 */
export interface SchemaStatus {
  available: boolean;
  reason?: string;
  appliedCount: number;
  latestName: string | null;
  latestAppliedAt: string | null;
  unfinishedCount: number;
  unfinishedNames: string[];
}

export interface Diagnostics {
  version: string;
  commit: string | null;
  environment: string;
  schema: SchemaStatus;
  uptimeSeconds: number;
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
  configValidation: { isValid: boolean; warningCount: number; warningKeys: string[] };
  featureFlags: { key: string; isEnabledGlobally: boolean }[];
}

export type PlanTier = 'FREE' | 'BASIC' | 'PREMIUM' | 'FAMILY' | 'ENTERPRISE';

export interface PlanDefinition {
  id: string;
  tier: PlanTier;
  name: string;
  priceCents: number;
  currency: string;
  billingIntervalMonths: number;
  features: string[];
  isActive: boolean;
}

export interface PlanCatalogue {
  plans: PlanDefinition[];
  /** True when nothing is defined — the state in which every paid feature is locked. */
  isEmpty: boolean;
  availableFeatures: string[];
}

export const platformOpsApi = {
  readiness: () => adminGet<ReadinessReport>('/system/readiness'),
  diagnostics: () => adminGet<Diagnostics>('/system/diagnostics'),
  plans: () => adminGet<PlanCatalogue>('/system/billing/plans'),
  upsertPlan: (plan: Omit<PlanDefinition, 'id'>) => adminPut<PlanDefinition>('/system/billing/plans', plan),
};

/**
 * A support request as the queue returns it. `familyId` is nullable on purpose:
 * a request can come from somebody not signed in, and `email` is captured
 * explicitly so the reply has somewhere to go even if the account changes.
 */
export interface SupportRequest {
  id: string;
  familyId: string | null;
  userId: string | null;
  email: string;
  subject: string;
  message: string;
  /**
   * Computed at submission time from the household's entitlements, never
   * client-supplied — so it is a fact about what they bought, not a claim about
   * how urgent they feel.
   */
  isPriority: boolean;
  createdAt: string;
}

export const supportApi = {
  /** GET /support — behind InternalAdminGuard; the backend caps it at 200. */
  list: () => adminGet<SupportRequest[]>('/support'),
};
