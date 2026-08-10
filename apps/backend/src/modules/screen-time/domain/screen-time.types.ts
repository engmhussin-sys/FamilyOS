export interface ISetScreenTimePolicyInput {
  dailyLimitMinutes?: number;
  /** "HH:mm", local to the child's device — e.g. "21:00" */
  bedtimeStart?: string;
  bedtimeEnd?: string;
  /** Per-weekday overrides, shape owned by the frontend for now — e.g.
   * { "friday": { "dailyLimitMinutes": 180 } }. Kept as an opaque JSON
   * object at this layer; validated only for "is it an object" at the DTO
   * level (see set-screen-time-policy.dto.ts) rather than a rigid schema,
   * since the exact per-weekday shape is still likely to evolve. */
  weekdaySchedule?: Record<string, unknown>;
  focusModeEnabled?: boolean;
}

/**
 * CLOSES A REAL GAP (found in a follow-up hardening pass): the
 * `AppBlockRule` table has existed in the schema since Sprint 4, and
 * `PairingOrchestratorService.getPolicySync()`'s own docstring
 * explicitly flagged `blockedPackages` as "always [] today... no
 * service/API built for it yet." This is that service/API, built the
 * same way ScreenTimePolicy above already was — same module, same
 * Repository Pattern, same ownership-check discipline.
 */
export type AppRuleType = 'BLOCK' | 'ALLOW' | 'TIME_LIMIT';

export interface IAppBlockRule {
  id: string;
  childId: string;
  packageName: string | null;
  category: string | null;
  ruleType: AppRuleType;
  limitMinutes: number | null;
  schedule: Record<string, unknown> | null;
  isActive: boolean;
}

export interface ICreateAppBlockRuleInput {
  /** Exactly one of packageName/category must be set — validated at
   * the DTO layer (see app-block-rule.dto.ts), not re-validated here;
   * this type intentionally allows both to be optional so the DTO's
   * validator is the single source of truth for that rule. */
  packageName?: string;
  category?: string;
  ruleType: AppRuleType;
  limitMinutes?: number;
  schedule?: Record<string, unknown>;
}
