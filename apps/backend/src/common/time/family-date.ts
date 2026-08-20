/**
 * THE FAMILY BUSINESS DATE — ONE IMPLEMENTATION, FOR THE WHOLE BACKEND.
 *
 * Before B1+B2 the backend had TWENTY separate answers to the question "which
 * calendar day is it?", spread over fifteen files, and every one of them was
 * wrong in one of two different ways:
 *
 *   1. THE UTC CLASS (14 sites) — `new Date().toISOString().slice(0, 10)` and
 *      `Date.UTC(now.getUTCFullYear(), ...)`. A child in Cairo who finishes a
 *      habit at 00:30 local was recorded on YESTERDAY. Three hours of every
 *      day — 12.5% — landed on the wrong day in both launch markets.
 *   2. THE SERVER-LOCAL CLASS (3 sites) — `now.getHours()` / `setHours(0,0,0,0)`
 *      in quiet hours and the daily notification caps. Those read the CONTAINER's
 *      timezone, which is neither UTC nor the family's, and which changes
 *      silently when the deployment host changes. A behaviour that depends on an
 *      undocumented, unpinned environment variable is not a behaviour.
 *
 * Both are replaced by the functions below, and by nothing else. The rule:
 *
 *   A "DAY" IS A PROPERTY OF THE FAMILY, NOT OF THE SERVER AND NOT OF THE
 *   DEVICE. It is derived from `Family.timezone` (schema.prisma:321) and a
 *   server-validated instant. Nothing else is an input.
 *
 * WHY `Intl` AND NOT `luxon` / `date-fns-tz`. No dependency was added. Node 22
 * in this image is built with FULL ICU (`process.config.variables.icu_small ===
 * false`, 418 IANA zones exposed through `Intl.supportedValuesOf('timeZone')`),
 * so `Intl.DateTimeFormat` IS the tz database — the same tzdata that `luxon`
 * would have read through the same `Intl` API. Adding a library would have
 * bought a nicer surface and a second copy of the rules to keep in sync. It is
 * one production dependency avoided in a codebase that has 20 of them.
 *
 * DST IS DERIVED, NEVER ASSUMED. Every offset below is read from tzdata at the
 * instant in question. There is no `UTC+2`, no `UTC+3`, no offset constant in
 * this file. That matters concretely: Egypt REINTRODUCED DST in 2023, and this
 * runtime's tzdata confirms it for 2026 (Africa/Cairo is GMT+02:00 in January
 * and GMT+03:00 in August — measured, not remembered). Saudi Arabia has no DST
 * (Asia/Riyadh is GMT+03:00 year-round — also measured). A hardcoded offset
 * would be wrong twice a year in the first launch market.
 *
 * THE TWO PATHOLOGICAL DAYS ARE HANDLED BY CONSTRUCTION, not by a special case:
 *   - the 23-hour day (spring forward). Egypt's spring transition happens AT
 *     MIDNIGHT — local 00:00 jumps to 01:00 — so on that date the business day
 *     literally has no 00:00. `getStartOfBusinessDay` returns the transition
 *     instant (local 01:00), which is the first moment of that calendar day.
 *   - the 25-hour day (fall back), where a local wall-clock time occurs twice.
 *     Two completions inside the repeated hour resolve to the SAME business
 *     date, because the date is read from the instant, not reconstructed from
 *     wall-clock arithmetic.
 *
 * AND DAY ARITHMETIC NEVER SUBTRACTS 86,400 SECONDS. `addBusinessDays` walks
 * the CALENDAR (`YYYY-MM-DD` -> `YYYY-MM-DD`), so "yesterday" is yesterday even
 * when yesterday was 23 or 25 hours long. The previous `streak-calculator`
 * stepped back with `setUTCDate(-1)` on a `Date`; that is the exact construct
 * that breaks on a DST boundary.
 */

