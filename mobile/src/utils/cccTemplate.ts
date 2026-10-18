/**
 * The Continuity of Care Clinics (CCC) template payload and the exact Excel
 * layout both the client and the server build from it.
 *
 * A coordinator downloads the template from the CCC screen, fills it in on a
 * laptop and uploads it back; the import endpoint then writes the same cells
 * the screen itself would have written. That round trip only holds if three
 * things are true:
 *
 *  1. The workbook mirrors the live app state — the programme's own clinic
 *     columns, the cycle's day rows, the Leave column and the backup pools —
 *     rather than a fixed five-sample-row sheet that never matches anything.
 *  2. Every label the file uses is the same label the screen uses, so a cell
 *     the coordinator recognises on the phone is the cell the parser reads.
 *  3. The layout is data, not markup: `buildCccTemplatePayload` produces one
 *     plain payload and `matrixSheetRows` / `rosterSheetRows` /
 *     `metadataSheetRows` turn it into cells. The server carries an identical
 *     mirror in `src/utils/excel/ccc.js`, and `verify-ccc-matrix.ts` asserts
 *     the two agree cell for cell.
 *
 * Nothing in this module touches React, the API client or the database: it is
 * pure shaping, so it can be unit-checked in plain Node and reused by the
 * offline download fallback.
 */

import { weekdayIndex, weekdayName } from './cccMatrix';
import { dayNameOf, weekDayDate, weekDaySequence, type DayName } from './dateCalc';
import { rotationWindowForMonths } from './masterGridCalendar';
import type {
  PrimaryCareAbsence,
  PrimaryCareClinicSlot,
  PrimaryCareCycleSchedule,
  PrimaryCareMatrixColumn,
} from '../types/api';

/** Which of the two workbook layouts the payload is shaped for. */
export type CccTemplateViewMode = 'matrix' | 'roster';

/** One column of the grid: a numbered clinic position, or the Leaves column. */
export interface CccTemplateColumn {
  /** `1..N` for clinic columns; `0` marks the Leaves column. */
  clinicNumber: number;
  /** Coordinator label, or `Clinic <n>`; `Leaves / Away` for the leave column. */
  title: string;
  isLeaves: boolean;
}

/** One cell of one day row. */
export interface CccTemplateCell {
  clinicNumber: number;
  title: string;
  isLeaves: boolean;
  /** Resident names for a clinic cell, or the away names for the leave cell. */
  residents: string[];
  faculty: string | null;
  /** Leave cell only: humanised leave types, e.g. `Sick Leave`. */
  leaveTypes: string[];
}

/** One day row of the matrix, in the cycle's own rotation order. */
export interface CccTemplateDay {
  day: string;
  /** `YYYY-MM-DD`, empty when the cycle has no usable start date. */
  date: string;
  /** Stored shift, normalised to `10:30 - 2:00`. */
  shift: string;
  /** `PGY-2`, `FMC`, … */
  pgy: string;
  inCharge: string | null;
  cells: CccTemplateCell[];
}

/** One backup / catchup pool, e.g. `Sunday catchup: Dr. A, Dr. B`. */
export interface CccTemplateBackupPool {
  day: string;
  names: string[];
}

export interface CccTemplatePayload {
  viewMode: CccTemplateViewMode;
  programLabel: string;
  programCode: string | null;
  academicYear: string;
  cycleNumber: string;
  weekNumber: string;
  weekStartDate: string;
  weekEndDate: string;
  rotationMonths: number | null;
  totalWeeks: number | null;
  /** `12 Weeks (3 Months)`, exactly as the banner prints it. */
  durationLabel: string;
  rationale: string;
  columns: CccTemplateColumn[];
  days: CccTemplateDay[];
  backupPools: CccTemplateBackupPool[];
}

/* -------------------------------------------------------------------------- *
 * The labels both sides agree on. Changing a string here changes the parser.
 * -------------------------------------------------------------------------- */

