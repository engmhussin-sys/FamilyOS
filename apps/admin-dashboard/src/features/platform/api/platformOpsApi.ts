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
