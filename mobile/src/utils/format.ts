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
 * Two formats reach the client:
 *  - `YYYY-MM-DD`, from the queries that DATE_FORMAT their DATE columns. Parsed
 *    as local midnight so it can never shift a calendar day.
 *  - A UTC instant, because mysql2 materialises DATE columns at the server's
 *    local midnight. The true stored date is the *local* calendar day of that
 *    instant, so the local parts are what we format (see the same reasoning in
 *    src/services/releaseLetterService.js).
 */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;

  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00`)
    : new Date(value);

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

/** `07:00` — clock_in/clock_out are DATETIME, so only the time part is shown. */
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

/** Today as `YYYY-MM-DD` in the device's timezone. */
export function todayCalendarDate(): string {
  return toCalendarDate(new Date());
}

/** `YYYY-MM-DD HH:MM:SS`, the literal format a MySQL DATETIME column accepts. */
export function toMysqlDateTime(date: Date): string {
  return `${toCalendarDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Combine a `YYYY-MM-DD` date and an `HH:MM` time into a local `Date`.
 * Returns null when either half is malformed or out of range.
 */
export function combineDateAndTime(date: string, time: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!dateMatch || !timeMatch) return null;

  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  if (hours > 23 || minutes > 59) return null;

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