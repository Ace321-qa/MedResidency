/**
 * Date arithmetic for blocks, weeks and evaluation periods.
 *
 * ## The rule this file exists to enforce
 *
 * An academic block is a whole number of weeks that begins on the programme's
 * week-start day and ends on the day *before* it. A programme starting blocks on
 * Sunday therefore ends them on Saturday; one starting on Monday ends them on
 * Sunday. Both reduce to:
 *
 *     endDate = startDate + (weeks * 7 - 1) days
 *
 * Worked examples:
 *
 *     4 weeks from Sunday 05 Jul 2026 -> Saturday 01 Aug 2026   (+27 days)
 *     4 weeks from Monday 06 Jul 2026 -> Sunday 02 Aug 2026     (+27 days)
 *     1 week -> +6 days      2 weeks -> +13 days
 *     3 weeks -> +20 days    4 weeks -> +27 days
 *
 * The `- 1` is the whole point. `weeks * 7` lands on the *next* week's start
 * day, so a 4-week block used to be saved ending on Monday instead of Saturday
 * and a 3-week block on the wrong Sunday entirely. A block owns its days: the
 * last day of a four-week block is the Saturday, not the next Sunday.
 *
 * `src/utils/blockDates.js` on the server is the mirror of this file and the API
 * re-derives and re-validates whatever a form sends, so the two must stay in
 * step. Only this file is bundled into the app.
 *
 * Every function works on plain `YYYY-MM-DD` strings and does its arithmetic in
 * UTC. Parsing a date-only string with `new Date('2026-07-05')` yields UTC
 * midnight, whose *local* calendar day is the previous one for anyone west of
 * Greenwich — which would silently turn a Saturday end date into a Friday.
 */

/** Index order matches `Date.prototype.getUTCDay()`: 0 = Sunday. */
export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export type DayName = (typeof DAY_NAMES)[number];

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const DAY_INDEX: Record<string, DayName> = DAY_NAMES.reduce((map, name, index) => {
  map[name.toUpperCase()] = name;
  map[name.slice(0, 3).toUpperCase()] = name;
  return map;
}, {} as Record<string, DayName>);

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CalendarParts {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
  /** UTC midnight for the date, the value all arithmetic is done on. */
  time: number;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/**
 * Parse a strict `YYYY-MM-DD` string, rejecting impossible calendar dates.
 *
 * Also accepts the ISO instants mysql2 produces for DATE columns by truncating
 * to the first ten characters, so a value straight off the API can be passed in
 * without being reformatted first.
 *
 * @returns {CalendarParts|null}
 */
export function parseCalendarDate(value: string | null | undefined): CalendarParts | null {
  if (value === undefined || value === null) return null;

  const match = DATE_PATTERN.exec(String(value).trim().slice(0, 10));
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const time = Date.UTC(year, month - 1, day);
  const parsed = new Date(time);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day, time };
}

/** A local `Date` at midday, safe to hand to a calendar that reads local parts. */
export function calendarDateToLocalDate(value: string | null | undefined): Date | null {
  const parts = parseCalendarDate(value);
  if (!parts) return null;
  return new Date(parts.year, parts.month - 1, parts.day, 12, 0, 0, 0);
}

/** Local `Date` back to `YYYY-MM-DD`. */
export function localDateToCalendarDate(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Coerce whatever a caller hands us — a `Date` or a `YYYY-MM-DD` string — into
 * the canonical `YYYY-MM-DD` form every arithmetic function here works on.
 *
 * A `Date` is read through its *local* parts, matching `calendarDateToLocalDate`
 * / `localDateToCalendarDate`: the app builds picker dates at local midday, and
 * reading them back through UTC would shift a date by a day west of Greenwich.
 *
 * @returns {string|null} null for an unparseable or invalid value.
 */
export function resolveCalendarDate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return localDateToCalendarDate(value);
  }
  const parts = parseCalendarDate(value);
  return parts ? `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}` : null;
}

/** True when `value` is a real calendar date in `YYYY-MM-DD` form. */
export function isCalendarDate(value: string | null | undefined): boolean {
  return parseCalendarDate(value) !== null;
}

