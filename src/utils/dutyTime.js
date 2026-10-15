/**
 * Duty-hour clock-in / clock-out arithmetic, held at hours and minutes.
 *
 * Global GME timesheets (ACGME, NHS, GCC) are recorded to the minute: a shift
 * starts at 07:00, not 07:00:00. Seconds are therefore stripped on the way in
 * and the database stores a minute-precise wall clock, which keeps the stored
 * value, the API representation and the on-screen label all identical.
 *
 * The parser is deliberately tolerant — it accepts the ISO `T` separator and
 * an optional `:SS` tail, so a client that still sends seconds (or an Excel
 * cell typed as `07:00:00`) is understood rather than rejected.
 */

/** `YYYY-MM-DD HH:MM` and `YYYY-MM-DD HH:MM:SS`, `T` accepted. */
const FULL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
/** A bare `HH:MM` / `HH:MM:SS`, paired with the row's shift date. */
const TIME_ONLY = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** A clock value that is present but not a usable time. */
class DutyTimeError extends Error {
  constructor(field, value) {
    super(`${field} must be YYYY-MM-DD HH:MM or HH:MM, got "${value}".`);
    this.name = 'DutyTimeError';
    this.statusCode = 400;
  }
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * Normalise a clock-in / clock-out value to `YYYY-MM-DD HH:MM:00`.
 *
 * @param {*} value  Raw value from a request body or an Excel cell.
 * @param {string} [fallbackDate]  `YYYY-MM-DD` used when `value` is time-only.
 * @returns {string|null}  The normalised timestamp, or `null` when absent.
 * @throws {DutyTimeError}  When the value is present but unparseable.
 */
function normalizeClockTime(value, fallbackDate) {
  if (value === null || value === undefined) return null;

  const text = String(value).trim();
  if (text === '') return null;

  const normalised = text.replace('T', ' ');

  let date;
  let hours;
  let minutes;
  let seconds;

  const full = FULL_DATE_TIME.exec(normalised);
  if (full) {
    [, date, hours, minutes, seconds] = full;
  } else {
    const timeOnly = TIME_ONLY.exec(normalised);
    if (timeOnly && fallbackDate) {
      date = String(fallbackDate).trim().slice(0, 10);
      [, hours, minutes, seconds] = timeOnly;
    } else {
      throw new DutyTimeError('Clock time', value);
    }
  }

  const hh = Number(hours);
  const mm = Number(minutes);
  const ss = seconds === undefined ? 0 : Number(seconds);
  if (hh > 23 || mm > 59 || ss > 59 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new DutyTimeError('Clock time', value);
  }

  // Seconds are intentionally discarded: duty hours live at minute precision.
  return `${date} ${pad(hh)}:${pad(mm)}:00`;
}

/**
 * Decimal hours between two normalised timestamps, to two places.
 *
 * An end earlier than the start is read as an overnight shift (`20:00` to
 * `06:00` is ten hours), matching the mobile calculator so both agree on what
 * was logged. Callers that persist the span should send it through
 * `resolveOvernightEnd` first so the stored columns stay ordered.
 *
 * @returns {number|null}  `null` when either stamp is missing.
 */
function decimalHoursBetween(start, end) {
  if (!start || !end) return null;

  const startMs = Date.parse(String(start).replace(' ', 'T'));
  const endMs = Date.parse(String(end).replace(' ', 'T'));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  let hours = (endMs - startMs) / 3_600_000;
  if (hours < 0) hours += 24;
  return Math.round(hours * 100) / 100;
}

/**
 * Move an end stamp that precedes its start onto the following day.
 *
 * Overnight duty is the norm in GME, but the table enforces
 * `clock_out >= clock_in`. A resident who enters `20:00` then `06:00` means a
 * ten-hour night shift, so the end is rolled one day forward rather than
 * rejected; a duration of "minus fourteen hours" is never what was meant.
 */
function resolveOvernightEnd(clockIn, clockOut) {
  if (!clockIn || !clockOut) return clockOut;
  if (clockOut >= clockIn) return clockOut;

  const [date, time] = clockOut.split(' ');
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(year, month - 1, day + 1);
  const nextDate = [
    next.getFullYear(),
    pad(next.getMonth() + 1),
    pad(next.getDate()),
  ].join('-');

  return `${nextDate} ${time}`;
}

/** `YYYY-MM-DD HH:MM` — a stored `YYYY-MM-DD HH:MM:00` minus the seconds. */
function formatMinuteDateTime(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  return match ? `${match[1]} ${match[2]}:${match[3]}` : String(value);
}

module.exports = {
  DutyTimeError,
  normalizeClockTime,
  decimalHoursBetween,
  resolveOvernightEnd,
  formatMinuteDateTime,
};
