# Architecture Notes — Admin Dashboard

**Location:** `apps/admin-dashboard/`
**Stack:** React 18 + TypeScript + Vite, TanStack Query (server state), Zustand (auth session state), React Router, Tailwind CSS.
**Consumes:** `apps/backend`'s Auth module (`/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/devices/pairing/initiate`) — no backend changes were needed for this step.

---

## 1. Scope of this step

Register → auto-login → protected dashboard shell → Device Pairing card
(the one feature whose backend API already exists). Children/Screen-Time/
Reports UI are deliberately **not** built yet — there's no backend API for
them, and inventing screens against imaginary endpoints would need to be
rebuilt once `ChildrenModule` ships. The dashboard shows an honest
"coming soon" placeholder there instead.

## 2. Layering (mirrors the backend's feature-first convention)

```
shared/
  components/    Design-system primitives (Button, Input, Card, GuardianRing)
  lib/             tokenStorage (session persistence) + httpClient (fetch + refresh interceptor)
  types/            Hand-written types mirroring backend response shapes
features/
  auth/
    api/            authApi.ts — the only place that knows the exact routes
    store/           authStore.ts — Zustand, thin reactive wrapper over tokenStorage
    pages/            LoginPage, RegisterPage
  pairing/
    api/, components/  PairingCard — calls the real initiate endpoint
  dashboard/
    components/, pages/ DashboardShell (layout), DashboardHomePage
app/
  App.tsx           Router + QueryClientProvider wiring
  ProtectedRoute.tsx  Redirects guests to /login, preserves intended destination
```

**Why `tokenStorage` is its own module, not inside the Zustand store:**
`httpClient` needs to read/write tokens during a 401-retry cycle, and
`authStore`'s actions call `authApi` (which calls `httpClient`). Putting
token state inside the Zustand store would create a circular import
(`httpClient → authStore → authApi → httpClient`). `tokenStorage` is the
single source of truth both layers depend on; `authStore` is a thin
reactive mirror of it for React components to subscribe to. This is the
same dependency-inversion instinct as the backend's repository ports —
just applied to break a frontend-specific cycle instead of swapping ORMs.

## 3. Security: the refresh-token storage tradeoff (read before deploying)

The backend's `/auth/login` and `/auth/refresh` return the refresh token in
the JSON response body — a design that's correct for the mobile apps (which
have OS-level secure storage) but is a real tradeoff for a browser SPA:

- **Access token:** kept in memory only (a module-level variable in
  `tokenStorage.ts`), never persisted. This is the highest-value token to
  keep out of `localStorage`/`sessionStorage`, since it's what an
  XSS payload would actually use to call the API.
- **Refresh token:** stored in `sessionStorage` (cleared when the tab
  closes) rather than `localStorage` (persists indefinitely). This is a
  **mitigation, not a fix** — `sessionStorage` is still readable by any
  script running on the page, i.e. still vulnerable to XSS, just for a
  shorter window and not across browser restarts.

**Recommended production hardening (backend follow-up, not done here):**
add a web-specific variant of `/auth/login` and `/auth/refresh` that sets
the refresh token as an `httpOnly; Secure; SameSite=Strict` cookie instead
of returning it in the JSON body, and have the frontend stop reading/storing
it entirely — the browser would send it automatically and no JavaScript
(malicious or otherwise) could ever read it. This is intentionally **not**
implemented yet because it changes the backend's auth contract for web
clients specifically and deserves its own reviewed step, not a silent
change bundled into a frontend task.

## 4. Visual identity — "Quiet Guardian"

Token system lives in `tailwind.config.js` (comments there explain the
reasoning) and `src/index.css`. Summary:

| Role | Token | Hex | Why |
|---|---|---|---|
| Primary surface / sidebar | `guardian-900` | `#16302C` | Deep teal-ink — calm authority, not clinical black |
| Background | `sand-50` | `#F3F4EF` | Warm off-white with a green undertone — distinct from the generic cream+terracotta AI-SaaS default |
| Primary accent | `sage-500` | `#6F8F6A` | Growth/safety association, used for focus rings & positive states |
| Highlight/CTA | `amber-500` | `#D9A441` | Sparse use only — links, active states |
| Alert (real risk only) | `brick-500` | `#B54B3F` | Muted, desaturated — reserved for actual danger states, never decoration |

**Signature element:** `GuardianRing` — a single recurring ring motif (SVG,
`shared/components/GuardianRing.tsx`) used as (a) a calm brand mark on the
login page and (b) a live countdown indicator for pairing-code expiry. It
is deliberately used in exactly these two places, not sprinkled everywhere,
per the design brief's "spend your boldness in one place" principle.

**Typography:** Fraunces (display/headings) + Inter (body/UI) + IBM Plex
Mono (data — the pairing code, specifically, since it's the one piece of
literal data-to-be-typed-elsewhere in this MVP).

## 5. Known follow-ups

1. **Refresh-token storage hardening** — see §3.
2. **`PairingCard`'s `childId` field is a manual text input**, not a
   dropdown — there is no Children API yet to populate one from. Clearly
   labeled in the UI and code (`TODO(follow-up)` comment in
   `PairingCard.tsx`) as temporary, not silently shipped as if final.
3. **No `/auth/me` endpoint on the backend.** The dashboard currently
   restores the user's profile (name/email/role) from a `sessionStorage`
   cache written at login time, rather than re-fetching it fresh after a
   token refresh. This is fine for display purposes at MVP scale but should
   be replaced with a real `GET /auth/me` call once that endpoint exists.
4. **i18n/RTL is currently hardcoded** (`<html lang="ar" dir="rtl">`) rather
   than switchable, even though the base project requirements call for both
   LTR and RTL. Introducing `react-i18next` (or similar) is scoped as its
   own follow-up rather than bolted on here.
5. **No Children/Screen-Time/Reports UI yet** — see §1.

## 6. Verification performed in this session

- `npx tsc --noEmit` → 0 errors.
- `npx vitest run` → **10/10 tests passed** (httpClient refresh-interceptor:
  auth header injection, single-refresh-then-retry on 401, session-expired
  event emission on refresh failure, non-401 errors bypass refresh entirely;
  authStore: guest-by-default, login success/failure, register-then-login
  orchestration, logout clears session even when the server call fails).
- `npx vite build` → succeeded, produced a working production bundle
  (`dist/`, ~68 KB gzipped JS).
