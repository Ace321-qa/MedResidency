const XLSX = require('xlsx');
const { makeBuffer } = require('./common');

/**
 * The monthly timesheet workbook: what a resident downloads to fill in, and
 * what the import parses back.
 *
 * Two rules the file format has to honour:
 *
 *  1. **The headers are the ones the app promises.** The mobile client builds
 *     the same workbook locally when the API is unreachable, so a file made by
 *     either path must parse here. The column names are therefore fixed
 *     strings, not "whatever XLSX writes".
 *  2. **Parsing is tolerant, validation is not.** A coordinator who renames a
 *     header to "Date" or adds a space must still be understood — header
 *     aliases cover that — but a *row* with a missing or malformed value comes
 *     back as `Row 4: Shift Date is required` rather than being silently
 *     dropped. Silent dropping is how a month of attendance quietly goes
 *     missing.
 */

const HEADERS = [
  'Shift Date (YYYY-MM-DD)',
  'Attendance Status',
  'Clock In (YYYY-MM-DD HH:MM:SS)',
  'Clock Out (YYYY-MM-DD HH:MM:SS)',
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
  clockIn: ['clock in (yyyy-mm-dd hh:mm:ss)', 'clock in', 'in'],
  clockOut: ['clock out (yyyy-mm-dd hh:mm:ss)', 'clock out', 'out'],
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

/** `2026-10-01`, or `null` when the cell is not that shape. */
function asIsoDate(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(`${match[0].slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : match[0].slice(0, 10);
}

/** `2026-10-01 08:00:00`, or `null`. Accepts a `T` separator too. */
function asDateTime(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace('T', ' ');
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[ ](\d{1,2}:\d{2}(:\d{2})?)$/);
  if (!match) return null;
  const time = match[2].split(':');
  const hh = String(Number(time[0])).padStart(2, '0');
  const mm = String(time[1]).padStart(2, '0');
  const ss = time[2] ? String(time[2]).padStart(2, '0') : '00';
  return `${match[1]} ${hh}:${mm}:${ss}`;
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
    clockIn: headerIndex(headers, HEADER_ALIASES.clockIn),
    clockOut: headerIndex(headers, HEADER_ALIASES.clockOut),
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

    const clockIn = asDateTime(cell('clockIn'));
    const clockInRaw = String(cell('clockIn') ?? '').trim();
    if (clockInRaw !== '' && !clockIn) {
      errors.push({
        row: rowNumber,
        field: 'Clock In',
        message: 'must be YYYY-MM-DD HH:MM:SS',
      });
      continue;
    }

    const clockOut = asDateTime(cell('clockOut'));
    const clockOutRaw = String(cell('clockOut') ?? '').trim();
    if (clockOutRaw !== '' && !clockOut) {
      errors.push({
        row: rowNumber,
        field: 'Clock Out',
        message: 'must be YYYY-MM-DD HH:MM:SS',
      });
      continue;
    }
    if (clockIn && clockOut && clockOut < clockIn) {
      errors.push({ row: rowNumber, field: 'Clock Out', message: 'cannot be before Clock In' });
      continue;
    }

    const hoursRaw = String(cell('totalHours') ?? '').trim();
    let totalHours = null;
    if (hoursRaw !== '') {
      const value = Number(hoursRaw);
      if (!Number.isFinite(value) || value < 0) {
        errors.push({ row: rowNumber, field: 'Total Hours', message: 'must be a number of hours' });
        continue;
      }
      totalHours = value;
    } else if (clockIn && clockOut) {
      // Derived rather than left blank: the file has both stamps, so the
      // duration is a fact, not a guess.
      totalHours = Math.round(((Date.parse(clockOut) - Date.parse(clockIn)) / 36e5) * 100) / 100;
    }

    parsed.push({
      row: rowNumber,
      shift_date: shiftDate,
      attendance_status: attendanceStatus,
      clock_in: clockIn,
      clock_out: clockOut,
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
