# Organization Platform Architecture (FamilyOS)

**Status:** Architecture direction adopted. **Not implemented.** This
document, the additive schema in `schema.prisma`, and the port
interfaces in `src/modules/organization/` are the complete scope of
this decision for the current sprint — no repository implementation,
no NestJS module registration, no controller, no call site anywhere in
the existing codebase.

## The product decision this documents

FamilyOS v1.0 targets four organization types: **Family, School,
Company, Bank**. Government is explicitly **v2, out of scope now** — the
`OrganizationType` enum deliberately does not include it; adding it
later is a safe, additive enum value when v2 arrives.

## Core principle: Family is a TYPE of Organization, not a separate concept

Per the closing direction: Family, School, Company, and Bank all
eventually resolve through the **same RBAC + Policy engine**, differing
only by `Organization.type`. This is why `OrganizationMember` and
`OrganizationPolicy` exist as single, type-agnostic tables rather than
one bespoke table per organization type — a School's teacher role and a
Bank's compliance-officer role are both just `OrganizationMember` rows
with a different `role` value, not different schemas.

## What did NOT happen: `Family` was not migrated

This is the most important constraint honored in this pass. **Every
existing table (`Family`, `FamilyMember`, `Child`, `Device`,
`Subscription`, all of it) is completely untouched.** `Organization` is
a new, parallel, currently-empty table with zero foreign keys to or
from any existing table.

### The eventual convergence path (documented, not executed)

When a future sprint is explicitly scoped to perform this migration:

1. **Backfill, don't rename.** For every existing `Family` row, create
   a corresponding `Organization` row with `type = FAMILY` and the
   **same `id`** as the `Family` row. This makes `Family.id` and
   `Organization.id` interchangeable for a family, without touching a
   single existing foreign key (`Child.familyId`, `Device.familyId`,
   etc. keep pointing at the same UUID — it's just that the UUID now
   also resolves in the `Organization` table).
2. **Dual-write period.** New code paths (RBAC checks, org-level
   policies) read from `Organization`/`OrganizationMember`. Existing
   code paths keep reading `Family`/`FamilyMember` unchanged. Both are
   valid simultaneously because of step 1's shared ID.
3. **Only after the dual-write period is proven stable** would
   `Family`/`FamilyMember` become thin views/aliases over
   `Organization`/`OrganizationMember` — and that is a decision for
   whichever future sprint is explicitly scoped to make Sprint-8/9's
   already-shipped, tested Family-based code depend on the new tables.
   **This document does not authorize that step** — it only ensures the
   schema doesn't need to be redesigned when that day comes.

This is why the instruction "don't redesign any previous Sprint" and
"adopt Multi-Tenant now" are simultaneously satisfiable: the new schema
exists and is correctly shaped, but nothing that already works was
touched to make room for it.

## RBAC Engine (`IRbacEngine`, unimplemented)

One `hasPermission({ userId, organizationId, resource, action })` call
replaces what today is scattered across every module as ad-hoc,
per-module ownership checks: `ChildrenService.assertChildBelongsToFamily`,
`PairingOrchestratorService.assertDeviceBelongsToFamily`,
`NotificationsService`'s userId-scoping, etc. **These existing checks
are NOT being replaced in this sprint** — they are correct, tested, and
working. `IRbacEngine` is the shape a *future* consolidation would take,
so that when a School's "can a teacher view a student's screen-time
report" question needs answering, there's one engine to extend rather
than N more ad-hoc checks to invent.

`resource` is a free-form dot-scoped string (`"child.screen_time_policy"`,
`"billing.subscription"`) rather than an enum, because the full
resource vocabulary depends on which features School/Company/Bank
editions actually ship with — a product decision, not an architecture
one.

## Policy Engine (`IPolicyEngine`, unimplemented)

Generalizes `ScreenTimePolicy`'s existing versioned-policy-per-owner
pattern one level up, with inheritance: `getEffectivePolicy` walks the
`parentOrganizationId` chain (e.g. a School's default policy, overridable
by an individual Family) until it finds a set value. `ScreenTimePolicy`
itself is unchanged — a future policy engine would *compose with* it
(school default + family override), not replace it.

## Partner Program

A partner is simply **an Organization of any type with `PartnerCampaign`
rows attached** — no separate Partner entity. `PartnerCampaign.type`
covers Referral/Coupon/Trial Extension/Discount/QR Code, with a `config`
Json field (percentage, trial-day count, etc.) left loose by design —
concrete campaign mechanics are a product decision for whoever builds
the partner-facing UI. Critically: **campaigns modify pricing/trial
INPUTS to the existing `SubscriptionService`/`TrialManager`
(Sprint 8), never their business logic.** A `DISCOUNT` campaign would
mean "call `SubscriptionService.subscribe()` with an adjusted
`priceCents`," not a new code path inside `SubscriptionService` itself
— preserving that module's existing, tested behavior.

## White Label

Covered in its own document: `WHITE_LABEL_ARCHITECTURE.md`. Summarized
here because it hangs directly off `Organization.settings`: white-label
branding (logo, color scheme, enabled modules) is data on an
Organization row, not a fork of the codebase.

## What a future sprint would still need to decide before implementing any of this

- Concrete `resource` vocabulary for `IRbacEngine` (needs School/Company/
  Bank feature scoping first — a product decision).
- Whether `OrganizationPolicy.value` needs a JSON-schema-per-key
  validation layer once real policy types exist (today, `ScreenTimePolicy`
  gets this for free from its typed DTO; a generic Json-valued policy
  loses that unless explicitly re-added).
- The actual backfill migration script for the Family→Organization
  convergence path above (a real, carefully-tested migration, not
  written speculatively here).
