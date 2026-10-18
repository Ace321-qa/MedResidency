/**
 * The CCC template payload, built from the live database.
 *
 * The mobile app builds the identical payload in
 * `mobile/src/utils/cccTemplate.ts` from the schedule it has already loaded;
 * this module rebuilds it server-side so the GET form of the template endpoint
 * (and the PDF export) can serve a coordinator who never had a session with the
 * API. One payload feeds three artefacts — the workbook, the PDF and the
 * import round-trip — so every label here is the label the parser matches.
 *
 * The shape, field for field, is `CccTemplatePayload` in the TypeScript module.
 * `mobile/scripts/verify-ccc-matrix.ts` builds both and asserts they agree.
 */

const db = require('../config/db');
const LongitudinalService = require('./longitudinalService');
const {
  CCC_BANNER_KEYS,
  CCC_MATRIX_LEAVES_HEADER,
  CCC_METADATA_KEYS,
  cccBannerDateLabel,
  cccDayLabel,
  cccFullDateLabel,
  cccFormatFacultyName,
  cccLeaveTypeLabel,
  cccTemplateBanner: cccTemplateBannerLocal,
  canonicalDayName,
  normalizeShiftLabel,
} = require('../utils/excel/ccc');

const WEEK_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The pool rows the metadata sheet prints, in print order. */
const BACKUP_POOL_DAYS = ['Sunday', 'Monday', 'Wednesday'];

/**
 * The rotation window a cycle carries when it has never saved one — the same
 * untouched draft the screen starts with, so both sides print `12 Weeks
 * (3 Months)` for a fresh cycle.
 */
const DEFAULT_ROTATION_MONTHS = 3;

/* -------------------------------------------------------------------------- *
 * Calendar helpers — strict `YYYY-MM-DD`, arithmetic in UTC, never `Date` local
 * components: the server sits east of UTC and a local read shifts the calendar.
 * -------------------------------------------------------------------------- */

function calendarParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function addDays(value, days) {
  const parts = calendarParts(value);
  if (!parts || !Number.isFinite(days)) return null;
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + Math.round(days) * 86400000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function dayNameOf(value) {
  const parts = calendarParts(value);
  if (!parts) return null;
  return WEEK_DAYS[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()];
}

function weekDaySequence(startDate) {
  const start = dayNameOf(startDate) ?? 'Sunday';
  const startIndex = WEEK_DAYS.indexOf(start);
  return Array.from({ length: 7 }, (_, offset) => WEEK_DAYS[(startIndex + offset) % 7]);
}

function weekDayDate(startDate, offset) {
  const index = Number(offset);
  if (!calendarParts(startDate) || !Number.isInteger(index) || index < 0 || index > 6) return null;
  return addDays(startDate, index);
}

/** The `10:30 - 2:00` / `07:00 - 2:00` defaults, matching the screen's. */
function defaultShiftForDay(day) {
  return day === 'Tuesday' || day === 'Thursday' ? '07:00 - 2:00' : '10:30 - 2:00';
}

/** The `PGY-3` / `PGY-2` / `PGY-1` / `FMC` defaults, matching the screen's. */
function defaultPgyForDay(day) {
  switch (day) {
    case 'Sunday':
      return 'PGY-3';
    case 'Monday':
      return 'PGY-2';
    case 'Wednesday':
      return 'PGY-1';
    default:
      return 'FMC';
  }
}

function describeDuration(totalWeeks, rotationMonths) {
  const weeks =
    totalWeeks != null && Number.isFinite(totalWeeks) && totalWeeks > 0 ? Number(totalWeeks) : null;
  const months =
    rotationMonths != null && Number.isFinite(rotationMonths) && rotationMonths > 0
      ? Number(rotationMonths)
      : null;
  if (weeks == null && months == null) return '';
  const weekText = weeks == null ? '' : `${weeks} ${weeks === 1 ? 'Week' : 'Weeks'}`;
  const monthText = months == null ? '' : `${months} ${months === 1 ? 'Month' : 'Months'}`;
  return weekText && monthText ? `${weekText} (${monthText})` : weekText || monthText;
}

function positiveNumber(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/* -------------------------------------------------------------------------- *
 * Payload construction.
 * -------------------------------------------------------------------------- */

async function loadProgramLabel(programId) {
  try {
    const [rows] = await db.query('SELECT program_code, program_name FROM programs WHERE id = ?', [programId]);
    return rows[0] || null;
  } catch (error) {
    return null;
  }
}

/**
 * The most recent randomisation rationale a coordinator wrote for the programme.
 *
 * Best-effort: the audit table is created on demand by the randomiser, so a
 * programme that has never randomised simply has no rationale yet.
 */
async function latestRationale(programId) {
  try {
    const [rows] = await db.query(
      `SELECT rationale FROM primary_care_rotation_audit
        WHERE program_id = ? AND rationale IS NOT NULL AND TRIM(rationale) <> ''
        ORDER BY id DESC LIMIT 1`,
      [programId],
    );
    return rows[0]?.rationale || '';
  } catch (error) {
    return '';
  }
}

function clinicColumnsOf(rawColumns) {
  return [...(rawColumns ?? [])]
    .filter((entry) => Number(entry.clinic_number) >= 1)
    .sort((a, b) => Number(a.clinic_number) - Number(b.clinic_number))
    .map((entry) => ({
      clinicNumber: Number(entry.clinic_number),
      title: String(entry.label ?? '').trim() || `Clinic ${entry.clinic_number}`,
      isLeaves: false,
    }));
}

/** The weekdays that actually have a stored row, in rotation order. */
function activeDaysOf(headers, sequence) {
  const seen = new Set();
  for (const header of headers ?? []) {
    const name = canonicalDayName(header.day_of_week);
    if (name) seen.add(name);
  }
  if (seen.size === 0) return sequence;
  return sequence.filter((day) => seen.has(day));
}

function buildDay(day, schedule, columns, sequence, weekStartDate) {
  const header = (schedule.dailyHeaders ?? []).find(
    (candidate) => canonicalDayName(candidate.day_of_week) === day,
  );
  const offset = sequence.indexOf(day);
  const date = offset >= 0 ? weekDayDate(weekStartDate || null, offset) ?? '' : '';

  const shift = normalizeShiftLabel(header?.shift_time) || defaultShiftForDay(day);
  const pgy = String(header?.pgy_level ?? '').trim() || defaultPgyForDay(day);
  const inCharge = cccFormatFacultyName(header?.in_charge_faculty_name);

  const cells = columns.map((column) => {
    if (column.isLeaves) {
      const away = (schedule.absences ?? []).filter(
        (row) => canonicalDayName(row.day_of_week) === day,
      );
      const seenTypes = [];
      for (const row of away) {
        const label = cccLeaveTypeLabel(row.leave_type);
        if (label && !seenTypes.includes(label)) seenTypes.push(label);
      }
      return {
        clinicNumber: column.clinicNumber,
        title: column.title,
        isLeaves: true,
        residents: away.map((row) => row.person_name),
        faculty: null,
        leaveTypes: seenTypes,
      };
    }

    const slot = (schedule.slots ?? []).find(
      (candidate) =>
        candidate.daily_header_id === header?.id &&
        Number(candidate.clinic_number) === column.clinicNumber,
    );
    const residents = [slot?.resident_1_name, slot?.resident_2_name].filter(
      (name) => Boolean(String(name ?? '').trim()),
    );
    return {
      clinicNumber: column.clinicNumber,
      title: column.title,
      isLeaves: false,
      residents,
      faculty: cccFormatFacultyName(slot?.faculty_name),
      leaveTypes: [],
    };
  });

  return { day, date, shift, pgy, inCharge, cells };
}

function backupPoolsOf(schedule) {
  const pools = [];
  for (const day of BACKUP_POOL_DAYS) {
    const entries = (schedule.backups?.[day] ?? [])
      .slice()
      .sort((a, b) => Number(a.priority_order ?? 0) - Number(b.priority_order ?? 0));
    const names = entries
      .map((entry) => String(entry.faculty_name ?? '').trim())
      .filter((name) => name.length > 0);
    if (names.length > 0) pools.push({ day, names });
  }
  return pools;
}

/**
 * Build the one payload every CCC artefact renders from.
 *
 * @param {object} options
 * @param {number} options.programId
 * @param {number} [options.cycleId] a specific cycle; the programme's latest otherwise.
 * @param {'matrix'|'roster'} [options.viewMode]
 * @param {number|null} [options.rotationMonths] the screen's live draft window.
 * @param {string|null} [options.rationale] the screen's live rationale text.
 * @returns {Promise<object>} the `CccTemplatePayload`.
 */
async function buildCccTemplatePayload(options = {}) {
  const programId = Number(options.programId);
  if (!Number.isInteger(programId) || programId <= 0) {
    const error = new Error('program_id is required to build the CCC template.');
    error.statusCode = 400;
    throw error;
  }

  const schedule = await LongitudinalService.getCycleSchedule(programId, {
    cycleId: options.cycleId ?? null,
  });
  const cycle = schedule.cycle || {};
  const weekStartDate = String(cycle.start_date ?? '').trim();
  const sequence = weekDaySequence(weekStartDate || null);
  const activeDays = activeDaysOf(schedule.dailyHeaders, sequence);

  const clinicColumns = clinicColumnsOf(schedule.columns);
  const columns = [
    ...clinicColumns,
    { clinicNumber: 0, title: CCC_MATRIX_LEAVES_HEADER, isLeaves: true },
  ];

  const rotationMonthsRaw = options.rotationMonths ?? cycle.rotation_window_months ?? DEFAULT_ROTATION_MONTHS;
  const rotationMonths = positiveNumber(rotationMonthsRaw);
  const totalWeeksRaw = (rotationMonths != null ? rotationMonths * 4 : null) ?? cycle.total_weeks ?? null;
  const totalWeeks = positiveNumber(totalWeeksRaw);

  const startDayName = dayNameOf(weekStartDate) ?? activeDays[0] ?? 'Sunday';
  const weekEndDate = weekDayDate(weekStartDate || null, 6) ?? '';

  const program = await loadProgramLabel(programId);
  const rationale =
    String(options.rationale ?? '').trim() || (await latestRationale(programId));

  const days = activeDays.map((day) => buildDay(day, schedule, columns, sequence, weekStartDate));

  return {
    viewMode: options.viewMode === 'roster' ? 'roster' : 'matrix',
    programLabel: String(program?.program_name ?? '').trim() || 'Programme',
    programCode: program?.program_code ?? null,
    academicYear:
      String(cycle.academic_year ?? '').trim() || cccFullDateLabel(weekStartDate),
    cycleNumber: String(cycle.cycle_number ?? '').trim() || 'Cycle 1',
    weekNumber: String(cycle.week_number ?? '').trim() || 'Week 1',
    weekStartDate: weekStartDate ? cccBannerDateLabel(startDayName, weekStartDate) : '',
    weekEndDate: weekEndDate ? cccBannerDateLabel(dayNameOf(weekEndDate) ?? '', weekEndDate) : '',
    rotationMonths,
    totalWeeks,
    durationLabel: describeDuration(totalWeeks, rotationMonths),
    rationale,
    columns,
    days,
    backupPools: backupPoolsOf(schedule),
  };
}

/** The payload expressed as the banner the workbook prints on row 1. */


module.exports = {
  DEFAULT_ROTATION_MONTHS,
  BACKUP_POOL_DAYS,
  buildCccTemplatePayload,
  cccTemplateBanner: cccTemplateBannerLocal,
  canonicalDayName,
  cccDayLabel,
  cccBannerDateLabel,
  cccFullDateLabel,
  cccFormatFacultyName,
  cccLeaveTypeLabel,
  normalizeShiftLabel,
  describeDuration,
  weekDaySequence,
  weekDayDate,
  dayNameOf,
  CCC_METADATA_KEYS,
};