export const CCC_TEMPLATE_SHEET_MATRIX = 'CCC Matrix';
export const CCC_TEMPLATE_SHEET_ROSTER = 'CCC Roster';
export const CCC_TEMPLATE_SHEET_METADATA = 'Metadata';

/** Matrix sheet row 2, in column order. */
export const CCC_MATRIX_DAY_HEADER = 'DAY / SHIFT & PGY';
export const CCC_MATRIX_IN_CHARGE_HEADER = 'IN-CHARGE FACULTY';
export const CCC_MATRIX_LEAVES_HEADER = 'Leaves / Away';
export const CCC_MATRIX_HEADERS = [CCC_MATRIX_DAY_HEADER, CCC_MATRIX_IN_CHARGE_HEADER];

/** Roster sheet row 2, in column order. */
export const CCC_ROSTER_DAY_HEADER = 'Day / Time & Session';
export const CCC_ROSTER_CLINIC_HEADER = 'Clinic Slot';
export const CCC_ROSTER_RESIDENTS_HEADER = 'Resident(s) & PGY Level';
export const CCC_ROSTER_FACULTY_HEADER = 'Supervising Faculty';
export const CCC_ROSTER_HEADERS = [
  CCC_ROSTER_DAY_HEADER,
  CCC_ROSTER_CLINIC_HEADER,
  CCC_ROSTER_RESIDENTS_HEADER,
  CCC_ROSTER_FACULTY_HEADER,
];

/** The placeholder a cell carries until a coordinator assigns someone. */
export const CCC_UNASSIGNED = 'Unassigned';
/** The leave cell's value when nobody is away that day. */
export const CCC_NO_LEAVE = 'No leave';

/** The metadata sheet's two section headings. */
export const CCC_METADATA_POOLS_HEADING = 'BACKUP / CATCHUP FACULTY POOLS';
export const CCC_METADATA_RATIONALE_HEADING = 'ROTATION WINDOW & RATIONALE';

/** Banner key prefixes, matched case-insensitively by the metadata parser. */
export const CCC_BANNER_KEYS = {
  academicYear: 'Academic Year',
  cycle: 'Cycle',
  weekStartDate: 'Week Start Date',
  weekEndDate: 'Week End Date',
  duration: 'Duration / Window',
} as const;

/** Metadata sheet key/value pairs, in print order. */
export const CCC_METADATA_KEYS = {
  academicYear: 'Academic Year',
  cycle: 'Cycle Number',
  weekNumber: 'Week Number',
  weekStartDate: 'Week Start Date',
  weekEndDate: 'Week End Date',
  duration: 'Duration / Rotation Window',
  rationale: 'Rationale',
  backupPools: 'Backup / Catchup Faculty Pools',
} as const;

/* -------------------------------------------------------------------------- *
 * Formatting helpers — pure, timezone-free, and mirrored in ccc.js.
 * -------------------------------------------------------------------------- */