/** `YYYY-MM-DD` in the family's timezone. The only date type this codebase
 * should pass around for business decisions. */
export type BusinessDate = string;

/** Schema default (`Family.timezone @default("UTC")`). Also the fallback when a
 * stored value fails validation — a wrong-but-known calendar beats a crash on a
 * reward path. */
export const DEFAULT_FAMILY_TIMEZONE = 'UTC';

const BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `Intl.DateTimeFormat` construction is expensive; the zone set is tiny. */
const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  // `hourCycle: 'h23'` still renders midnight as "24" in some ICU versions.
  const hour = read('hour') % 24;
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour,
    minute: read('minute'),
    second: read('second'),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * A real IANA zone name, and nothing else.
 *
 * `Intl.DateTimeFormat` also accepts a raw offset (`"+03:00"`), and accepting
 * one here would let a family pin itself to a fixed offset and silently opt out
 * of DST — precisely the failure mode this whole file exists to prevent. Offset
 * forms are therefore rejected explicitly, before `Intl` ever sees them.
 */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string') return false;
  const value = timeZone.trim();
  if (value.length === 0 || value.length > 64) return false;
  // A fixed offset ("+03:00", "-0500", "03:00") is not a timezone.
  if (/^[+\-0-9]/.test(value)) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The canonical spelling ICU resolves a zone to (`"egypt"` -> `"Africa/Cairo"`),
 * so what is written to `Family.timezone` is what tzdata will look up later.
 */
export function canonicalTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() }).resolvedOptions().timeZone;
}

/** Never throws. An invalid or absent stored value degrades to UTC. */
export function resolveTimeZone(timeZone: string | null | undefined): string {
  return isValidTimeZone(timeZone) ? canonicalTimeZone(timeZone) : DEFAULT_FAMILY_TIMEZONE;
}

export function isBusinessDate(value: unknown): value is BusinessDate {
  return typeof value === 'string' && BUSINESS_DATE_RE.test(value);
}

function toInstant(value: Date | string | number): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  // A bare `YYYY-MM-DD` is a DAY, not an instant; anchor it at UTC midnight so
  // `new Date('2026-08-16')` and `new Date('2026-08-16T00:00:00Z')` agree.
  return new Date(BUSINESS_DATE_RE.test(value) ? `${value}T00:00:00.000Z` : value);
}

/**
 * THE FUNCTION EVERYTHING ELSE IS BUILT ON. Which calendar day this instant
 * falls on, for this family.
 */
