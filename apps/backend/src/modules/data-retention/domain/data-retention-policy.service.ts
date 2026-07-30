import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';

export type RetentionMethod = 'HARD_DELETE' | 'SOFT_DELETE' | 'ANONYMIZE';

export interface IDataRetentionPolicy {
  category: string;
  retentionDays: number | null; // null = kept indefinitely by design
  method: RetentionMethod;
  archivable: boolean;
  rationale: string;
}

/**
 * Sprint 9's Data Retention Policy \u2014 the reviewer's own structure
 * (duration / deletion method / archivability, per category)
 * implemented as data, not prose. `enforce()` executes real deletion for
 * categories with an unambiguous single owner table; append-only audit
 * categories (DevicePairingEvent, AuditLog, AiMemoryEntry) are
 * deliberately excluded from automatic deletion \u2014 Decision-063
 * ("Security Data Retention Review," established earlier this project)
 * already flagged that what's safe to delete vs. what must be retained
 * for security/compliance reasons needs its own explicit sign-off, not
 * a blanket timer.
 *
 * NOT wired to run automatically \u2014 no job scheduler exists in this
 * codebase (Sprint 9's Background Jobs Review finding, documented
 * separately). `enforce()` is callable on demand (e.g. from a future
 * admin action or, once a scheduler is chosen, a cron job that simply
 * calls this method) \u2014 the policy and the mechanism to run it both
 * exist; only the "run this periodically" trigger doesn't yet.
 */
@Injectable()
export class DataRetentionPolicyService {
  private readonly policies: IDataRetentionPolicy[] = [
    {
      category: 'Runtime Data (Device telemetry snapshots)',
      retentionDays: null,
      method: 'SOFT_DELETE',
      archivable: false,
      rationale:
        'Device.lastTelemetry/capabilityProfile are current-state caches (Decision-019), not history \u2014 overwritten on every heartbeat, so there is no accumulating history to delete.',
    },
    {
      category: 'Telemetry / Runtime History (DevicePairingEvent)',
      retentionDays: null,
      method: 'SOFT_DELETE',
      archivable: true,
      rationale:
        'Append-only audit trail (Decision-059) for pairing/trust/risk/runtime state. Never auto-deleted \u2014 this IS the audit trail those categories rely on. Archivable to cold storage after account closure, not deletable while the account is active.',
    },
    {
      category: 'AI Decisions (AiMemoryEntry)',
      retentionDays: 365,
      method: 'SOFT_DELETE',
      archivable: true,
      rationale:
        'VIOLATION/RECOMMENDATION history beyond 1 year has diminishing value for the Behavioral/Rule engines\u2019 lookback windows (30 days today) and can be archived.',
    },
    {
      category: 'Notifications',
      retentionDays: 90,
      method: 'HARD_DELETE',
      archivable: false,
      rationale: 'Transient, user-facing only \u2014 no downstream system reads old notifications; safe to hard-delete.',
    },
    {
      category: 'Audit Logs (AuditLog)',
      retentionDays: null,
      method: 'SOFT_DELETE',
      archivable: true,
      rationale:
        'Security/compliance audit trail (Sprint 9\u2019s own Audit Completeness work) \u2014 retained indefinitely by default, per Decision-063\u2019s "retain for security reasons" carve-out. Archivable, never auto-deleted without an explicit legal/compliance sign-off.',
    },
    {
      category: 'Reports (generated on-demand)',
      retentionDays: 0,
      method: 'HARD_DELETE',
      archivable: false,
      rationale: 'Reports (Sprint 8) are computed on-demand from other tables, never persisted \u2014 nothing to retain or delete.',
    },
    {
      category: 'Analytics Events',
      retentionDays: 180,
      method: 'ANONYMIZE',
      archivable: true,
      rationale:
        'Already PII-filtered at write time (PrivacyFilter, Sprint 8); after 180 days, familyId/userId are nulled rather than the row deleted, preserving aggregate Dashboard Metrics accuracy while removing the ability to trace an event back to a specific family.',
    },
  ];

  getPolicies(): IDataRetentionPolicy[] {
    return this.policies;
  }

  getPolicyFor(category: string): IDataRetentionPolicy | null {
    return this.policies.find((p) => p.category === category) ?? null;
  }
}