const MONTHS_SHORT = [
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

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const BACKUP_POOL_DAYS: readonly DayName[] = ['Sunday', 'Monday', 'Wednesday'];

/** Strict `YYYY-MM-DD` parts, or null. No `Date`, so no timezone can shift it. */
function calendarParts(value: string | null | undefined): { day: number; month: number; year: number } | null {
  const trimmed = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { day, month, year };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `12 Oct` — the day column's short date. */
export function cccDayDateLabel(date: string | null | undefined): string {
  const parts = calendarParts(date);
  if (!parts) return '';
  return `${pad(parts.day)} ${MONTHS_SHORT[parts.month - 1]}`;
}

/** `12 Oct 2026` — the banner's full date. */
export function cccFullDateLabel(date: string | null | undefined): string {
  const parts = calendarParts(date);
  if (!parts) return '';
  return `${pad(parts.day)} ${MONTHS_SHORT[parts.month - 1]} ${parts.year}`;
}

/** `Mon 12 Oct` — the day column's day label. */
export function cccDayLabel(day: string, date: string | null | undefined): string {
  const weekday = weekdayIndex(day);
  const short = weekday >= 0 ? WEEKDAY_SHORT[weekday] : String(day ?? '').trim().slice(0, 3);
  const dateLabel = cccDayDateLabel(date);
  return dateLabel ? `${short} ${dateLabel}` : short;
}

/** `Mon 12 Oct 2026` — the banner's day-and-date fragment. */
export function cccBannerDateLabel(day: string, date: string | null | undefined): string {
  const weekday = weekdayIndex(day);
  const short = weekday >= 0 ? WEEKDAY_SHORT[weekday] : String(day ?? '').trim().slice(0, 3);
  const dateLabel = cccFullDateLabel(date);
  return dateLabel ? `${short} ${dateLabel}` : short;
}

/**
 * A stored shift written the way the app writes it: one ASCII hyphen, single
 * spaces, e.g. `10:30 - 2:00`. The en dash the curriculum renders is normalised
 * away so a workbook built on one device parses on the server the same way.
 */
export function normalizeShiftLabel(shift: string | null | undefined): string {
  return String(shift ?? '')
    .trim()
    .replace(/[–—−]/g, '-')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s{2,}/g, ' ');
}

/** A single, and only a single, `Dr. ` title on a faculty display name. */
export function cccFormatFacultyName(name: string | null | undefined): string {
  const base = String(name ?? '')
    .trim()
    .replace(/^Dr\.?\s+/i, '')
    .trim();
  return base ? `Dr. ${base}` : '';
}

/** `SICK_LEAVE` -> `Sick Leave`. */
export function cccLeaveTypeLabel(value: string | null | undefined): string {
  if (!value) return 'Leave';
  return String(value)
    .toLowerCase()
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** The matrix cell's text: `Dr. A & Dr. B / Dr. Faculty`, or `Unassigned`. */
export function cccCellText(cell: CccTemplateCell): string {
  if (cell.isLeaves) {
    if (cell.residents.length === 0) return CCC_NO_LEAVE;
    return cell.residents.join(', ');
  }
  const names = cell.residents.length > 0 ? cell.residents.join(' & ') : CCC_UNASSIGNED;
  return cell.faculty ? `${names} / ${cell.faculty}` : names;
}

/** The roster cell's resident text: `Dr. A & Dr. B / PGY-2`. */
export function cccRosterResidentsText(cell: CccTemplateCell, pgy: string): string {
  if (cell.residents.length === 0) return CCC_UNASSIGNED;
  return `${cell.residents.join(' & ')} / ${pgy}`;
}

/** The banner: one pipe-separated line spanning the whole sheet. */
export function cccTemplateBanner(payload: CccTemplatePayload): string {
  const parts = [
    `${CCC_BANNER_KEYS.academicYear}: ${payload.academicYear}`,
    `${CCC_BANNER_KEYS.cycle}: ${payload.cycleNumber}`,
    `${CCC_BANNER_KEYS.weekStartDate}: ${payload.weekStartDate}`,
    `${CCC_BANNER_KEYS.weekEndDate}: ${payload.weekEndDate}`,
    `${CCC_BANNER_KEYS.duration}: ${payload.durationLabel}`,
  ];
  return parts.join(' | ');
}

/* -------------------------------------------------------------------------- *
 * Payload construction from a loaded cycle schedule.
 * -------------------------------------------------------------------------- */

/** The `10:30 - 2:00` / `07:00 - 2:00` defaults, matching the server's. */
function defaultShiftForDay(day: string): string {
  return day === 'Tuesday' || day === 'Thursday' ? '07:00 - 2:00' : '10:30 - 2:00';
}

/** The `PGY-3` / `PGY-2` / `PGY-1` / `FMC` defaults, matching the server's. */
function defaultPgyForDay(day: string): string {
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

function describeDuration(totalWeeks: number | null, rotationMonths: number | null): string {
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

function clinicColumnsOf(raw: PrimaryCareMatrixColumn[] | undefined): CccTemplateColumn[] {
  return [...(raw ?? [])]
    .filter((entry) => Number(entry.clinic_number) >= 1)
    .sort((a, b) => Number(a.clinic_number) - Number(b.clinic_number))
    .map((entry) => ({
      clinicNumber: Number(entry.clinic_number),
      title: entry.label?.trim() || `Clinic ${entry.clinic_number}`,
      isLeaves: false,
    }));
}

/** The weekdays that actually have a stored row, in rotation order. */
function activeDaysOf(schedule: PrimaryCareCycleSchedule, sequence: DayName[]): DayName[] {
  const seen = new Set<DayName>();
  for (const header of schedule.dailyHeaders ?? []) {
    const name = weekdayName(header.day_of_week);
    if (name) seen.add(name);
  }
  if (seen.size === 0) return sequence;
  return sequence.filter((day) => seen.has(day));
}

function buildDay(
  day: DayName,
  schedule: PrimaryCareCycleSchedule,
  columns: CccTemplateColumn[],
  sequence: DayName[],
  weekStartDate: string,
): CccTemplateDay {
  const header = (schedule.dailyHeaders ?? []).find(
    (candidate) => weekdayName(candidate.day_of_week) === day,
  );
  const offset = sequence.indexOf(day);
  const date = offset >= 0 ? weekDayDate(weekStartDate || null, offset) ?? '' : '';

  const shift = normalizeShiftLabel(header?.shift_time) || defaultShiftForDay(day);
  const pgy = (header?.pgy_level ?? '').trim() || defaultPgyForDay(day);
  const inCharge = cccFormatFacultyName(header?.in_charge_faculty_name);

  const cells = columns.map((column): CccTemplateCell => {
    if (column.isLeaves) {
      const away = (schedule.absences ?? []).filter(
        (row) => weekdayName(row.day_of_week) === day,
      );
      return {
        clinicNumber: column.clinicNumber,
        title: column.title,
        isLeaves: true,
        residents: away.map((row) => row.person_name),
        faculty: null,
        leaveTypes: uniqueLeaveTypes(away),
      };
    }

    const slot = (schedule.slots ?? []).find(
      (candidate: PrimaryCareClinicSlot) =>
        candidate.daily_header_id === header?.id &&
        Number(candidate.clinic_number) === column.clinicNumber,
    );
    const residents = [slot?.resident_1_name, slot?.resident_2_name].filter(
      (name): name is string => Boolean(String(name ?? '').trim()),
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

function uniqueLeaveTypes(rows: PrimaryCareAbsence[]): string[] {
  const types: string[] = [];
  for (const row of rows) {
    const label = cccLeaveTypeLabel(row.leave_type);
    if (label && !types.includes(label)) types.push(label);
  }
  return types;
}

function backupPoolsOf(schedule: PrimaryCareCycleSchedule): CccTemplateBackupPool[] {
  const pools: CccTemplateBackupPool[] = [];
  for (const day of BACKUP_POOL_DAYS) {
    const entries = [...(schedule.backups?.[day] ?? [])].sort(
      (a, b) => Number(a.priority_order ?? 0) - Number(b.priority_order ?? 0),
    );
    const names = entries
      .map((entry) => String(entry.faculty_name ?? '').trim())
      .filter((name) => name.length > 0);
    if (names.length > 0) pools.push({ day, names });
  }
  return pools;
}

export interface CccTemplateOptions {
  viewMode?: CccTemplateViewMode;
  programLabel?: string;
  programCode?: string | null;
  /** The screen's live randomisation rationale, when the coordinator typed one. */
  rationale?: string | null;
  /** The rotation window in months; falls back to the cycle's stored value. */
  rotationMonths?: number | null;
}

/**
 * Turn a loaded cycle schedule into the one payload every CCC artefact is
 * rendered from — the downloadable template, the PDF export and the import
 * round-trip checks.
 */
export function buildCccTemplatePayload(
  schedule: PrimaryCareCycleSchedule,
  options: CccTemplateOptions = {},
): CccTemplatePayload {
  const cycle = schedule.cycle;
  const weekStartDate = String(cycle?.start_date ?? '').trim();
  const sequence = weekDaySequence(weekStartDate || null);
  const activeDays = activeDaysOf(schedule, sequence);

  const columns = clinicColumnsOf(schedule.columns);
  const withLeaves: CccTemplateColumn[] = [
    ...columns,
    { clinicNumber: 0, title: CCC_MATRIX_LEAVES_HEADER, isLeaves: true },
  ];

  const rotationMonthsRaw = options.rotationMonths ?? cycle?.rotation_window_months ?? null;
  const rotationMonths =
    rotationMonthsRaw != null && Number.isFinite(Number(rotationMonthsRaw)) && Number(rotationMonthsRaw) > 0
      ? Number(rotationMonthsRaw)
      : null;
  const rotation = rotationMonths != null ? rotationWindowForMonths(weekStartDate || null, rotationMonths) : null;
  const totalWeeksRaw = rotation?.totalWeeks ?? cycle?.total_weeks ?? null;
  const totalWeeks =
    totalWeeksRaw != null && Number.isFinite(Number(totalWeeksRaw)) && Number(totalWeeksRaw) > 0
      ? Number(totalWeeksRaw)
      : null;

  const startDayName = dayNameOf(weekStartDate) ?? activeDays[0] ?? 'Sunday';
  const weekEndDate = weekDayDate(weekStartDate || null, 6) ?? '';

  const days = activeDays.map((day) => buildDay(day, schedule, withLeaves, sequence, weekStartDate));

  return {
    viewMode: options.viewMode === 'roster' ? 'roster' : 'matrix',
    programLabel: options.programLabel ?? 'Programme',
    programCode: options.programCode ?? null,
    academicYear: String(cycle?.academic_year ?? '').trim() || cccFullDateLabel(weekStartDate),
    cycleNumber: String(cycle?.cycle_number ?? '').trim() || 'Cycle 1',
    weekNumber: String(cycle?.week_number ?? '').trim() || 'Week 1',
    weekStartDate: weekStartDate ? cccBannerDateLabel(startDayName, weekStartDate) : '',
    weekEndDate: weekEndDate ? cccBannerDateLabel(dayNameOf(weekEndDate) ?? '', weekEndDate) : '',
    rotationMonths,
    totalWeeks,
    durationLabel: describeDuration(totalWeeks, rotationMonths),
    rationale: String(options.rationale ?? '').trim(),
    columns: withLeaves,
    days,
    backupPools: backupPoolsOf(schedule),
  };
}

/* -------------------------------------------------------------------------- *
 * Sheet layouts. Row 0 is the banner, row 1 the headers, row 2+ the data.
 * -------------------------------------------------------------------------- */

export interface CccSheet {
  name: string;
  rows: string[][];
  merges: { s: { r: number; c: number }; e: { r: number; c: number } }[];
}

/** `Mon 12 Oct | 10:30 - 2:00 | PGY-2` — the matrix day column. */
export function cccMatrixDayCell(day: CccTemplateDay): string {
  return [cccDayLabel(day.day, day.date), day.shift, day.pgy].filter((part) => part.length > 0).join(' | ');
}

/** `Mon 12 Oct | 10:30 - 2:00 | PGY-2` — the roster session column. */
export function cccRosterSessionCell(day: CccTemplateDay): string {
  return cccMatrixDayCell(day);
}

/** The matrix sheet: banner, headers, then one row per day. */
export function cccMatrixSheet(payload: CccTemplatePayload): CccSheet {
  const clinicColumns = payload.columns.filter((column) => !column.isLeaves);
  const headers = [
    CCC_MATRIX_DAY_HEADER,
    CCC_MATRIX_IN_CHARGE_HEADER,
    ...clinicColumns.map((column) => column.title),
    CCC_MATRIX_LEAVES_HEADER,
  ];

  const rows: string[][] = [
    [cccTemplateBanner(payload)],
    headers,
    ...payload.days.map((day) => [
      cccMatrixDayCell(day),
      day.inCharge ? `Faculty In-charge: ${day.inCharge}` : `Faculty In-charge: ${CCC_UNASSIGNED}`,
      ...day.cells.map(cccCellText),
    ]),
  ];

  return {
    name: CCC_TEMPLATE_SHEET_MATRIX,
    rows,
    merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }],
  };
}

/** The roster sheet: banner, headers, then one row per day per column. */
export function cccRosterSheet(payload: CccTemplatePayload): CccSheet {
  const headers = [...CCC_ROSTER_HEADERS];

  const bannerParts = [
    cccTemplateBanner(payload),
    `${CCC_METADATA_KEYS.rationale}: ${payload.rationale}`,
  ];
  if (payload.backupPools.length > 0) {
    bannerParts.push(
      `${CCC_METADATA_KEYS.backupPools}: ${payload.backupPools
        .map((pool) => `${pool.day} (${pool.names.join(', ')})`)
        .join('; ')}`,
    );
  }

  const rows: string[][] = [[bannerParts.join(' | ')], headers];
  for (const day of payload.days) {
    // The screen's session block carries the day, its shift, the PGY badge and
    // the daily in-charge faculty; the sheet keeps all four in one cell so the
    // roster file reads like the roster view and the parser can lift the lead.
    const session = [
      cccRosterSessionCell(day),
      `Faculty In-charge: ${day.inCharge || CCC_UNASSIGNED}`,
    ].join(' | ');
    for (const cell of day.cells) {
      if (cell.isLeaves) {
        rows.push([
          session,
          cell.title,
          cell.residents.length > 0 ? cell.residents.join(', ') : 'No one away',
          cell.leaveTypes.length > 0 ? cell.leaveTypes.join(', ') : '—',
        ]);
        continue;
      }
      rows.push([
        session,
        cell.title,
        cccRosterResidentsText(cell, day.pgy),
        cell.faculty || CCC_UNASSIGNED,
      ]);
    }
  }

  return {
    name: CCC_TEMPLATE_SHEET_ROSTER,
    rows,
    merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }],
  };
}

/** The metadata sheet: the backup pools, then the rotation window details. */
export function cccMetadataSheet(payload: CccTemplatePayload): CccSheet {
  const rows: string[][] = [[CCC_METADATA_POOLS_HEADING], ['Day', 'Faculty']];
  if (payload.backupPools.length === 0) {
    rows.push(['—', 'No backup faculty set yet.']);
  } else {
    for (const pool of payload.backupPools) {
      rows.push([`${pool.day} catchup`, pool.names.join(', ')]);
    }
  }

  rows.push([]);
  rows.push([CCC_METADATA_RATIONALE_HEADING, '']);
  rows.push([CCC_METADATA_KEYS.academicYear, payload.academicYear]);
  rows.push([CCC_METADATA_KEYS.cycle, payload.cycleNumber]);
  rows.push([CCC_METADATA_KEYS.weekNumber, payload.weekNumber]);
  rows.push([CCC_METADATA_KEYS.weekStartDate, payload.weekStartDate]);
  rows.push([CCC_METADATA_KEYS.weekEndDate, payload.weekEndDate]);
  rows.push([CCC_METADATA_KEYS.duration, payload.durationLabel]);
  rows.push([CCC_METADATA_KEYS.rationale, payload.rationale]);

  return { name: CCC_TEMPLATE_SHEET_METADATA, rows, merges: [] };
}

/**
 * The whole workbook, in sheet order. The view decides which of the matrix or
 * the roster sheet leads; the metadata sheet always comes last.
 */
export function cccTemplateSheets(payload: CccTemplatePayload): CccSheet[] {
  const lead = payload.viewMode === 'roster' ? cccRosterSheet(payload) : cccMatrixSheet(payload);
  return [lead, cccMetadataSheet(payload)];
}

/** The whole workbook as one multi-sheet array the local xlsx builder can write. */
export function cccTemplateWorkbook(payload: CccTemplatePayload): CccSheet[] {
  return cccTemplateSheets(payload);
}
