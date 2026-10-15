const XLSX = require('xlsx');
const { makeBuffer } = require('./common');
const { parseTimeOfDay, MINUTES_PER_DAY, addDays } = require('../dutyTime');

/**
 * The monthly timesheet workbook: what a resident downloads to fill in, and
 * what the import parses back.
 *
 * **One row is one calendar day.** The row's `Shift Date` bounds its clock
 * times: `Clock In Time` and `Clock Out Time` are bare `HH:MM` values on that
 * day, and `24:00` is the explicit day boundary. A continuous 24-hour call is
 * therefore written as two rows — `08:00 → 24:00` on day one and `00:00 →
 * 08:00` on day two — so the hours attributed to each calendar day are the
 * hours actually worked on it.
 *
 * Two rules the file format has to honour:
 *
 *  1. **The headers are the ones the app promises.** The mobile client builds
 *     the same workbook locally when the API is unreachable, so a file made by
 *     either path must parse here. The column names are therefore fixed
 *     strings, not "whatever XLSX writes".
 *  2. **Parsing is tolerant, validation is not.** A coordinator who renames a
 *     header or leaves the seconds on a cell must still be understood — aliases
 *     and the time parser cover that — but a *row* whose clock-out lands before
 *     its clock-in (an unsplit overnight shift) is rejected with a message that
 *     says how to fix it, rather than silently producing negative hours.
 */

const HEADERS = [
  'Shift Date (YYYY-MM-DD)',
  'Attendance Status',
  'Clock In Time (HH:MM)',
  'Clock Out Time (HH:MM)',
  'Total Hours',
  'Notes',
];

const ATTENDANCE_STATUSES = [
  'PRESENT',
  'ABSENT',
  'ON_CALL',
  'SICK_LEAVE',
  'VACATION',
  'ANNUAL_LEAVE',
  'CASUAL_LEAVE',
  'EMERGENCY_LEAVE',
  'HAJJ_LEAVE',
  'ACADEMIC_LEAVE',
  'STUDY_LEAVE',
  'EXAM_LEAVE',
  'OTHER_LEAVE',
];

/** Normalised header → column index. Aliases keep renamed files readable. */
const HEADER_ALIASES = {
  shiftDate: ['shift date (yyyy-mm-dd)', 'shift date', 'date'],
  attendanceStatus: ['attendance status', 'status'],
  // The `Clock In Time` header is the current one; the older combined-stamp
  // spellings stay valid aliases so a workbook made before the format change
  // still imports — the parser keeps only the clock part of a full stamp.
  clockInTime: [
    'clock in time (hh:mm)',
    'clock in time',
    'clock in (hh:mm)',
    'clock in',
    'in time',
    'in',
  ],
  clockOutTime: [
    'clock out time (hh:mm)',
    'clock out time',
    'clock out (hh:mm)',
    'clock out',
    'out time',
    'out',
  ],
  totalHours: ['total hours', 'hours', 'duration'],
  notes: ['notes', 'note', 'comments', 'comment'],
};

function headerIndex(headers, keys) {
  const normalised = headers.map((header) => String(header ?? '').trim().toLowerCase());
  for (const key of keys) {
    const at = normalised.indexOf(key);
    if (at >= 0) return at;
  }
  return -1;
}

function generateTimesheetTemplate(sampleRows = []) {
  return makeBuffer(HEADERS, sampleRows, 'Timesheet');
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * Parse a clock cell as minutes past midnight.
 *
 * Accepts a bare `HH:MM` / `HH:MM:SS`, and also a legacy cell that still holds a
 * whole `YYYY-MM-DD HH:MM` stamp — the clock part is what a single-day row
 * wants. Returns `{ minutes }`, or `{ error }` describing why it was rejected.
 */
function readClockCell(value, label) {
  const text = String(value ?? '').trim();
  if (text === '') return { minutes: null };

  // Prefer a whole-cell time-of-day; fall back to the trailing `HH:MM` of a
  // full stamp so an un-split old workbook still yields its clock part.
  let parsed = parseTimeOfDay(text);
  if (parsed === null) {
    const tail = text.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*$/);
    if (tail) parsed = parseTimeOfDay(`${tail[1]}:${tail[2]}`);
  }

  if (parsed === null) {
    return { error: `${label} must be HH:MM (00:00–24:00)` };
  }
  return { minutes: parsed };
}

/** `YYYY-MM-DD` + minutes past midnight → `YYYY-MM-DD HH:MM:00`, `24:00` rolling over. */
function composeClock(shiftDate, minutes) {
  if (minutes === MINUTES_PER_DAY) return `${addDays(shiftDate, 1)} 00:00:00`;
  return `${shiftDate} ${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}:00`;
}

