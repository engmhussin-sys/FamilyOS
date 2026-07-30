# White Label Architecture (FamilyOS)

**Status:** Architecture direction adopted. **No implementation.**

## The core constraint: Configuration, not Fork

Family/School/Corporate/Banking "editions" must be **one codebase, one
deployment artifact, configured differently per `Organization`** — never
a forked/duplicated copy of the Dashboard or backend per edition. This
is the same discipline this codebase already applies everywhere else
(one `PairingModule`, one `AiCoreModule` regardless of who's using
them) — White Label is that same principle applied to branding and
feature scoping.

## What varies per edition, and where it lives

| Varies | Mechanism | Status |
|---|---|---|
| Branding (logo, color scheme, product name shown to users) | `Organization.settings` (Json, already in the additive schema) | Schema exists, unused |
| Which feature modules are visible | `FeatureFlagService` (Sprint 8, real and working today) — `enabledFamilyIds` would generalize to `enabledOrganizationIds` in a future pass | Mechanism already exists; not yet organization-aware |
| Terminology (e.g. "Child" vs. "Student" vs. "Employee") | A future i18n resource *namespace* per organization type, reusing the localization engine (`localizationEngine.ts`, Sprint 8) — NOT a new i18n system | Localization infrastructure exists; org-aware terminology namespacing does not |
| Pricing/plan structure per edition | `PlanDefinition` (Sprint 8, real) — already keyed by tier, would gain an `organizationType` scoping dimension | Billing infrastructure exists; not yet organization-type-aware |

## Why this is a config-time decision, not a runtime one

The Dashboard (React) already has every architectural piece a white-label
system needs, un-generalized:
- `ConfigurationService` (Sprint 9) reads structured config at boot —
  the same shape a white-label branding loader would take.
- `LocaleProvider` (Sprint 8) already resolves a value (a translation)
  based on a runtime-selected key — the identical mechanism a
  `useOrganizationBranding()` hook would use for a logo URL or product
  name instead of a translated string.

No new frontend architecture is needed — extending these two existing,
working mechanisms to also key off `Organization.settings` is the
entire implementation surface, once the Organization Platform migration
(see `ORGANIZATION_PLATFORM_ARCHITECTURE.md`) makes `Organization` a
real, populated table.

## What this explicitly does NOT mean

- **Not a separate build per edition.** No `banking-edition` branch, no
  separate CI job per edition, no separate app-store listing per
  edition (unless a specific enterprise contract requires a dedicated
  listing, which is a business/legal decision outside this document's
  scope).
- **Not a theming engine with arbitrary CSS override.** Branding is a
  bounded, named set of fields (logo, primary color, product name) —
  exactly as loose as `Organization.settings: Json` allows, not
  infinitely customizable, to avoid the support burden of an
  unbounded theming surface.

## What a future "implement White Label" sprint would need to scope

- The concrete, bounded set of `Organization.settings` fields (a
  product decision: which visual/textual elements are actually
  configurable vs. fixed).
- Whether `FeatureFlagService` and `PlanDefinition` gain
  `organizationType`-awareness in the same pass, or as separate,
  smaller changes (an implementation-sequencing decision, not an
  architectural one — the shapes described above already accommodate
  either order).
