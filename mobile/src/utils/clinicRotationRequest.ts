import {
  type DayName,
  calculateEndDateFromWeeks,
  dayNameOf,
  formatWeekdayDate,
  normalizeWeekStartDay,
} from './dateCalc';

/**
 * The vocabulary of a clinic-rotation request.
 *
 * Two fields are new to the request form and both have a rule that must hold
 * wherever they are read — on the phone that previews them, on the server that
 * stores them, and in the tests that check the two agree:
 *
 *   - **the window** — an approved release runs for a whole number of weeks that
 *     begins on the start date and ends the day *before* that many weeks later,
 *     i.e. `end = start + (weeks × 7 − 1)`. The `- 1` is the whole point; a
 *     four-week release from Sunday 18 Oct 2026 ends on Saturday 14 Nov, not on
 *     the following Sunday.
 *   - **the clinic days** — a resident asks for one, two or three recurring
 *     weekdays out of the institutional set (Sunday through Thursday), never
 *     more, so a release can be checked against a week without ambiguity.
 *
 * Keeping both here — not inside the screen — means the CCC matrix, the request
 * sheet and any future reader share one definition.
 */

/** The weekdays a clinic may be held on, in institutional order. */
export const CLINIC_DAY_OPTIONS: DayName[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
];

/** A resident may hold between one and three recurring clinic sessions. */
export const MIN_CLINIC_DAYS = 1;
export const MAX_CLINIC_DAYS = 3;

/** The ready-made period lengths, in weeks, offered above "custom". */
export const PERIOD_WEEK_PRESETS = [1, 2, 3, 4] as const;

/** The preset that opens a free-text week count instead of picking a number. */
export const CUSTOM_PERIOD = 'CUSTOM';

/**
 * Coerce whatever the period control sent into a whole number of weeks.
 *
 * The control offers `PERIOD_WEEK_PRESETS` and a custom entry, so this is the one
 * place the two shapes meet: a preset arrives as its own string, a custom value
 * as the digits the resident typed. Anything not a positive whole number is
 * `null`, which is what stops a preview being drawn from a half-typed value.
 */
export function parsePeriodWeeks(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const weeks = Number(value);
  if (!Number.isInteger(weeks) || weeks <= 0) return null;
  // Fifty-two weeks is one academic year; beyond that a release no longer
  // describes a rotation a coordinator can place.
  if (weeks > 52) return null;
  return weeks;
}

/**
 * The end of a release: `startDate + (weeks × 7 − 1)` days, or `null` when the
 * start date or the week count is not usable yet.
 *
 * A thin, named wrapper over the shared `calculateEndDateFromWeeks` so the rule
 * is stated once in this module and the screen never re-implements the `- 1`.
 */
export function clinicEndDate(
  startDate: string | null | undefined,
  weeks: number | null | undefined,
): string | null {
  const count = parsePeriodWeeks(weeks);
  if (!startDate || count === null) return null;
  return calculateEndDateFromWeeks(startDate, count);
}

/** `Sat, Nov 14, 2026` — the end date with its weekday, for the read-only field. */
export function clinicEndDateLabel(
  startDate: string | null | undefined,
  weeks: number | null | undefined,
): string {
  return formatWeekdayDate(clinicEndDate(startDate, weeks));
}

/** The weekday a start date falls on, e.g. `Sunday`, or `null`. */
export function clinicStartWeekday(startDate: string | null | undefined): DayName | null {
  return dayNameOf(startDate);
}

/**
 * Add or remove one weekday from the chosen set, enforcing the one-to-three rule.
 *
 * Returns the set unchanged when the toggle would break a limit, so the control
 * never has to reason about the bounds itself. Order follows `CLINIC_DAY_OPTIONS`
 * rather than the order things were tapped, so a saved request reads the same way
 * every time.
 */
export function toggleClinicDay(current: DayName[], day: DayName | string): DayName[] {
  const target = normalizeWeekStartDay(day);
  if (!target || !CLINIC_DAY_OPTIONS.includes(target as DayName)) return sortClinicDays(current);

  const chosen = sortClinicDays(current);
  if (chosen.includes(target as DayName)) {
    return chosen.filter((value) => value !== target);
  }
  if (chosen.length >= MAX_CLINIC_DAYS) return chosen;
  return sortClinicDays([...chosen, target as DayName]);
}

/** The chosen days in institution order, de-duplicated. */
export function sortClinicDays(days: (DayName | string)[]): DayName[] {
  const wanted = new Set(
    (days ?? [])
      .map((day) => normalizeWeekStartDay(day))
      .filter((day): day is DayName => Boolean(day) && CLINIC_DAY_OPTIONS.includes(day as DayName)),
  );
  return CLINIC_DAY_OPTIONS.filter((day) => wanted.has(day));
}

/** True when the set is within the one-to-three rule. */
export function clinicDaysAreValid(days: (DayName | string)[]): boolean {
  const count = sortClinicDays(days).length;
  return count >= MIN_CLINIC_DAYS && count <= MAX_CLINIC_DAYS;
}

/** `Wed` — the three-letter form used in a badge or a summary line. */
export function shortClinicDay(day: DayName | string): string {
  const canonical = normalizeWeekStartDay(day);
  return canonical ? canonical.slice(0, 3) : '';
}

/** `Wed, Fri` — the day set as a compact, readable list. */
export function formatClinicDays(days: (DayName | string)[]): string {
  return sortClinicDays(days).map(shortClinicDay).filter(Boolean).join(', ');
}

/** `+ ANC (Wed, Fri)` — the notation the Master Grid prints beside a rotation. */
export function clinicRequestBadge(name: string, days: (DayName | string)[]): string {
  const label = String(name ?? '').trim();
  const dayText = formatClinicDays(days);
  if (!label) return dayText ? `+ (${dayText})` : '+ Clinic';
  return dayText ? `+ ${label} (${dayText})` : `+ ${label}`;
}