/** Day name for a date string, e.g. 'Sunday', or null when unparseable. */
export function dayNameOf(value: string | null | undefined): DayName | null {
  const parts = parseCalendarDate(value);
  return parts ? DAY_NAMES[new Date(parts.time).getUTCDay()] : null;
}

/**
 * Coerce the shapes a caller may send into a canonical day name.
 *
 * Accepts 'SUNDAY', 'Sunday', 'Sun' or a `getDay()` index (0 = Sunday).
 */
export function normalizeWeekStartDay(value: string | number | null | undefined): DayName | null {
  if (value === undefined || value === null) return null;

  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= 6 ? DAY_NAMES[value] : null;
  }

  const text = String(value).trim().toUpperCase();
  if (!text) return null;
  return DAY_INDEX[text] ?? DAY_INDEX[text.slice(0, 3)] ?? null;
}

/** The day a block ends on: the day before the programme's week start. */
export function weekEndDay(weekStartDay: string | number | null | undefined): DayName {
  const start = normalizeWeekStartDay(weekStartDay) ?? 'Sunday';
  return DAY_NAMES[(DAY_NAMES.indexOf(start) + 6) % 7];
}

/** Shift a date by whole days; the count may be negative. */
export function addDays(value: string, days: number): string | null {
  const parts = parseCalendarDate(value);
  if (!parts || !Number.isFinite(days)) return null;

  const shifted = new Date(parts.time + Math.round(days) * 86_400_000);
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Whole days from `start` to `end`; negative when `end` precedes `start`. */
export function diffDays(start: string, end: string): number | null {
  const from = parseCalendarDate(start);
  const to = parseCalendarDate(end);
  if (!from || !to) return null;
  return Math.round((to.time - from.time) / 86_400_000);
}

/**
 * The universal inclusive end date: `startDate + (durationDays - 1) days`.
 *
 * The whole rule in one line — a window that is `N` days long owns its start
 * day, so a 7-day week runs `start .. start + 6`, a 28-day block runs
 * `start .. start + 27`, and the end always lands on the day before the start's
 * weekday (the next week around).
 *
 * Worked examples:
 *
 *     calculateEndDate('2026-06-28', 7)  === '2026-07-04'  (Sunday -> Saturday)
 *     calculateEndDate('2026-06-28', 28) === '2026-07-25'  (Sunday -> Saturday)
 *     calculateEndDate('2026-06-29', 7)  === '2026-07-05'  (Monday -> Sunday)
 *     calculateEndDate('2026-07-01', 7)  === '2026-07-07'  (Wednesday -> Tuesday)
 *
 * @param startDate A `Date` or `YYYY-MM-DD` string.
 * @param durationDays Positive whole days; fractional values are rounded.
 * @returns {string|null} `YYYY-MM-DD`, or null for a bad date or a
 *   non-positive duration.
 */
export function calculateEndDate(startDate: Date | string, durationDays: number): string | null {
  const start = resolveCalendarDate(startDate);
  const duration = Number(durationDays);
  if (!start || !Number.isFinite(duration) || duration <= 0) return null;
  return addDays(start, Math.round(duration) - 1);
}

/**
 * The end date of a block of `weeks` whole weeks: `calculateEndDate(start, weeks * 7)`.
 *
 * A four-week block from Sunday 28/06/2026 ends Saturday 25/07/2026, and from
 * Monday 29/06/2026 ends Sunday 26/07/2026 — whatever weekday the coordinator
 * picked for `startDate`.
 */
export function calculateBlockEndDate(startDate: Date | string, weeks = 4): string | null {
  const count = Number(weeks);
  if (!Number.isFinite(count) || count <= 0) return null;
  return calculateEndDate(startDate, Math.round(count) * 7);
}

/**
 * The standard rotation conversion: `months * 4` weeks per calendar month.
 *
 * A 3-month rotation window is therefore 12 weeks (84 days), matching the rule
 * the Master Rotation Grid runs on (13 blocks × 4 weeks = 52 weekly columns).
 * Only whole months are expected in practice; fractional months are kept exact
 * so the caller can round at the boundary it renders.
 *
 * @returns {number} `NaN` when `months` is not a finite number.
 */
export function convertMonthsToWeeks(months: number): number {
  const value = Number(months);
  return Number.isFinite(value) ? value * 4 : NaN;
}

/**
 * The inclusive end date of a `weeks`-week rotation window from `startDate`.
 *
 * Composition of the two rules above: `W = months × 4` weeks, then the window
 * owns its own days, so the end date is `start + (W × 7 - 1)` days.
 *
 * ```ts
 * calculateEndDateFromWeeks('2026-10-11', 12) === '2027-01-02'  (Sun -> Sat)
 * calculateEndDateFromWeeks('2026-10-12', 12) === '2027-01-03'  (Mon -> Sun)
 * ```
 *
 * @param startDate A `Date` or `YYYY-MM-DD` string.
 * @param weeks Positive whole weeks; fractional values round to whole days.
 * @returns {string|null} `YYYY-MM-DD`, or null for a bad date or a non-positive
 *   duration.
 */
export function calculateEndDateFromWeeks(startDate: Date | string, weeks: number): string | null {
  const count = Number(weeks);
  if (!Number.isFinite(count) || count <= 0) return null;
  return calculateEndDate(startDate, count * 7);
}

/** One contiguous 7-day window of a yearly sequence. */
export interface WeeklySubRange {
  /** 1-based index across the sequence. */
  weekNumber: number;
  start: string;
  end: string;
}

/**
 * The `totalWeeks` contiguous 7-day windows that begin at `startDate`.
 *
 * The sequence follows whatever weekday `startDate` falls on — a Sunday start
 * yields Sunday–Saturday weeks, a Monday start Monday–Sunday ones — because each
 * window is simply `start + (W-1)*7` through `start + (W-1)*7 + 6`.
 *
 * ```ts
 * calculateWeeklySubRanges('2026-06-29', 2)
 * // [{ weekNumber: 1, start: '2026-06-29', end: '2026-07-05' },
 * //  { weekNumber: 2, start: '2026-07-06', end: '2026-07-12' }]
 * ```
 */
export function calculateWeeklySubRanges(startDate: Date | string, totalWeeks = 52): WeeklySubRange[] {
  const start = resolveCalendarDate(startDate);
  const count = Number(totalWeeks);
  if (!start || !Number.isFinite(count) || count <= 0) return [];

  const weeks: WeeklySubRange[] = [];
  for (let index = 0; index < Math.floor(count); index += 1) {
    const weekStart = addDays(start, index * 7);
    if (!weekStart) break;
    weeks.push({
      weekNumber: index + 1,
      start: weekStart,
      end: addDays(weekStart, 6) ?? weekStart,
    });
  }
  return weeks;
}

/**
 * The end date of a block of `weeks` whole weeks starting at `startDate`.
 *
 * `endDateForDuration('2026-07-05', 4) === '2026-08-01'` (Saturday).
 *
 * Kept as the named entry point the block editor and the backend mirror already
 * import; it now delegates to `calculateBlockEndDate` so there is one formula.
 *
 * @returns {string|null} `YYYY-MM-DD`, or null for a bad date or a
 *   non-positive duration.
 */
export function endDateForDuration(startDate: string, weeks: number): string | null {
  return calculateBlockEndDate(startDate, weeks);
}

/**
 * The `durationWeeks` that would produce this window, or null when the window is
 * not a whole number of weeks.
 */
export function durationWeeksBetween(startDate: string, endDate: string): number | null {
  const days = diffDays(startDate, endDate);
  if (days === null || days < 0) return null;

  const span = days + 1;
  if (span % 7 !== 0) return null;
  return span / 7;
}

/**
 * Add whole months, clamping the day to the target month's length, so a
 * three-month posting starting 31 August ends on 30 November rather than
 * 3 December.
 */
export function addMonths(value: string, months: number): string | null {
  const parts = parseCalendarDate(value);
  if (!parts || !Number.isFinite(months)) return null;

  const monthIndex = parts.month - 1 + Math.trunc(months);
  const year = parts.year + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;

  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(parts.day, lastDayOfMonth);

  return `${pad(year, 4)}-${pad(month + 1)}-${pad(day)}`;
}

/** The end of a supervisor posting: the evaluation window end, `months` on. */
export function evaluationEndDate(startDate: string, months: number): string | null {
  return addMonths(startDate, months);
}

/** `Sun 05 Jul - Sat 01 Aug 2026`, the window shown in grid sub-headers. */
export function describeWindow(startDate: string, endDate: string): string {
  const from = parseCalendarDate(startDate);
  const to = parseCalendarDate(endDate);
  if (!from || !to) return '';

  const weekday = (parts: CalendarParts) => DAY_NAMES[new Date(parts.time).getUTCDay()].slice(0, 3);
  const month = (parts: CalendarParts) => MONTH_NAMES[parts.month - 1];
  const day = (parts: CalendarParts) => pad(parts.day);

  // The trailing year is only spelled out when the window crosses one, so a
  // grid column heading stays two short fragments instead of four.
  if (from.year === to.year) {
    return `${weekday(from)} ${day(from)} ${month(from)} - ${weekday(to)} ${day(to)} ${month(to)} ${to.year}`;
  }
  return `${weekday(from)} ${day(from)} ${month(from)} ${from.year} - ${weekday(to)} ${day(to)} ${month(to)} ${to.year}`;
}

/**
 * `Sun, Oct 11, 2026` — the weekday-and-date form the rotation badge uses.
 *
 * Distinct from `describeWindow` above: that trades the year for width in a
 * grid column, while this spells both out because the badge sits under a field
 * with room for it and a coordinator reading "Jan 02" across a year boundary
 * needs the year to be unambiguous.
 */
export function formatWeekdayDate(value: string | null | undefined): string {
  const parts = parseCalendarDate(value);
  if (!parts) return '';
  const weekday = DAY_NAMES[new Date(parts.time).getUTCDay()].slice(0, 3);
  const month = MONTH_NAMES[parts.month - 1];
  return `${weekday}, ${month} ${pad(parts.day)}, ${parts.year}`;
}

/**
 * The rotation-window badge: `12 Weeks (Sun, Oct 11, 2026 – Sat, Jan 02, 2027)`.
 *
 * Ties the months-to-weeks rule to the inclusive end date so the two are read
 * together: `weeks` is the already-converted total (`months × 4`) and the window
 * owns every one of its days, so `start + weeks × 7 - 1` lands on the Saturday
 * after a Sunday start.
 *
 * @returns {string|null} null when the weekday count or either date is unusable.
 */
export function formatWeekSpan(
  weeks: number,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): string | null {
  const count = Math.round(Number(weeks));
  const from = formatWeekdayDate(startDate);
  const to = formatWeekdayDate(endDate);
  if (!Number.isFinite(count) || count <= 0 || !from || !to) return null;
  return `${count} Week${count === 1 ? '' : 's'} (${from} – ${to})`;
}

/** `10:30` - 14:00 for a MySQL TIME column that may arrive as `14:00:00`. */
export function formatClock(value: string | null | undefined): string {
  if (!value) return '--';
  const parts = String(value).split(':');
  if (parts.length < 2) return '--';
  return `${pad(Number(parts[0]))}:${pad(Number(parts[1]))}`;
}

/** The next occurrence of `day` on or after `from`, as `YYYY-MM-DD`. */
export function nextWeekday(from: string, day: string | number): string | null {
  const target = normalizeWeekStartDay(day);
  const parts = parseCalendarDate(from);
  if (!target || !parts) return null;

  const current = new Date(parts.time).getUTCDay();
  const wanted = DAY_NAMES.indexOf(target);
  return addDays(from, (wanted - current + 7) % 7);
}

/** A resolved block window: the dates, the length and every complaint. */
export interface BlockWindow {
  start_date: string | null;
  end_date: string | null;
  duration_weeks: number | null;
  starts_on: DayName | null;
  ends_on: DayName | null;
  errors: string[];
}

export interface ResolveBlockWindowInput {
  start_date: string | null | undefined;
  end_date?: string | null;
  /** `null`/omitted derives the length from the window instead of asserting it. */
  duration_weeks?: number | string | null;
  /** The programme's week-start day; a mismatch is reported, not enforced. */
  week_start_day?: string | number | null;
}

/**
 * Derive a block window from whichever half the caller supplied.
 *
 * The mirror of `resolveBlockWindow` in the backend's `src/utils/blockDates.js`,
 * message for message, so a form can validate as the user types and produce the
 * same sentence the API would have returned. Three cases:
 *
 *  - start + duration -> the end date is derived, `start + weeks * 7 - 1`;
 *  - start + end -> the length is derived, and must be whole weeks;
 *  - all three -> they must agree, or the disagreement is named.
 *
 * `week_start_day` is a warning rather than a rejection when it is supplied: a
 * block that starts on a Tuesday inside a Sunday-start programme is a data
 * mistake worth surfacing before a coordinator saves it, and the server is the
 * authority that finally refuses it.
 */
export function resolveBlockWindow(input: ResolveBlockWindowInput): BlockWindow {
  const errors: string[] = [];
  const startDate = input.start_date ?? null;
  const endDate = input.end_date ?? null;

  const weekStart = normalizeWeekStartDay(input.week_start_day);
  const parsedStart = parseCalendarDate(startDate);

  if (!parsedStart) {
    errors.push('start_date must be a real date in YYYY-MM-DD form.');
  }

  const startsOn = parsedStart ? dayNameOf(startDate) : null;
  if (parsedStart && weekStart && startsOn !== weekStart) {
    errors.push(
      `This programme starts its week on ${weekStart}, so a block must start on ${weekStart} — ${startDate} is a ${startsOn}.`,
    );
  }

  const raw = input.duration_weeks;
  const requestedWeeks = raw === undefined || raw === null || raw === '' ? null : Number(raw);
  if (requestedWeeks !== null && (!Number.isInteger(requestedWeeks) || requestedWeeks <= 0)) {
    errors.push('duration_weeks must be a whole number of weeks above 0.');
  }

  const parsedEnd = parseCalendarDate(endDate);
  if (!parsedStart || !startDate) {
    return { start_date: null, end_date: null, duration_weeks: null, starts_on: null, ends_on: null, errors };
  }
  const start = startDate;

  // Derive whichever half the caller left out.
  let resolvedEnd: string | null = parsedEnd ? endDate : null;
  if (!resolvedEnd && requestedWeeks !== null) {
    resolvedEnd = endDateForDuration(start, requestedWeeks);
  }

  const spanWeeks = resolvedEnd ? durationWeeksBetween(start, resolvedEnd) : null;

  if (!resolvedEnd) {
    errors.push('Provide end_date or duration_weeks so the block length is known.');
  } else if (resolvedEnd < start) {
    errors.push('end_date must be on or after start_date.');
  } else if (spanWeeks === null) {
    errors.push(
      `A block is a whole number of weeks: ${(diffDays(start, resolvedEnd) ?? 0) + 1} days is not one. Give a start date and a duration in weeks instead.`,
    );
  }

  // All three supplied: they must not contradict each other.
  if (resolvedEnd && parsedEnd && requestedWeeks !== null && Number.isInteger(requestedWeeks)) {
    const implied = endDateForDuration(start, requestedWeeks);
    if (implied && resolvedEnd !== implied) {
      errors.push(`end_date does not match a ${requestedWeeks}-week block from ${start}, which ends on ${implied}.`);
    }
  }

  return {
    start_date: start,
    end_date: resolvedEnd,
    duration_weeks: requestedWeeks !== null && Number.isInteger(requestedWeeks) ? requestedWeeks : spanWeeks,
    starts_on: startsOn,
    ends_on: resolvedEnd ? dayNameOf(resolvedEnd) : null,
    errors,
  };
}