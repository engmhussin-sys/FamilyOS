# API Reference — v1

Base path: `/api/v1` for everything except `/health/live` and
`/health/ready`, which are deliberately excluded from the versioned
prefix (infrastructure probes hit a fixed path — see `main.ts`).

Generated from a live scan of every controller and route decorator in
the codebase this session — not hand-written from memory.

## Auth
- `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`
- `POST /auth/devices/pairing/initiate`, `POST /auth/devices/pairing/confirm` — **deprecated**, use `/pairing/*` below

## Children
- `POST /children`, `GET /children`, `GET /children/:childId`, `PATCH /children/:childId`, `DELETE /children/:childId`
- `GET/POST /children/:childId/consents`
- `GET /children/:childId/data-export`
- `GET/POST /children/:childId/screen-time-policy`

## Pairing
- `POST /pairing/invite`, `POST /pairing/accept`, `POST /pairing/device/register`
- `POST /pairing/verify`, `POST /pairing/activate`, `POST /pairing/reject`, `POST /pairing/revoke`
- `GET /pairing/device/:deviceId/status`, `GET /pairing/device/:deviceId/timeline`
- `POST /pairing/device/heartbeat`, `POST /pairing/device/capabilities`, `GET /pairing/device/policy`
- `GET /pairing/devices`, `GET /pairing/alerts`

## AI Core
- `GET /ai-core/device-health/:deviceId`
- `GET /ai-core/recommendation/:childId?deviceId=`
- `GET /ai-core/behavioral-trend/:childId?deviceId=`
- `GET /ai-core/decision-history/:childId`
- `GET /ai-core/insights/:childId?deviceId=`

## AI Assistant
- `POST /ai-assistant/ask`

## Notifications
- `GET /notifications`, `GET /notifications/unread-count`
- `PATCH /notifications/:id/read`, `POST /notifications/read-all`

## Billing
- `GET /billing/plans`, `GET /billing/subscription`
- `POST /billing/trial/start`, `POST /billing/subscribe`, `POST /billing/cancel`
- `GET /billing/history`

## Feature Flags
- `GET /feature-flags`, `GET /feature-flags/:key`

## Profile / Settings
- `GET/PATCH /profile`
- `GET/PATCH /settings`

## Reports / Search / Analytics
- `GET /reports/:childId?deviceId=&format=json|csv`
- `GET /search?q=`
- `POST /analytics/track`, `GET /analytics/dashboard-metrics`

## System / Health (no auth required, deliberately)
- `GET /health/live`, `GET /health/ready`
- `GET /system/readiness`, `GET /system/diagnostics`
- `GET /system/retention-policy`

## Authentication

Every endpoint above except `/auth/*`, `/health/*`, and the three
`/system/*` reads requires `Authorization: Bearer <accessToken>`.

## Rate limits

Global default: 100 requests/minute per instance. Stricter overrides on
`/auth/login`, `/pairing/invite`, `/pairing/accept`,
`/ai-core/recommendation/:childId` — see each controller's `@Throttle()`
decorator for the exact limit.
