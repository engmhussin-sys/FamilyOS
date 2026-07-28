# Specification — Enumerations Registry

**Status:** Living document — this is the single source of truth for
every officially-defined enum value in the project. Application code
(Prisma enums, Dart `enum`s, TypeScript union types) must match this
file, not the other way around. A code change that introduces a new enum
value updates this file in the same change (Definition of Done §4/§5).

This document does not itself change the database or application code —
it is the reference those changes are checked against.

---

## Device & Pairing

### Device Status (existing — `apps/backend/prisma/schema.prisma`)
| Value | Meaning |
|---|---|
| `PENDING_PAIRING` | Device row created, pairing not yet completed |
| `ACTIVE` | Paired and operational |
| `REVOKED` | Trust explicitly withdrawn (parent action or security event) |
| `LOST` | Reported lost — see Pairing Recovery (Decision-027) |

> Note: `pairing-state-machine.md` §4 defines a richer set of in-progress
> states (`INVITATION_CREATED` through `ACTIVATED`) tracked in the
> proposed `DevicePairingEvent` table (CR-2). `DeviceStatus` above remains
> the fast-read summary field; it is not being replaced.

### Pairing State (proposed — `DevicePairingEvent.toState`, per CR-2)
`INVITATION_CREATED`, `INVITATION_SENT`, `INVITATION_OPENED`,
`AUTHENTICATING`, `DEVICE_REGISTERED`, `DEVICE_VERIFIED`,
`CAPABILITIES_UPLOADED`, `PARENT_CONFIRMED`, `POLICY_ASSIGNED`,
`ACTIVATED`, `HEALTHY`, `DEGRADED`, `SUSPENDED`, `REVOKED`, `REMOVED`.
Full transition rules: `pairing-state-machine.md` §4.

### Trust Level (proposed — `Device.trustLevel`, per CR-3 / Decision-031)
| Value | Meaning |
|---|---|
| `L0_UNKNOWN` | No registration data yet |
| `L1_REGISTERED` | Device Registered, not yet verified |
| `L2_VERIFIED` | Passed Device Verification step |
| `L3_ATTESTED` | Key Attestation chain present and valid |
| `L4_ENTERPRISE` | Device Owner / Android Enterprise mode (§4 of the Android enforcement ADR's "Enhanced Mode") |
| `L5_HIGH_TRUST` | Reserved for future MDM-integrated enterprise/school deployments — not assigned by any current logic |

Full derivation rules: `trust-levels-framework.md` (this step).

### Risk Level (proposed — derived from `DeviceRiskAssessment.riskScore`, per Decision-032)
| Value | Score range (0–100, higher = riskier) |
|---|---|
| `LOW` | 0–24 |
| `MODERATE` | 25–49 |
| `ELEVATED` | 50–74 |
| `HIGH` | 75–100 |

Full scoring rules: `risk-score-framework.md` (this step).

### Device Owner Type (existing)
`PARENT`, `CHILD`

## Family & Consent

### Family Role (existing)
`OWNER`, `PARENT`
> Guardian-type expansion (grandparent, guardian) explicitly deferred —
> see `pairing-state-machine.md` §2. Not yet in this registry because it
> does not exist in the schema yet.

### Consent Type (existing)
`DATA_COLLECTION`, `LOCATION_TRACKING`, `APP_USAGE_MONITORING`,
`AI_BEHAVIOR_ANALYSIS`, `KEYBOARD_BEHAVIOR_ANALYSIS`, `HEALTH_DATA`

## Screen Time & App Control

### App Rule Type (existing)
`BLOCK`, `ALLOW`, `TIME_LIMIT`

## Location

### Zone Type (existing)
`HOME`, `SCHOOL`, `CUSTOM`

### Location Event Type (existing)
`ENTER_ZONE`, `EXIT_ZONE`, `PERIODIC_PING`, `SOS`

## AI Safety

### Alert Category (existing)
`DIGITAL_SAFETY`, `BEHAVIOR`, `HEALTH`, `EDUCATION`, `LOCATION`

### Alert Severity (existing)
`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`

### Alert Status (existing)
`NEW`, `REVIEWED`, `DISMISSED`, `ESCALATED`

## Cross-Cutting

### Actor Type (existing — `apps/backend`'s auth domain, not a DB enum)
`USER`, `DEVICE`, `SYSTEM`

### Subscription Plan (existing)
`FREE`, `PREMIUM`, `FAMILY`, `ENTERPRISE`

### Tamper Signal (proposed — `apps/child-app`'s `IAntiTamper` contract, Step 9)
`serviceDisabled`, `accessibilityDisabled`, `usageAccessDisabled`,
`appForceStopped`, `apkReinstalled`, `deviceRebooted`,
`permissionsRevoked`, `timeManipulationDetected`,
`factoryResetDetected`, `rootDetected`, `mockLocationDetected`,
`emulatorDetected`, `developerModeEnabled`, `usbDebuggingEnabled`.
(Dart-side `camelCase` per Dart convention — the backend-side
representation of the same values, once a schema exists for reporting
them, should use the project's standard `SCREAMING_SNAKE_CASE` and this
registry updated to show both forms side by side at that time.)

### Health Status (proposed — device operational state, feeds `DeviceHealthScore`)
`HEALTHY`, `DEGRADED`, `CRITICAL`, `UNKNOWN`
(`UNKNOWN` applies to a device that has never sent a heartbeat — distinct
from `DEGRADED`, which implies a previously-healthy device with a recent gap.)

### Sync Transport (existing — `apps/child-app`'s `ISyncEngine` contract)
`pushNotification`, `persistentWebSocket`, `pollingFallback`

---

## Maintenance rule

When adding a new enum anywhere in the codebase (Prisma schema, Dart
contract, TypeScript domain type): add it here in the same change. When
a value in this registry doesn't yet exist in code (marked "proposed"
above), that is intentional — this registry may define a value ahead of
its implementation, as the agreed target, but code must never diverge
from what's written here once both exist.