/** `2026-10-01`, or `null` when the cell is not that shape. */
function asIsoDate(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(`${match[0].slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : match[0].slice(0, 10);
}

/**
 * Parse and validate a timesheet upload.
 *
 * @returns {{rows: object[], errors: {row:number, field:string, message:string}[]}}
 *   `errors` is empty only when every row can be written as-is.
 */
function parseTimesheetFile(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The file has no readable sheet.');

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, blankrows: false });
  if (rows.length < 2) {
    throw new Error('The file needs a header row and at least one shift row.');
  }

  const headers = rows[0].map((header) => String(header ?? '').trim());
  const idx = {
    shiftDate: headerIndex(headers, HEADER_ALIASES.shiftDate),
    attendanceStatus: headerIndex(headers, HEADER_ALIASES.attendanceStatus),
    clockInTime: headerIndex(headers, HEADER_ALIASES.clockInTime),
    clockOutTime: headerIndex(headers, HEADER_ALIASES.clockOutTime),
    totalHours: headerIndex(headers, HEADER_ALIASES.totalHours),
    notes: headerIndex(headers, HEADER_ALIASES.notes),
  };

  if (idx.shiftDate < 0) {
    throw new Error(`Missing required column: ${HEADERS[0]}`);
  }

  const errors = [];
  const parsed = [];

  for (let i = 1; i < rows.length; i++) {
    const source = rows[i];
    const rowNumber = i + 1;

    // A completely blank line is not an error; it is how spreadsheets end.
    if (!source || !source.some((cell) => String(cell ?? '').trim() !== '')) continue;

    const cell = (key) => (idx[key] >= 0 ? source[idx[key]] : '');

    const shiftDate = asIsoDate(cell('shiftDate'));
    if (!shiftDate) {
      errors.push({
        row: rowNumber,
        field: 'Shift Date',
        message: String(cell('shiftDate') ?? '').trim() === '' ? 'is required' : 'must be YYYY-MM-DD',
      });
      continue;
    }

    const statusRaw = String(cell('attendanceStatus') ?? '')
      .trim()
      .toUpperCase()
      .replace(/[ -]+/g, '_');
    const attendanceStatus = statusRaw === '' ? 'PRESENT' : statusRaw;
    if (!ATTENDANCE_STATUSES.includes(attendanceStatus)) {
      errors.push({
        row: rowNumber,
        field: 'Attendance Status',
        message: `must be one of ${ATTENDANCE_STATUSES.join(', ')}`,
      });
      continue;
    }

    const clockIn = readClockCell(cell('clockInTime'), 'Clock In Time');
    if (clockIn.error) {
      errors.push({ row: rowNumber, field: 'Clock In Time', message: clockIn.error });
      continue;
    }
    if (clockIn.minutes === MINUTES_PER_DAY) {
      // `24:00` closes a shift day; it can never be the moment one starts.
      errors.push({ row: rowNumber, field: 'Clock In Time', message: 'must be before 24:00' });
      continue;
    }

    const clockOut = readClockCell(cell('clockOutTime'), 'Clock Out Time');
    if (clockOut.error) {
      errors.push({ row: rowNumber, field: 'Clock Out Time', message: clockOut.error });
      continue;
    }

    // Both halves present: the row must stay inside its own calendar day. An
    // out time at or before the in time is an overnight shift that has not been
    // split, so it is rejected with the fix rather than stored as negative.
    if (clockIn.minutes !== null && clockOut.minutes !== null) {
      if (clockOut.minutes <= clockIn.minutes) {
        errors.push({
          row: rowNumber,
          field: 'Clock Out Time',
          message: 'must be after Clock In Time on the same day; split an overnight shift across two rows',
        });
        continue;
      }
    }

    const clockInStamp = clockIn.minutes === null ? null : composeClock(shiftDate, clockIn.minutes);
    const clockOutStamp = clockOut.minutes === null ? null : composeClock(shiftDate, clockOut.minutes);

    const hoursRaw = String(cell('totalHours') ?? '').trim();
    let totalHours = null;
    if (hoursRaw !== '') {
      const value = Number(hoursRaw);
      if (!Number.isFinite(value) || value < 0) {
        errors.push({ row: rowNumber, field: 'Total Hours', message: 'must be a number of hours' });
        continue;
      }
      totalHours = value;
    } else if (clockInStamp && clockOutStamp) {
      // Derived rather than left blank: the row has both stamps, so the
      // duration is a fact, not a guess.
      totalHours = Math.round(((Date.parse(clockOutStamp) - Date.parse(clockInStamp)) / 36e5) * 100) / 100;
    }

    parsed.push({
      row: rowNumber,
      shift_date: shiftDate,
      attendance_status: attendanceStatus,
      clock_in: clockInStamp,
      clock_out: clockOutStamp,
      total_hours: totalHours,
      notes: idx.notes >= 0 ? String(source[idx.notes] ?? '').trim() || null : null,
    });
  }

  if (parsed.length === 0 && errors.length === 0) {
    throw new Error('No shift rows were found under the header.');
  }

  return { rows: parsed, errors };
}

module.exports = {
  ATTENDANCE_STATUSES,
  HEADERS,
  generateTimesheetTemplate,
  parseTimesheetFile,
};
