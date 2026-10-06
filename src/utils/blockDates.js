/**
 * Block and window date arithmetic.
 *
 * ## The rule this file exists to enforce
 *
 * An academic block is a whole number of weeks that begins on the programme's
 * `week_start_day` and ends on the day *before* it. A programme starting blocks
 * on Sunday therefore ends them on Saturday; one starting on Monday ends them on
 * Sunday. Both reduce to a single formula:
 *
 *     end_date = start_date + (duration_weeks * 7 - 1) days
 *
 * Worked examples, all four weeks long:
 *
 *     Sunday 05 Jul 2026 -> Saturday 01 Aug 2026   (+27 days)
 *     Monday 06 Jul 2026 -> Sunday 02 Aug 2026     (+27 days)
 *
 * and the shorter blocks:
 *
 *     1 week  -> +6 days     2 weeks -> +13 days
 *     3 weeks -> +20 days    4 weeks -> +27 days
 *
 * The off-by-one is the whole bug. Adding `duration_weeks * 7` lands on the *next*
 * week's start day — a Sunday block ending on the following Sunday — which is why
 * a 4-week block used to end on Monday instead of Saturday, and why block 5 in
 * production ends on a Thursday.
 *
 * `mobile/src/utils/dateCalc.ts` is the client-side mirror of this file and must
 * stay in step with it: the forms derive their end dates here and the API
 * re-derives and re-validates them server-side, so a hand-edited request cannot
 * create a block that straddles a week boundary.
 *
 * ## Timezone handling
 *
 * Every function works on plain `YYYY-MM-DD` strings and does all arithmetic in
 * UTC (`Date.UTC` / `getUTC*`). The server runs in a UTC+3 timezone, where
 * `new Date('2026-07-05')` is parsed as UTC midnight and formatted locally as 05
 * July — but `new Date('2026-07-05T00:00:00')` is local midnight, which on a
 * host east of UTC serialises back as the *previous* day. Mixing the two is how
 * a Saturday end date silently becomes a Friday.
 */

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

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
];

/** `programs.week_start_day` is an enum of day names; index into DAY_NAMES. */
const DAY_INDEX = DAY_NAMES.reduce((map, name, index) => {
  map[name.toUpperCase()] = index;
  return map;
}, {});

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Coerce the several shapes a caller may send into a canonical day name.
 *
 * Accepts the MySQL enum ('SUNDAY'), a display name ('Sunday'), a three-letter
 * abbreviation ('Sun') and a numeric weekday (0 = Sunday, as `getDay()` returns).
 * Anything unrecognised returns null so callers can fall back to "derive it from
 * the start date" rather than guessing.
 *
 * @param {string|number|null|undefined} value
 * @returns {string|null} Canonical name such as 'SUNDAY'.
 */
function normalizeWeekStartDay(value) {
  if (value === undefined || value === null) return null;

  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= 6 ? DAY_NAMES[value] : null;
  }

  const text = String(value).trim().toUpperCase();
  if (!text) return null;
  if (DAY_INDEX[text] !== undefined) return DAY_NAMES[DAY_INDEX[text]];

  const byAbbreviation = DAY_NAMES.findIndex((name) => name.slice(0, 3).toUpperCase() === text.slice(0, 3));
  if (/^[A-Z]{2,3}$/.test(text) && byAbbreviation >= 0) return DAY_NAMES[byAbbreviation];

  return null;
}

/**
 * The day a block ends on: the day before the programme's week start.
 *
 * @param {string} weekStartDay
 * @returns {string} Canonical day name.
 */
function weekEndDay(weekStartDay) {
  const start = normalizeWeekStartDay(weekStartDay) ?? 'Sunday';
  return DAY_NAMES[(DAY_INDEX[start.toUpperCase()] + 6) % 7];
}

/**
 * Parse a strict `YYYY-MM-DD` string into UTC-midnight parts.
 *
 * Rejects impossible calendar dates, so `2026-02-31` fails here rather than
 * rolling forward into March the way the `Date` constructor does.
 *
 * @param {string|null|undefined} value
 * @returns {{year:number, month:number, day:number, index:number}|null}
 */
function parseCalendarDate(value) {
  if (value === undefined || value === null) return null;

  // Tolerate the ISO instants mysql2 hands back for DATE columns.
  const text = String(value).trim();
  const match = DATE_PATTERN.exec(text.slice(0, 10));
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

  return { year, month, day, index: time };
}

