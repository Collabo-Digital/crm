/**
 * Timezone-aware date helpers for statutory (GST) date math.
 *
 * Every deployment target runs UTC — no `TZ` is set in the root Dockerfile,
 * server/Dockerfile, render.yaml, railway.json or either docker-compose file,
 * and node:20-alpine ships without tzdata. So `Date#getMonth()` /
 * `getFullYear()` and `new Date(y, m, d)` answer in UTC, not in the merchant's
 * timezone. For an IST (+05:30) merchant that shifts every financial-year and
 * GST-period boundary by 5.5 hours: a sale at 00:30 IST on 1 April is
 * 2025-03-31T19:00Z, so naive math files it in the PREVIOUS financial year and
 * consumes a serial from that year's sequence.
 *
 * `Organization.timezone` already exists (default "UTC", the UI offers
 * Asia/Kolkata) — these helpers are what make it load-bearing.
 */

/** GST is an Indian tax regime, so its statutory calendar is IST. */
export const INDIA_TZ = 'Asia/Kolkata';

export interface ZonedParts {
  year: number;
  /** 1-12, unlike Date#getMonth(). */
  month: number;
  day: number;
}

/**
 * Timezone to use for an organization's GST date math.
 *
 * `Organization.timezone` defaults to `"UTC"` and most merchants never change
 * it, which left the timezone-aware financial-year and period logic reading UTC
 * and therefore behaving exactly as the bug it replaced. Every GST feature here
 * is India-specific — GSTIN, CGST/SGST/IGST, Indian state codes, an April–March
 * year — so "GST enabled with an untouched UTC timezone" is a misconfiguration,
 * not a deliberate choice, and IST is the only meaningful reading.
 *
 * An explicitly-set non-UTC timezone always wins. Non-GST organizations are
 * untouched.
 *
 * TOTAL BY DESIGN: an unparseable stored timezone is ignored rather than
 * propagated. `Organization.timezone` was a bare `@IsString()` until now, so
 * rows holding garbage already exist; every one of them would otherwise throw
 * `RangeError` out of `Intl` on EVERY GST path — returns, stats, invoice
 * creation — and validating the DTO fixes only writes from here on, not the
 * rows already stored. Falling through to the same IST/UTC choice an unset
 * timezone gets keeps those organizations working while the warning makes the
 * misconfiguration visible.
 */
const badTimeZoneWarned = new Set<string>();

export function resolveGstTimeZone(org: {
  timezone?: string | null;
  gstEnabled?: boolean | null;
}): string {
  const configured = org.timezone?.trim();

  if (configured && configured !== 'UTC') {
    if (isValidTimeZone(configured)) return configured;

    if (!badTimeZoneWarned.has(configured)) {
      badTimeZoneWarned.add(configured);
      console.warn(
        `[gst] Ignoring unrecognised organization timezone "${configured}" — ` +
          `falling back to ${org.gstEnabled ? INDIA_TZ : 'UTC'} for GST date math. ` +
          `Set a valid IANA timezone in Settings.`,
      );
    }
  }

  if (org.gstEnabled) return INDIA_TZ;

  return 'UTC';
}

/**
 * Timezone that reporting windows are cut in — what "today" and "last 7 days"
 * mean on the dashboard and the Orders page stats.
 *
 * Same reasoning as `resolveGstTimeZone`: `Organization.timezone` defaults to
 * "UTC" and most merchants never change it, which started every window at
 * 05:30 IST and cut the daily bars 05:30→05:30. An explicitly-set, valid
 * non-UTC timezone wins; the untouched default reads as IST, GST or not.
 *
 * The client mirrors this rule in `client/app/lib/reporting-date.ts` so the
 * calendar day it sends is the one the server resolves — keep the two in step.
 */
export function resolveReportingTimeZone(org: {
  timezone?: string | null;
}): string {
  const configured = org.timezone?.trim();
  if (configured && configured !== 'UTC' && isValidTimeZone(configured)) {
    return configured;
  }
  return INDIA_TZ;
}

