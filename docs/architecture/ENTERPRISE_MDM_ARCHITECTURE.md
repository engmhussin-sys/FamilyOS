# Enterprise / MDM Architecture (FamilyOS)

**Status:** Architecture direction adopted. **No implementation.** This
covers the Company/Bank/School editions' device-management layer —
distinct from the Family edition's consumer pairing flow (Sprint 3's
`PairingModule`, unchanged).

## Why this is a separate concern from `PairingModule`

`PairingModule` (Sprints 2–8) is built for **consumer, consent-based**
pairing: a parent generates a code, a child's device redeems it,
trust is established progressively (L0→L5) based on signals the
device itself reports. This model is correct for Family edition and
**stays exactly as-is.**

Enterprise device management is a different trust model entirely: a
Company/Bank/School **enrolls devices it already administratively
controls** (via MDM), and FamilyOS's role becomes a *managed app*
receiving configuration from the MDM platform, not the primary
consent/pairing authority. These are genuinely different architectures,
not a superset/subset of each other.

## The four MDM platforms, honestly scoped

| Platform | What it actually provides | Integration shape |
|---|---|---|
| **Apple MDM** (via ABM/ASM enrollment) | Managed App Configuration (a plist of key-value pairs pushed to the app at install time), remote app install/removal, supervised-device restrictions. | FamilyOS's iOS app reads Managed App Config as an *alternative* to its own Sprint-2-style pairing flow — the MDM push replaces the "scan a code" step, feeding the same underlying `Device` registration data. |
| **Microsoft Intune** | Cross-platform (iOS + Android) MDM via Graph API; App Configuration Policies (same concept as Apple's, Microsoft's format). | Same integration shape as Apple MDM, different config-push mechanism and API surface. |
| **Jamf** | Apple-ecosystem-focused MDM, often used by schools (pairs naturally with Apple School Manager). | Same shape again — Jamf ultimately also delivers via Apple's Managed App Configuration under the hood for iOS. |
| **Workspace ONE** (VMware) | Cross-platform enterprise MDM, common in banking/finance due to its compliance/attestation features. | Same shape; likely the most relevant one for the Bank edition given the sector's existing MDM conventions. |

## The contract every MDM adapter would implement (unimplemented)

```typescript
// Illustrative only — not a real file in this codebase yet.
interface IMdmProviderAdapter {
  readonly providerName: 'APPLE_MDM' | 'INTUNE' | 'JAMF' | 'WORKSPACE_ONE';

  onManagedConfigReceived(config: Record<string, unknown>): Promise<void>;

  reportComplianceStatus?(status: 'COMPLIANT' | 'NON_COMPLIANT'): Promise<void>;
}
```

This mirrors the exact adapter-registry pattern already proven twice in
this codebase (`IPaymentProviderAdapter`/`PaymentProviderRegistry` in
Billing, `IAnalyticsProviderAdapter` in Analytics) — the same shape,
applied to a third category of external integration, for consistency
a future implementer can rely on rather than invent a new pattern.

## What connects to the Organization Platform

An enrolled enterprise device's `Device` row would carry an
`organizationId` (once the Organization Platform migration described in
`ORGANIZATION_PLATFORM_ARCHITECTURE.md` actually happens) pointing at
the Company/Bank/School `Organization`, rather than a `familyId` — the
same `Device` table, a different owning-entity type. This is exactly
why Family becoming "a type of Organization" matters structurally: a
managed enterprise device and a consumer-paired family device can share
one `Device` schema and one Runtime Engine, differing only in which
`Organization.type` owns them and which pairing/enrollment path was used.

## What a future "build MDM support" sprint would need to scope

- Which MDM platform to build first (a real business decision — likely
  driven by which enterprise customer signs first, not a technical
  ranking).
- The actual Managed App Configuration schema FamilyOS's app would
  read (device-side Swift/Kotlin work, platform-specific).
- Compliance-reporting cadence and what "compliant" means for a
  Bank-edition device specifically (a policy decision, not
  architecture).
