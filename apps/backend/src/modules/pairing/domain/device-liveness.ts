/**
 * ===========================================================================
 * WHEN HAS A DEVICE STOPPED REPORTING? — the pure rule, so it can be argued.
 * ===========================================================================
 *
 * `HEARTBEAT_MISSED` has existed in `PairingEventType` and in the transition
 * table (`HEALTHY -> DEGRADED`) since pairing was built, and NOTHING IN `src/`
 * HAS EVER PRODUCED IT. Measured, not assumed: the only three occurrences of
 * the string in the backend are its enum member, its transition row and its
 * type. So no device in this product has ever left `HEALTHY`, and «the app
 * stopped reporting on my son's phone» — the single most common support
 * sentence a parental-control product receives — had no state to point at.
 *
 * Six other events are in the same condition (`DEVICE_SUSPENDED`,
 * `DEVICE_REACTIVATED`, `DEVICE_REMOVED`, `PAIRING_EXPIRED`,
 * `AUTHENTICATION_FAILED`, `DEVICE_VERIFICATION_FAILED`). This file closes one
 * of the seven and claims nothing about the others.
 *
 * ── WHY THE THRESHOLD IS TWENTY-FOUR HOURS AND NOT TWO MINUTES ─────────
 *
 * The child app heartbeats every THIRTY SECONDS (`heartbeat_service.dart`,
 * `Duration(seconds: 30)`), so a threshold could in principle be minutes. It
 * must not be, and the reason is that a phone is not a server:
 *
 *   IT IS OFF AT NIGHT. A child's phone is switched off, or flat, for eight
 *   hours at a stretch. Any threshold shorter than a night marks EVERY device
 *   degraded EVERY morning, which is not a signal, it is a rooster.
 *   ANDROID DOZE suspends background work for long, unpredictable windows even
 *   while the phone is on.
 *   TRAVEL, flight mode and a day at a school with no signal are ordinary.
 *
 * Twenty-four hours spans all of those and still answers the support question
 * within the same day it is asked. A device that has missed roughly 2,880
 * consecutive heartbeats is not dozing.
 *
 * ── THE PROPERTY THAT MAKES THIS SAFE TO RUN HOURLY ────────────────────
 *
 * `HEARTBEAT_MISSED` is legal ONLY from `HEALTHY`. So the FIRST sweep after a
 * device goes quiet writes one event and moves it to `DEGRADED`, and every
 * sweep after that finds an illegal transition and does nothing. One row per
 * outage, not one row per hour per device — the write volume is bounded by the
 * number of outages, which is the number a human would want to read anyway.
 *
 * And the way back is already built and already runs: `recordHeartbeat`
 * transitions `DEGRADED -> HEALTHY` on the next beat. This sweep therefore
 * never needs a «recovered» pass of its own, and deliberately does not have
 * one — two writers for one state is how two writers disagree.
 *
 * ── PARENT DEVICES ARE EXCLUDED, AND THAT IS NOT AN OVERSIGHT ──────────
 *
 * Only the child app calls `POST /pairing/device/heartbeat`. A parent device
 * row gets its `last_seen_at` touched when a push token is registered and never
 * again, so under any threshold EVERY parent device is permanently stale.
 * Including them would mean a sweep whose findings are 100% false positives on
 * the day it ships. The query below is scoped to `owner_type = 'CHILD'` for
 * that reason and for no other.
 */

/**
 * How long a device may be silent before it is called DEGRADED.
 * Exported so the test asserts the same number the job uses, and so the
 * argument above has something to point at.
 */
export const DEVICE_STALE_AFTER_HOURS = 24;

/** How many devices one sweep will transition. Bounded like every other sweep:
 * an unbounded loop inside one tick outlives its own lease and gets stolen. */
export const DEVICE_LIVENESS_BATCH_SIZE = 500;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * The instant before which a heartbeat is too old to count.
 *
 * A pure function of `now` — no clock read inside — which is what lets
 * `device-liveness.spec.ts` prove the boundary without a database, a fake timer
 * or a network, exactly as `job-schedule.spec.ts` does for the scheduler.
 */
export function staleCutoff(now: Date, hours: number = DEVICE_STALE_AFTER_HOURS): Date {
  return new Date(now.getTime() - hours * MS_PER_HOUR);
}

/**
 * True when a device's last heartbeat is old enough to call it degraded.
 *
 * `null` IS NOT STALE, and that is a deliberate answer rather than a missing
 * branch. A device that has never sent a heartbeat has never been `HEALTHY`,
 * so `HEARTBEAT_MISSED` would be an illegal transition for it anyway; treating
 * it as stale here would only produce a refusal downstream and an entry in the
 * skip count that means something different from every other entry in it.
 *
 * The boundary is EXCLUSIVE — exactly `hours` old is not yet stale — so a
 * device beating on a perfectly regular schedule at the threshold is never
 * flagged by a sweep that happens to run a microsecond late.
 */
export function isStale(lastSeenAt: Date | null, now: Date, hours: number = DEVICE_STALE_AFTER_HOURS): boolean {
  if (lastSeenAt === null) return false;
  return lastSeenAt.getTime() < staleCutoff(now, hours).getTime();
}