/** 00:00 in `timeZone` on the calendar day `days` before the one `now` falls on. */
export function zonedDayStartDaysAgo(
  now: Date,
  days: number,
  timeZone: string,
): Date {
  const { year, month, day } = zonedParts(now, timeZone);
  // Day arithmetic via UTC so month/year rollover is Date's problem, not ours.
  const target = new Date(Date.UTC(year, month - 1, day - days));
  return zonedTimeToUtc(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    timeZone,
  );
}

/** 00:00 in `timeZone` on the 1st of the month `months` before the one `now` falls in. */
export function zonedMonthStartMonthsAgo(
  now: Date,
  months: number,
  timeZone: string,
): Date {
  const { year, month } = zonedParts(now, timeZone);
  const target = new Date(Date.UTC(year, month - 1 - months, 1));
  return zonedTimeToUtc(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    1,
    timeZone,
  );
}

/** True when `value` is a bare calendar day (`YYYY-MM-DD`) rather than an instant. */
function isCalendarDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/**
 * Inclusive lower bound for a date filter.
 *
 * A bare `YYYY-MM-DD` means a calendar day in the merchant's timezone, not UTC
 * midnight — otherwise an IST merchant filtering "April" silently loses the
 * first 5.5 hours of it. Full ISO instants are passed through unchanged.
 */
export function zonedDayStart(value: string, timeZone: string): Date {
  if (!isCalendarDay(value)) return new Date(value);

  const [year, month, day] = value.trim().split('-').map(Number);
  return zonedTimeToUtc(year, month, day, timeZone);
}

/**
 * EXCLUSIVE upper bound for a date filter — the start of the following day.
 *
 * Use with `lt`, not `lte`. Treating a bare `YYYY-MM-DD` as an inclusive bound
 * pins it to that day's first instant, which excludes almost the entire day the
 * user asked for.
 */
export function zonedDayEndExclusive(value: string, timeZone: string): Date {
  if (!isCalendarDay(value)) return new Date(value);

  const [year, month, day] = value.trim().split('-').map(Number);
  // Day + 1 via UTC arithmetic, then resolved back into the target zone.
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return zonedTimeToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    timeZone,
  );
}

/** Wall-clock Y/M/D as observed in `timeZone` at the given instant. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const pick = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);

  return { year: pick('year'), month: pick('month'), day: pick('day') };
}

/** `YYYY-MM-DD` as observed in `timeZone` — not `toISOString()`, which is the UTC date. */
export function zonedDateString(date: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Offset (ms) to add to a UTC instant to get `timeZone`'s wall clock. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const pick = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);

  // `hour` can format as 24 for midnight under hour12:false on some ICU builds.
  const asIfUtc = Date.UTC(
    pick('year'),
    pick('month') - 1,
    pick('day'),
    pick('hour') % 24,
    pick('minute'),
    pick('second'),
  );

  return asIfUtc - date.getTime();
}

/**
 * The UTC instant at which `timeZone`'s wall clock reads the given local time.
 *
 * Two-pass: the offset itself depends on the instant (DST), so resolve with a
 * first guess and re-check. India has no DST, but the helper stays correct for
 * any org timezone.
 */
export function zonedTimeToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  timeZone: string,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  const guess = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, ms),
  );
  const firstOffset = zoneOffsetMs(guess, timeZone);
  const adjusted = new Date(guess.getTime() - firstOffset);
  const secondOffset = zoneOffsetMs(adjusted, timeZone);

  return secondOffset === firstOffset
    ? adjusted
    : new Date(guess.getTime() - secondOffset);
}

/**
 * Indian financial year (1 April – 31 March) for an instant, as observed in
 * `timeZone`. Example: 2026-03-31T19:00Z is 00:30 IST on 1 Apr 2026 → "2026-27".
 */
export function getFinancialYear(date: Date, timeZone: string): string {
  const { year, month } = zonedParts(date, timeZone);

  if (month >= 4) {
    return `${year}-${(year + 1).toString().slice(2)}`;
  }
  return `${year - 1}-${year.toString().slice(2)}`;
}

/**
 * Half-open [from, toExclusive) instants for a GST return period, anchored to
 * the merchant's timezone.
 *
 * `period` is a month ("04".."03") or a quarter ("Q1".."Q4") within the given
 * financial year. Half-open on purpose: the previous implementation used an
 * inclusive `23:59:59` bound with no milliseconds, silently dropping anything
 * in the last second of the period.
 */