export function getBusinessDate(instant: Date | string | number, timeZone: string): BusinessDate {
  const tz = resolveTimeZone(timeZone);
  const at = toInstant(instant);
  if (Number.isNaN(at.getTime())) {
    throw new RangeError('getBusinessDate received an invalid instant.');
  }
  const p = zonedParts(at, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Local wall-clock `HH:MM`, 24h — what quiet hours are actually compared against. */
export function getBusinessTimeHHMM(instant: Date | string | number, timeZone: string): string {
  const p = zonedParts(toInstant(instant), resolveTimeZone(timeZone));
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Offset of `timeZone` at this instant, in ms east of UTC. Read from tzdata. */
export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
  // `instant` carries sub-second precision the formatter dropped.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant of a local wall-clock time. Two passes, because the offset
 * depends on the answer: guess with the offset at the naive instant, then
 * re-evaluate with the offset at the guess. That is what makes the boundary
 * days correct rather than approximately correct.
 */
function zonedWallClockToUtc(
  date: BusinessDate,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string,
): Date {
  const [y, m, d] = date.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, hour, minute, second, ms);
  const firstOffset = timeZoneOffsetMs(new Date(naive), timeZone);
  let ts = naive - firstOffset;
  const secondOffset = timeZoneOffsetMs(new Date(ts), timeZone);
  if (secondOffset !== firstOffset) ts = naive - secondOffset;
  return new Date(ts);
}

/**
 * The first instant of a family's calendar day.
 *
 * On a spring-forward date whose transition is at midnight (Egypt's is), local
 * 00:00 does not exist; the two-pass resolution lands on the transition instant
 * itself, which IS the first moment of that day. The post-check below makes
 * that explicit rather than incidental: if the resolved instant reads as the
 * PREVIOUS day, walk forward to the true start.
 */
export function getStartOfBusinessDay(
  dateOrInstant: Date | string | number,
  timeZone: string,
): Date {
  const tz = resolveTimeZone(timeZone);
  const date = isBusinessDate(dateOrInstant) ? dateOrInstant : getBusinessDate(dateOrInstant, tz);
  let start = zonedWallClockToUtc(date, 0, 0, 0, 0, tz);

  if (getBusinessDate(start, tz) < date) {
    // The requested midnight fell inside a spring-forward gap. The day begins
    // at the transition; find it by stepping forward in minutes from the gap.
    for (let i = 1; i <= 24 * 60; i++) {
      const candidate = new Date(start.getTime() + i * 60_000);
      if (getBusinessDate(candidate, tz) === date) {
        start = candidate;
        break;
      }
    }
  }
  return start;
}

/**
 * The instant the NEXT business day starts — the exclusive upper bound to use
 * in a `gte`/`lt` range query. Exposed alongside `getEndOfBusinessDay` because
 * a half-open range is the correct thing for a database and an inclusive last
 * millisecond is the correct thing for a human-facing comparison.
 */
export function getBusinessDayEndExclusive(
  dateOrInstant: Date | string | number,
  timeZone: string,
): Date {
  const tz = resolveTimeZone(timeZone);
  const date = isBusinessDate(dateOrInstant) ? dateOrInstant : getBusinessDate(dateOrInstant, tz);
  return getStartOfBusinessDay(addBusinessDays(date, 1), tz);
}

/** The LAST instant of a family's calendar day (inclusive). */
export function getEndOfBusinessDay(
  dateOrInstant: Date | string | number,
  timeZone: string,
): Date {
  return new Date(getBusinessDayEndExclusive(dateOrInstant, timeZone).getTime() - 1);
}

/** `{ start, endExclusive }` — the half-open range for a day's rows. */
export function getBusinessDayRange(
  dateOrInstant: Date | string | number,
  timeZone: string,
): { start: Date; endExclusive: Date } {
  return {
    start: getStartOfBusinessDay(dateOrInstant, timeZone),
    endExclusive: getBusinessDayEndExclusive(dateOrInstant, timeZone),
  };
}

export function isSameBusinessDay(
  a: Date | string | number,
  b: Date | string | number,
  timeZone: string,
): boolean {
  const tz = resolveTimeZone(timeZone);
  return getBusinessDate(a, tz) === getBusinessDate(b, tz);
}

/**
 * CALENDAR arithmetic on `YYYY-MM-DD`. Deliberately timezone-free: adding a day
 * to a date is a calendar operation, and doing it by adding 86,400,000 ms to an
 * instant is what breaks streaks across a DST boundary.
 */
export function addBusinessDays(date: BusinessDate, days: number): BusinessDate {
  if (!isBusinessDate(date)) throw new RangeError(`addBusinessDays expected YYYY-MM-DD, got "${date}".`);
  const [y, m, d] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

/** The business date `days` calendar days before `instant`'s business date. */
export function businessDateDaysAgo(
  instant: Date | string | number,
  days: number,
  timeZone: string,
): BusinessDate {
  return addBusinessDays(getBusinessDate(instant, timeZone), -days);
}

/**
 * PHASE D (`PC-D-005`) — THE INSTANT AT WHICH A FAMILY'S WALL CLOCK NEXT READS
 * `HH:MM`, STRICTLY AFTER `now`.
 *
 * This is the deferral schedule in one function: a notification blocked by
 * quiet hours is released the next time the family's own clock reaches
 * `quietHoursEnd`. It is expressed here, in the ONE file that owns the family
 * calendar, rather than in the notification service, because every way of
 * writing it inline is wrong in a way this file already solved:
 *
 *   `now + 9h`                 — assumes today's offset holds for nine hours.
 *                                Across a spring-forward it releases an hour
 *                                late; across a fall-back an hour early.
 *   `setHours(7,0,0,0)`        — the CONTAINER's clock. The exact defect B2
 *                                removed from quiet hours in the first place.
 *   `startOfDay + 7h`          — 07:00 local is not «midnight plus seven hours»
 *                                on a 23-hour day, because in Africa/Cairo that
 *                                day has no 00:00 at all.
 *
 * It is built from `zonedWallClockToUtc`, which resolves the offset AT THE
 * TARGET INSTANT in two passes, so all three cases fall out instead of being
 * handled. The candidate day is advanced (never rewound) until the resolved
 * instant is strictly later than `now`; the loop is bounded at three days,
 * which is more than any DST anomaly can consume and which makes an
 * unterminating search impossible by construction rather than by argument.
 *
 * THE SPRING-FORWARD GAP is the one case that needs a decision rather than a
 * derivation: if a family's quiet hours ended at 00:30 and that local time does
 * not exist on the transition date, `zonedWallClockToUtc` lands on an instant
 * whose local time is AFTER the requested one (the clock jumped over it). That
 * is accepted deliberately — releasing at 01:00 on a day that had no 00:30 is
 * the only answer that exists, and it errs later rather than earlier, which is
 * the safe direction for a quiet-hours boundary.
 */
export function nextLocalTimeAfter(
  now: Date | string | number,
  hhmm: string,
  timeZone: string,
): Date {
  const tz = resolveTimeZone(timeZone);
  const at = toInstant(now);
  if (Number.isNaN(at.getTime())) {
    throw new RangeError('nextLocalTimeAfter received an invalid instant.');
  }
  const [hourRaw, minuteRaw] = hhmm.split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new RangeError(`nextLocalTimeAfter expected HH:MM, got "${hhmm}".`);
  }

  let date = getBusinessDate(at, tz);
  for (let i = 0; i <= 3; i++) {
    const candidate = zonedWallClockToUtc(date, hour, minute, 0, 0, tz);
    if (candidate.getTime() > at.getTime()) return candidate;
    date = addBusinessDays(date, 1);
  }
  // Unreachable: three calendar days always contain a later occurrence of any
  // wall-clock time. It throws rather than returning a guess, because a silent
  // wrong instant here is a notification delivered at the wrong hour forever.
  throw new RangeError(
    `nextLocalTimeAfter could not resolve ${hhmm} in ${tz} after ${at.toISOString()}.`,
  );
}

/** 0 = Sunday .. 6 = Saturday, on the family's calendar. */
export function getBusinessDayOfWeek(
  dateOrInstant: Date | string | number,
  timeZone: string,
): number {
  const date = isBusinessDate(dateOrInstant)
    ? dateOrInstant
    : getBusinessDate(dateOrInstant, timeZone);
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Whole years, floored, on the family's calendar. `Child.dateOfBirth` is
 * `@db.Date` — a DAY, with no instant behind it — so it is compared as a day
 * string, never as a timestamp.
 */
export function businessAgeInYears(
  dateOfBirth: Date | string,
  asOf: Date | string | number,
  timeZone: string,
): number {
  const dob =
    typeof dateOfBirth === 'string' && isBusinessDate(dateOfBirth)
      ? dateOfBirth
      : new Date(dateOfBirth).toISOString().slice(0, 10);
  const today = isBusinessDate(asOf) ? asOf : getBusinessDate(asOf, timeZone);

  const [by, bm, bd] = dob.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);

  let years = ty - by;
  if (tm < bm || (tm === bm && td < bd)) years -= 1;
  return Math.max(0, years);
}
