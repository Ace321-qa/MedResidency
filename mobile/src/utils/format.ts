import type { Numeric } from '../types/api';

const MONTHS = [
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
];

/**
 * Parse an API date value into a local `Date`.
 *
 * Three formats reach the client:
 *  - `YYYY-MM-DD`, from the queries that DATE_FORMAT their DATE columns. Parsed
 *    as local midnight so it can never shift a calendar day.
 *  - `YYYY-MM-DD HH:MM`, from the attendance query that DATE_FORMATs the clock
 *    columns. Parsed as a wall-clock local time; there is deliberately no
 *    timezone, so `07:00` is `07:00` wherever the device is.
 *  - A UTC instant, because mysql2 materialises DATE/DATETIME columns at the
 *    server's local timezone. The true stored value is the *local* wall clock of
 *    that instant, so the local parts are what we format (see the same reasoning
 *    in src/services/releaseLetterService.js).
 */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;

  const trimmed = value.trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? new Date(`${trimmed}T00:00:00`)
    : /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)
      ? new Date(trimmed.replace(' ', 'T'))
      : new Date(trimmed);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `05 Jul 2026` */
export function formatDate(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return '--';
  return `${pad(date.getDate())} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** `05 Jul` — for dense list rows where the year is already implied. */
export function formatShortDate(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return '--';
  return `${pad(date.getDate())} ${MONTHS[date.getMonth()]}`;
}

/** `07:00` — clock_in/clock_out are wall-clock times shown to the minute. */
export function formatTime(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return '--';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `05 Jul 2026, 07:00` */
export function formatDateTime(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return '--';
  return `${formatDate(value)}, ${formatTime(value)}`;
}

/** Local calendar day as `YYYY-MM-DD`, the format the API expects for DATE. */
export function toCalendarDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Normalise any API date value to a local `YYYY-MM-DD`, or null if unparseable.
 *
 * Use this for *comparing* dates. `formatDate` returns a display string such as
 * `05 Jul 2026`, and comparing those lexically is meaningless — `'05 Jul 2026' <
 * '2026-07-04'` is true because `'0'` sorts before `'2'`, which would make every
 * date look older than every window. Range logic must go through this function.
 */
export function toComparableDate(value: string | null | undefined): string | null {
  const date = parseDate(value);
  return date ? toCalendarDate(date) : null;
}

/**
 * `Y/M/D` numbers to a validated `YYYY-MM-DD`, or null.
 *
 * Range checks the parts, then lets a constructed `Date` round-trip them: a
 * value whose local parts survive the trip is a real calendar day, which is how
 * 31 February and a 29 February in a common year are refused instead of rolling
 * into the next month.
 */
function isoFromParts(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1) return null;

  const candidate = new Date(year, month - 1, day);
  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) {
    return null;
  }

  return toCalendarDate(candidate);
}

/**
 * Normalise a date the user typed or pasted into `YYYY-MM-DD`, inferring the
 * year when only the day and month were given.
 *
 * The API's DATE columns only ever accept `YYYY-MM-DD`, and the calendar picker
 * always produces that shape. Typing, though, is not a picker: "18/10" is how a
 * resident writes 18 October, and making them type the year for a date they
 * worked this year is friction with no upside. Accepted shapes:
 *
 *  - day-month with a `/`, `-` or `.` separator: `18/10`, `18-10`, `18.10`;
 *  - month-first, when the day cannot come first: `10/18`, `10-18`;
 *  - the same with an explicit year: `18/10/2026`, `18/10/26`.
 *
 * Disambiguation runs in this order:
 *  1. first part above 12 (`18/10`) -> first is the day, second the month;
 *  2. second part above 12 (`10/18`) -> first is the month, second the day;
 *  3. both 12 or under (`05/06`) -> day first, the reading the rest of the app
 *     and the `YYYY-MM-DD` API use.
 *
 * The year is the system clock's and is never rolled forward: `18/10` entered
 * on 19 Oct 2026 is 18 Oct 2026, not 2027. A two-digit year is read as 20xx.
 * Impossible days (`31/02`) are rejected rather than rolled into March.
 *
 * Only numeric forms are understood. The engine's own `Date` string parser is
 * deliberately never consulted: `new Date('10/')` is October 2001 in V8 and
 * `new Date('2026-10')` is 1 October 2026, so a half-typed value would come
 * back as a confident, wrong date instead of the error the field can show. The
 * one shape accepted beyond the shorthand above is the canonical
 * `YYYY-MM-DD` — or the same with `/` or `.` separators — which passes through
 * unchanged, so re-normalising an untouched value is a no-op.
 *
 * @returns `YYYY-MM-DD`, or null when the input is not a real calendar date.
 */
export function normalizeToISODate(input: string | null | undefined): string | null {
  const trimmed = (input ?? '').trim();
  if (trimmed === '') return null;

  const shorthand = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(trimmed);

  if (!shorthand) {
    const canonical = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(trimmed);
    return canonical ? isoFromParts(Number(canonical[1]), Number(canonical[2]), Number(canonical[3])) : null;
  }

  const first = Number(shorthand[1]);
  const second = Number(shorthand[2]);
  const yearPart = shorthand[3];

  let day: number;
  let month: number;
  if (first > 12 && second <= 12) {
    day = first;
    month = second;
  } else if (second > 12 && first <= 12) {
    month = first;
    day = second;
  } else if (first <= 12 && second <= 12) {
    day = first;
    month = second;
  } else {
    // Both parts over 12: not a day-month pair in any order.
    return null;
  }

  const year = yearPart
    ? yearPart.length === 2
      ? 2000 + Number(yearPart)
      : Number(yearPart)
    : new Date().getFullYear();

  return isoFromParts(year, month, day);
}

/** Today as `YYYY-MM-DD` in the device's timezone. */
export function todayCalendarDate(): string {
  return toCalendarDate(new Date());
}

/** `YYYY-MM-DD HH:MM`, the minute-precision format the API stores and returns. */
export function toMysqlDateTime(date: Date): string {
  return `${toCalendarDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Combine a `YYYY-MM-DD` date and an `HH:MM` time into a local `Date`.
 * Returns null when either half is malformed or out of range.
 *
 * An optional `:SS` tail is tolerated but discarded: duty hours are logged to
 * the minute, so a stray second never leaks into what gets saved.
 */
export function combineDateAndTime(date: string, time: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
  if (!dateMatch || !timeMatch) return null;

  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const seconds = timeMatch[3] === undefined ? 0 : Number(timeMatch[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;

  const combined = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    hours,
    minutes,
    0,
    0,
  );

  return Number.isNaN(combined.getTime()) ? null : combined;
}

/** Hours between two instants, treating an earlier end time as an overnight shift. */
export function durationHours(start: Date, end: Date): number {
  let hours = (end.getTime() - start.getTime()) / 3_600_000;
  if (hours < 0) hours += 24;
  return Math.round(hours * 100) / 100;
}

/** Coerce a MySQL DECIMAL, which arrives as a string, to a number. */
export function toNumber(value: Numeric | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** `8.5 h`, trimming a trailing `.00` on whole numbers. */
export function formatHours(value: Numeric | null | undefined): string {
  const hours = toNumber(value);
  if (hours === null) return '--';
  return `${Number.isInteger(hours) ? String(hours) : hours.toFixed(2)} h`;
}

/** `4 weeks`, or `1 week` / `1.5 weeks`. */
export function formatWeeks(value: Numeric | null | undefined): string {
  const weeks = toNumber(value);
  if (weeks === null) return '--';
  const label = Number.isInteger(weeks) ? String(weeks) : weeks.toFixed(1);
  return `${label} ${weeks === 1 ? 'week' : 'weeks'}`;
}

/** `HAJJ_LEAVE` -> `Hajj Leave`, for enum values rendered as labels. */
export function humanizeToken(token: string): string {
  return token
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** `05 Jul – 31 Jul 2026`, collapsing the year when both ends share it. */
export function formatDateRange(start: string, end: string): string {
  const startDate = parseDate(start);
  const endDate = parseDate(end);
  if (!startDate || !endDate) return '--';

  const sameYear = startDate.getFullYear() === endDate.getFullYear();
  return sameYear
    ? `${formatShortDate(start)} – ${formatDate(end)}`
    : `${formatDate(start)} – ${formatDate(end)}`;
}

/** Whether `value` falls on or between `start` and `end`, compared as calendar days. */
export function isWithinRange(
  value: string,
  start: string,
  end: string,
): boolean {
  const target = parseDate(value);
  const rangeStart = parseDate(start);
  const rangeEnd = parseDate(end);
  if (!target || !rangeStart || !rangeEnd) return false;
  return target.getTime() >= rangeStart.getTime() && target.getTime() <= rangeEnd.getTime();
}

/** Whether `value` falls on or after `start`, compared as calendar days. */
export function isOnOrAfter(value: string, start: string): boolean {
  const target = parseDate(value);
  const threshold = parseDate(start);
  if (!target || !threshold) return false;
  return target.getTime() >= threshold.getTime();
}