export function gstPeriodRange(
  financialYear: string,
  period: string,
  timeZone: string,
): { from: Date; toExclusive: Date } {
  const startYear = parseInt(financialYear.split('-')[0], 10);
  if (Number.isNaN(startYear)) {
    throw new Error(`Invalid financial year: ${financialYear}`);
  }

  // Month index within the FY, 0 = April.
  let firstFyMonth: number;
  let monthSpan: number;

  if (period.toUpperCase().startsWith('Q')) {
    const quarter = parseInt(period.slice(1), 10);
    if (!(quarter >= 1 && quarter <= 4)) {
      throw new Error(`Invalid quarter: ${period}`);
    }
    firstFyMonth = (quarter - 1) * 3;
    monthSpan = 3;
  } else {
    const calendarMonth = parseInt(period, 10);
    if (!(calendarMonth >= 1 && calendarMonth <= 12)) {
      throw new Error(`Invalid period: ${period}`);
    }
    // April(4) → 0 … March(3) → 11
    firstFyMonth = (calendarMonth - 4 + 12) % 12;
    monthSpan = 1;
  }

  const toCalendar = (fyMonthIndex: number) => {
    const absolute = 3 + fyMonthIndex; // 3 = April as a 0-indexed month
    return {
      year: startYear + Math.floor(absolute / 12),
      month: (absolute % 12) + 1, // 1-12
    };
  };

  const start = toCalendar(firstFyMonth);
  const end = toCalendar(firstFyMonth + monthSpan);

  return {
    from: zonedTimeToUtc(start.year, start.month, 1, timeZone),
    toExclusive: zonedTimeToUtc(end.year, end.month, 1, timeZone),
  };
}

// ─── VALIDATION ───
//
/**
 * The FY quarter a calendar month falls in — "04" → "Q1".
 *
 * The financial year starts in April, so this is NOT the calendar quarter:
 * April–June is Q1 and January–March is Q4. Uses the same FY-month indexing as
 * `gstPeriodRange` above, so a quarter resolved here always contains the month
 * it was resolved from.
 *
 * Exists because a period can be FILED quarterly and still be EDITED by a
 * document dated to one of its months: the lock has to recognise that a June
 * invoice sits inside a filed Q1.
 */
export function gstQuarterForMonth(month: string): string {
  const calendarMonth = parseInt(month, 10);
  if (!(calendarMonth >= 1 && calendarMonth <= 12)) {
    throw new Error(`Invalid period: ${month}`);
  }
  const fyMonthIndex = (calendarMonth - 4 + 12) % 12;
  return `Q${Math.floor(fyMonthIndex / 3) + 1}`;
}

// `gstPeriodRange` throws a bare `Error` for a malformed financial year or
// period, which NestJS surfaces as a 500. These predicates let the DTO layer
// reject the same values as a 400 before they ever reach the date math.

/** `YYYY-YY`, e.g. "2025-26". */
export const GST_FINANCIAL_YEAR_REGEX = /^\d{4}-\d{2}$/;

/** A calendar month ("04") or an FY quarter ("Q1"). Lowercase `q` is accepted
 *  because `gstPeriodRange` upper-cases before testing, so rejecting it here
 *  would break URLs that already work. */
export const GST_PERIOD_REGEX = /^(0[1-9]|1[0-2]|[Qq][1-4])$/;

/**
 * True for a well-formed Indian financial year.
 *
 * The regex alone is not enough: "2025-99" matches it. The second half must be
 * the next year's last two digits, which is also what makes "2025-26" and
 * "2099-00" both correct.
 */
export function isValidFinancialYear(value: string): boolean {
  if (!GST_FINANCIAL_YEAR_REGEX.test(value)) return false;

  const startYear = parseInt(value.slice(0, 4), 10);
  const declaredEnd = value.slice(5);

  return declaredEnd === String((startYear + 1) % 100).padStart(2, '0');
}

/** True when `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone?.trim()) return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() });
    return true;
  } catch {
    // RangeError for an unknown zone. Any other throw is equally disqualifying.
    return false;
  }
}
