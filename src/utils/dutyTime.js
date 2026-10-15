/**
 * Duty-hour clock arithmetic, held at hours and minutes.
 *
 * Global GME timesheets (ACGME, NHS, GCC) are recorded to the minute: a shift
 * starts at 07:00, not 07:00:00. Seconds are therefore stripped on the way in
 * and the database stores a minute-precise wall clock, which keeps the stored
 * value, the API representation and the on-screen label all identical.
 *
 * A timesheet row covers **one calendar day**. A shift that runs past midnight
 * is written as two rows — `08:00` to `24:00` on the first day and `00:00` to
 * `08:00` on the next. `24:00` is therefore a first-class value: it is the end
 * of the shift day and normalises to the following midnight, which is the
 * largest instant the DATETIME column can hold for that row.
 *
 * The parser is deliberately tolerant — it accepts the ISO `T` separator and
 * an optional `:SS` tail, so a client that still sends seconds (or an Excel
 * cell typed as `07:00:00`) is understood rather than rejected.
 */

/** `YYYY-MM-DD HH:MM` and `YYYY-MM-DD HH:MM:SS`, `T` accepted. */
const FULL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
/** A bare `HH:MM` / `HH:MM:SS`, paired with the row's shift date. */
const TIME_ONLY = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** Minutes in a calendar day — also the parsed value of the `24:00` boundary. */
const MINUTES_PER_DAY = 24 * 60;

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

/** `YYYY-MM-DD` moved by whole days, staying a calendar day. */
function addDays(dateString, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateString));
  if (!match) return String(dateString);
  const moved = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/**
 * Parse a time-of-day cell (`HH:MM`, optional `:SS`) as minutes past midnight.
 *
 * `24:00` is accepted and returns `MINUTES_PER_DAY`: it is the explicit end of a
 * shift day, not an error. Anything past 24:00, or a non-time, returns `null` so
 * the caller can reject the row with a precise message.
 */
function parseTimeOfDay(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).trim().match(TIME_ONLY);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) return null;
  if (hours === 24 && minutes === 0) return MINUTES_PER_DAY;
  if (hours > 23) return null;
  return hours * 60 + minutes;
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

  let hh = Number(hours);
  const mm = Number(minutes);
  const ss = seconds === undefined ? 0 : Number(seconds);
  if (mm > 59 || ss > 59 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new DutyTimeError('Clock time', value);
  }

  // `24:00` closes the shift day; it lands on the next midnight.
  if (hh === 24 && mm === 0) {
    date = addDays(date, 1);
    hh = 0;
  } else if (hh > 23) {
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
 * Kept for callers that still hand `logAttendance` a single overnight span, so
 * the table's `clock_out >= clock_in` check is never violated by a night shift
 * entered as one row. The single-day timesheet path should split first instead.
 */
function resolveOvernightEnd(clockIn, clockOut) {
  if (!clockIn || !clockOut) return clockOut;
  if (clockOut >= clockIn) return clockOut;
  return `${addDays(clockOut.slice(0, 10), 1)} ${clockOut.slice(11)}`;
}

/** `YYYY-MM-DD HH:MM` — a stored `YYYY-MM-DD HH:MM:00` minus the seconds. */
function formatMinuteDateTime(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  return match ? `${match[1]} ${match[2]}:${match[3]}` : String(value);
}

/**
 * Group attendance rows into maximal continuous-duty chains.
 *
 * Rows are ordered by clock-in and a row joins the current chain when it starts
 * no later than the moment the chain currently ends — back-to-back or
 * overlapping. That is exactly how a 24-hour call written as a `08:00–24:00`
 * row plus the following day's `00:00–08:00` row is recognised as one
 * continuous period rather than two short ones.
 *
 * @param {{clock_in: string, clock_out: string, [key: string]: *}[]} logs
 * @returns {{logs: object[], start: number, end: number, totalHours: number}[]}
 *   `start`/`end` are epoch milliseconds; `totalHours` is the elapsed wall time
 *   of the chain, to two places.
 */
function continuousDutyChains(logs) {
  const stamped = (logs || [])
    .filter((log) => log && log.clock_in && log.clock_out)
    .map((log) => ({
      log,
      start: Date.parse(String(log.clock_in).replace(' ', 'T')),
      end: Date.parse(String(log.clock_out).replace(' ', 'T')),
    }))
    .filter((entry) => Number.isFinite(entry.start) && Number.isFinite(entry.end))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const chains = [];
  let current = null;

  for (const entry of stamped) {
    if (current && entry.start <= current.end) {
      current.end = Math.max(current.end, entry.end);
      current.entries.push(entry);
    } else {
      current = { start: entry.start, end: entry.end, entries: [entry] };
      chains.push(current);
    }
  }

  return chains.map((chain) => ({
    logs: chain.entries.map((entry) => entry.log),
    start: chain.start,
    end: chain.end,
    totalHours: Math.round(((chain.end - chain.start) / 3_600_000) * 100) / 100,
  }));
}

module.exports = {
  DutyTimeError,
  MINUTES_PER_DAY,
  addDays,
  parseTimeOfDay,
  normalizeClockTime,
  decimalHoursBetween,
  resolveOvernightEnd,
  formatMinuteDateTime,
  continuousDutyChains,
};
