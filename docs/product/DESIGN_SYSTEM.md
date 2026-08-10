# Ebni Design System — "Quiet Guardian"

**CLOSES A REAL GAP** identified in the Master Completeness Audit:
zero consolidated design system document existed — colors/typography
were scattered across `AppTheme` (Parent App), `KidTheme` (Child App),
and `tailwind.config` (Dashboard), each maintained independently.
Every value below is extracted directly from the real, currently
running code — none invented for this document.

## 🚨 Real inconsistency discovered while writing this document

**The same semantic name (`guardian950`) resolves to two genuinely
different colors across platforms:**

| Platform | `guardian950` value | Source |
|---|---|---|
| Parent App (Flutter) | `#14213D` (deep navy) | `apps/parent-app/lib/core/theme/app_theme.dart` |
| Admin Dashboard (React) | `#0F1E1B` (deep forest green) | `apps/admin-dashboard/tailwind.config.*` |

This is a real brand inconsistency, not a documentation gap — a
parent using both the mobile app and the web dashboard is currently
looking at two different "primary" colors under the same name. This
document does NOT resolve which one is "correct" (a real product/brand
decision, not an engineering one) — it states the discrepancy plainly
so it can be resolved deliberately rather than discovered by accident
later.

## Parent App palette ("Quiet Guardian" — trust through restraint)

| Token | Hex | Usage |
|---|---|---|
| guardian950 | #14213D | Primary text/brand (light mode) |
| sand50 | #FAF7F2 | Background |
| sage500 | #6B8F71 | Success/positive actions |
| amber500 | #E0A458 | Warnings |
| brick500 | #C1502E | Errors/destructive actions |

**Typography:** Inter (via google_fonts), not Flutter's Material
default — a deliberate choice documented in app_theme.dart itself:
"real typography... a consistent rounded-but-not-playful shape
language (14px)... A parent-facing tool earns trust through polish
and restraint."

**Shape language:** 14px card radius, 12px button radius —
deliberately more restrained than the Child App (see below), per
that same source comment: "the two apps should never look like the
same design system wearing different colors."

## Child App palette ("Sparky" — bright, playful, kid-safe)

| Token | Hex | Usage |
|---|---|---|
| sunshineYellow | #FFC93C | Accent/rewards |
| skyBlue | #4EA5F5 | Primary actions |
| leafGreen | #5FD68A | Success/completion |
| berryPurple | #9B6BEC | Accent |
| coral | #FF7A6B | Playful accent/errors |
| cloudWhite | #FFFDF8 | Background |
| softInk | #3A3654 | Primary text |
| mutedInk | #8A86A0 | Secondary text |

Source: apps/child-app/lib/core/theme/kid_theme.dart. Deliberately
brighter and more playful than the Parent App — a conscious design
decision, not an inconsistency in the same category as the
guardian950 conflict.

## Admin Dashboard palette (React/Tailwind)

| Token | Hex | Usage |
|---|---|---|
| ink (DEFAULT) | #1B2422 | Primary text |
| ink-soft | #3A453F | Secondary text |
| guardian-950 | #0F1E1B | Darkest brand shade — see inconsistency above |
| guardian-900 | #16302C | |
| guardian-700 | #234A42 | |
| guardian-500 | #3D6D61 | |
| sage-600/500/400/100 | #5B7955 / #6F8F6A / #8FAB89 / #E4EBE1 | Success scale |
| amber-600/500/100 | #B98527 / #D9A441 / #F7ECD2 | Warning scale |
| brick-600/500/100 | #8F3B31 / #B54B3F / #F3DEDA | Error/danger scale — close to Parent App's brick500 but not identical (#C1502E vs #B54B3F) |
| sand-50/100/200 | #F3F4EF / #EAEBE2 / #DCDED2 | Background scale |

Source: apps/admin-dashboard/tailwind.config.*.

## What this document does NOT include (real gaps, not filled here)

- **A real EBNI logo file** — no image asset exists anywhere in this
  repository. Every reference to "Ebni" in UI is text-only.
  Commissioning/designing an actual logo is a real design task, not
  attempted here.
- **Resolution of the guardian950 conflict above** — a product
  decision (which value is canonical), not made unilaterally by this
  document.
- **Accessibility contrast ratios** — not computed here; see the
  separate accessibility review for what WAS checked this session.
- **Spacing/elevation scale** — exists in code (_cardRadius, shadow
  treatments in app_theme.dart) but wasn't consolidated into a formal
  token scale here; a real follow-up once more screens exist to
  establish the real recurring patterns from.