/**
 * Format UTC-midnight parts back to `YYYY-MM-DD`.
 *
 * @param {{year:number, month:number, day:number, index:number}} parts
 * @returns {string}
 */
function toCalendarDate(parts) {
  const year = String(parts.year).padStart(4, '0');
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** True when `value` is a real calendar date in `YYYY-MM-DD` form. */
function isCalendarDate(value) {
  return parseCalendarDate(value) !== null;
}

/** Day name for a date string, e.g. 'Sunday', or null when unparseable. */
function dayNameOf(value) {
  const parts = parseCalendarDate(value);
  return parts ? DAY_NAMES[new Date(parts.index).getUTCDay()] : null;
}

/**
 * Shift a date by whole days.
 *
 * @param {string} value - `YYYY-MM-DD`.
 * @param {number} days - May be negative.
 * @returns {string|null} `YYYY-MM-DD`, or null when the input is not a date.
 */
function addDays(value, days) {
  const parts = parseCalendarDate(value);
  if (!parts || !Number.isFinite(days)) return null;

  const shifted = new Date(parts.index + Math.round(days) * 86_400_000);
  return toCalendarDate({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    index: shifted.getTime(),
  });
}

/**
 * Whole days from `start` to `end`; negative when `end` precedes `start`.
 *
 * @returns {number|null}
 */
function diffDays(start, end) {
  const from = parseCalendarDate(start);
  const to = parseCalendarDate(end);
  if (!from || !to) return null;
  return Math.round((to.index - from.index) / 86_400_000);
}

/**
 * The end date of a block of `weeks` whole weeks starting at `startDate`.
 *
 * The single source of truth for the Sunday/Saturday (and Monday/Sunday)
 * boundary: the end is the last day *inside* the block, which is one day short
 * of the naive `weeks * 7` offset.
 *
 * @param {string} startDate - `YYYY-MM-DD`.
 * @param {number} weeks - Whole weeks, 1..13 in practice.
 * @returns {string|null} `YYYY-MM-DD`, or null for a bad date or a non-positive
 *   duration.
 */
function endDateForDuration(startDate, weeks) {
  const duration = Number(weeks);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return addDays(startDate, Math.round(duration) * 7 - 1);
}

/**
 * How many whole weeks a window spans, i.e. the `duration_weeks` that would
 * produce this window. A window of 27 days inclusive is 4 weeks; 28 days is not
 * a valid block at all.
 *
 * @returns {number|null}
 */
function durationWeeksBetween(startDate, endDate) {
  const days = diffDays(startDate, endDate);
  if (days === null || days < 0) return null;
  const span = days + 1;
  if (span % 7 !== 0) return null;
  return span / 7;
}

/**
 * Add whole months, clamping the day to the target month's length.
 *
 * Used for the supervisor evaluation period: a three-month posting that starts on
 * 31 August ends on 30 November, not 3 December.
 *
 * @param {string} value - `YYYY-MM-DD`.
 * @param {number} months
 * @returns {string|null}
 */
function addMonths(value, months) {
  const parts = parseCalendarDate(value);
  const count = Number(months);
  if (!parts || !Number.isFinite(count)) return null;

  const targetMonthIndex = parts.month - 1 + Math.trunc(count);
  const year = parts.year + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;

  // Day 0 of the next month is the last day of this one.
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(parts.day, lastDayOfMonth);

  return toCalendarDate({
    year,
    month: month + 1,
    day,
    index: Date.UTC(year, month, day),
  });
}

/** `Sun 05 Jul - Sat 01 Aug 2026`, the window shown in grid sub-headers. */
function describeWindow(startDate, endDate) {
  const from = parseCalendarDate(startDate);
  const to = parseCalendarDate(endDate);
  if (!from || !to) return '';

  const weekday = (parts) => DAY_NAMES[new Date(parts.index).getUTCDay()].slice(0, 3);
  const month = (parts) => MONTH_NAMES[parts.month - 1];
  const day = (parts) => String(parts.day).padStart(2, '0');

  // The trailing year is only spelled out when the window crosses one, so a
  // column heading stays two short fragments instead of four.
  if (from.year === to.year) {
    return `${weekday(from)} ${day(from)} ${month(from)} - ${weekday(to)} ${day(to)} ${month(to)} ${to.year}`;
  }
  return `${weekday(from)} ${day(from)} ${month(from)} ${from.year} - ${weekday(to)} ${day(to)} ${month(to)} ${to.year}`;
}

/**
 * Resolve and validate a block window from whatever the caller supplied.
 *
 * Accepted shapes, in order of authority:
 *   - `start_date` + `duration_weeks` -> the end date is derived.
 *   - `start_date` + `end_date`       -> the duration is derived and the end
 *                                        must be the last day inside the block.
 *   - all three                      -> they must agree with each other.
 *
 * `week_start_day` (from `programs`) is optional; when supplied it must match the
 * weekday of `start_date`, which is what stops a Sunday-start programme from
 * acquiring a Tuesday-start block.
 *
 * @param {object} input
 * @param {string} [input.start_date]
 * @param {string} [input.end_date]
 * @param {number|string} [input.duration_weeks]
 * @param {string} [input.week_start_day]
 * @returns {{
 *   start_date: string|null,
 *   end_date: string|null,
 *   duration_weeks: number|null,
 *   starts_on: string|null,
 *   ends_on: string|null,
 *   errors: string[]
 * }}
 */
function resolveBlockWindow(input = {}) {
  const errors = [];
  const { start_date: startDate, end_date: endDate, duration_weeks: rawWeeks } = input;

  const weekStart = normalizeWeekStartDay(input.week_start_day);
  const parsedStart = parseCalendarDate(startDate);

  if (!parsedStart) {
    errors.push('start_date must be a real date in YYYY-MM-DD form.');
  }

  const startsOn = parsedStart ? dayNameOf(startDate) : null;
  if (parsedStart && weekStart && startsOn !== weekStart) {
    errors.push(
      `This programme starts its week on ${weekStart}, so a block must start on ${weekStart} — ${startDate} is a ${startsOn}.`
    );
  }

  const requestedWeeks = rawWeeks === undefined || rawWeeks === null || rawWeeks === '' ? null : Number(rawWeeks);
  if (requestedWeeks !== null && (!Number.isInteger(requestedWeeks) || requestedWeeks <= 0)) {
    errors.push('duration_weeks must be a whole number of weeks above 0.');
  }

  const parsedEnd = parseCalendarDate(endDate);

  if (!parsedStart) {
    return { start_date: null, end_date: null, duration_weeks: null, starts_on: null, ends_on: null, errors };
  }

  // Derive whichever half the caller left out.
  let resolvedEnd = parsedEnd ? endDate : null;
  if (!resolvedEnd && requestedWeeks !== null) {
    resolvedEnd = endDateForDuration(startDate, requestedWeeks);
  }

  const spanWeeks = durationWeeksBetween(startDate, resolvedEnd);

  if (!resolvedEnd) {
    errors.push('Provide end_date or duration_weeks so the block length is known.');
  } else if (resolvedEnd < startDate) {
    errors.push('end_date must be on or after start_date.');
  } else if (spanWeeks === null) {
    errors.push(
      `A block is a whole number of weeks: ${diffDays(startDate, resolvedEnd) + 1} days is not one. Give a start date and a duration in weeks instead.`
    );
  }

  // All three supplied: they must not contradict each other.
  if (
    resolvedEnd &&
    parsedEnd &&
    requestedWeeks !== null &&
    Number.isInteger(requestedWeeks) &&
    resolvedEnd !== endDateForDuration(startDate, requestedWeeks)
  ) {
    errors.push(
      `end_date does not match a ${requestedWeeks}-week block from ${startDate}, which ends on ${endDateForDuration(
        startDate,
        requestedWeeks
      )}.`
    );
  }

  const durationWeeks = requestedWeeks !== null && Number.isInteger(requestedWeeks)
    ? requestedWeeks
    : spanWeeks;

  return {
    start_date: startDate,
    end_date: resolvedEnd,
    duration_weeks: durationWeeks,
    starts_on: startsOn,
    ends_on: resolvedEnd ? dayNameOf(resolvedEnd) : null,
    errors,
  };
}

module.exports = {
  DAY_NAMES,
  MONTH_NAMES,
  addDays,
  addMonths,
  dayNameOf,
  describeWindow,
  diffDays,
  durationWeeksBetween,
  endDateForDuration,
  isCalendarDate,
  normalizeWeekStartDay,
  parseCalendarDate,
  resolveBlockWindow,
  toCalendarDate,
  weekEndDay,
};