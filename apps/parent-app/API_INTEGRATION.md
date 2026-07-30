# Parent App — API Integration Notes

Every endpoint the Parent App calls already exists in the backend
(`docs/release/API_REFERENCE.md`) — no new endpoint was added this sprint.

| Screen | Endpoint(s) used | Notes |
|---|---|---|
| Login | `POST /auth/login` | |
| Register | `POST /auth/register` | Backend already creates a default `Family` row here |
| Create Family | `PATCH /settings` | No separate "create family" endpoint exists — this fills in the name the backend defaulted at registration. `country`/`numberOfChildren` are collected client-side only (not real backend fields) |
| Dashboard Home | `GET /children`, `GET /pairing/devices`, `GET /notifications/unread-count` | Three round-trips, not one aggregate endpoint — see `DashboardApi`'s own docstring for why |
| Add Child | `GET /children`, `POST /pairing/invite` | Uses the CURRENT `PairingModule` endpoint — not the deprecated one the Admin Dashboard was mistakenly calling until a previous session's fix |
| Notifications | `GET /notifications`, `PATCH /notifications/:id/read`, `POST /notifications/read-all` | |
| Settings | (language: client-only) | `GET/PATCH /profile` wired in `SettingsApi` but no screen built yet for it this sprint |
| Logout | `POST /auth/logout` | |

## What's explicitly NOT wired yet

- Reports, Billing/Subscription, Consent/Data Export, Profile edit form —
  all have real, working backend endpoints already (Sprints 1–8) but no
  Parent App screen this sprint. Buttons for these exist in the UI as
  disabled placeholders, not silently missing.
- QR-code pairing (only the numeric-code flow is wired — matches what
  the Admin Dashboard itself does today; QR is a real, separate follow-up).

## Known static-review-only limitation

No Flutter SDK is available in the environment this app was built in.
Every file was checked for brace/parenthesis balance and reviewed
line-by-line against the real, existing API contracts — but
`flutter analyze`, `flutter test`, and `flutter build` have not been run
against this code. This is a real gap, stated plainly, not a completed
verification step.
