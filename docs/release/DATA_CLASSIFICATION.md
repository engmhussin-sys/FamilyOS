# Data Classification Map

Every data category this system actually stores, classified by
sensitivity, with real encryption/retention/deletion/audit status —
cross-referenced against `schema.prisma` and Sprint 9's Data Retention
Policy, not invented fresh here.

| Category | Classification | Examples | Encryption | Retention | Deletion | Audit |
|---|---|---|---|---|---|---|
| Child identity | **Child Sensitive** | `Child.firstName`, `dateOfBirth` | Disk-level (hosting-provider), not application-level | Indefinite while account active | Soft delete (`Child.deletedAt`) | Covered indirectly via `AuditLog` on parent actions touching it |
| Child location | **Child Sensitive** | `LocationEvent` | ✅ Application-level (`LOCATION_ENCRYPTION_KEY`) — the one field with explicit app-layer encryption | Not defined — **a real gap, flagged here** | Not defined — same gap | Not defined — same gap |
| Screen time policy | **Parent Sensitive** | `ScreenTimePolicy` | Disk-level only | Indefinite (versioned, superseded not deleted) | N/A — append-only by design | `screenTime.policy.changed` (Sprint 9 `AuditService`) |
| Device runtime state | **Confidential** | `Device.lastTelemetry`, `capabilityProfile` | Disk-level only | Current-state cache, no history | Overwritten, not deleted | Not directly audited |
| Pairing/Trust/Risk history | **Confidential** | `DevicePairingEvent`, `DeviceRiskAssessment` | Disk-level only | Indefinite — append-only audit trail (Decision-059) | Never auto-deleted; archivable | Is itself the audit trail |
| AI decisions | **Parent Sensitive** | `AiMemoryEntry` | Disk-level only | 365 days (Sprint 9 policy) | Policy defined, **enforcement not scheduled** | Not duplicated into `AuditLog` (deliberate, own trail) |
| Notifications | **Internal** | `Notification` | Disk-level only | 90 days, hard delete | Real code exists, **not scheduled to run** | Not audited (transient) |
| Analytics events | **Internal**, PII-filtered at write | `AnalyticsEvent` | Disk-level; `PrivacyFilter` strips PII before storage | 180 days, then anonymized | Real code exists, **not scheduled** | Anonymization IS the audit-relevant action |
| Audit logs | **Confidential** | `AuditLog` | Disk-level only | Indefinite by default (Decision-063) | Never auto-deleted | Is itself the audit mechanism |
| User credentials | **Confidential** | `User.passwordHash` | `argon2` hash, never plaintext | Indefinite while active | Soft delete with User row | `auth.login`/`logout`/`register` (Sprint 9) |
| Billing/Payment | **Confidential** | `Subscription`, `Invoice` | Disk-level only — **no card data ever stored**, only provider references | Indefinite | Never auto-deleted (financial record) | `billing.subscribed`/`canceled` (Sprint 9) |
| Organization Platform data | **Public/N/A** | `Organization` + satellites | N/A | N/A | N/A | N/A — **zero rows exist**, architecture only |

## Real gaps surfaced by writing this document

1. **`LocationEvent` has no defined retention/deletion policy** — the
   one Child Sensitive category with real legal weight is the LEAST
   governed by policy today. Highest priority for a future pass.
2. **Neither Notification nor Analytics Event retention is actually
   scheduled** — enforcement code is real and tested, but nothing calls
   it periodically since no job scheduler exists (confirmed by grep, Sprint 9).

## Relevance to School/Bank future editions

Every "Child/Parent Sensitive" row would need re-classification once a
real user is a Student or Bank Employee — different regulatory regimes
(FERPA-like for schools, banking data rules for banks) apply to
conceptually-similar data. This table is Family-edition scoped only.
