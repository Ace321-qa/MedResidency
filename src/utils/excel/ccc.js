/**
 * The Continuity of Care Clinics (CCC) workbook: the template the app hands
 * out, and the importer that reads it back.
 *
 * ## The contract
 *
 * `mobile/src/utils/cccTemplate.ts` and this file are two halves of one
 * format. The screen builds a `CccTemplatePayload` from the cycle it is
 * displaying; this module turns that payload into cells, and
 * `parseCccMatrixFile` turns cells back into the same shape. `verify-ccc-matrix`
 * runs both halves over one payload and asserts they agree, so a workbook
 * downloaded from the app is a workbook the app can import:
 *
 *   - Sheet 1 is the grid. **Matrix** view: one row per day, one column per
 *     clinic plus `Leaves / Away`. **Roster** view: one row per day per clinic
 *     slot, with the session block repeated so a row stands on its own. Both
 *     start with a merged banner (row 1) and the header row (row 2).
 *   - Sheet 2 is **Metadata**: the backup / catchup pools, then the rotation
 *     window and the rationale.
 *
 * ## What the importer accepts
 *
 * Three layouts reach `parseCccMatrixFile`, detected from the header row:
 *
 *   1. `matrix` — the template's own grid, or any sheet that runs `Clinic 1`,
 *      `Clinic 2`, … horizontally across its columns.
 *   2. `roster` — the template's own roster sheet *and* the operational grid
 *      export, which spells the same fields differently: `Clinic` /
 *      `Clinic Slot` / `Clinic Position` / `Clinic Name` for the slot;
 *      `Resident(s) & PGY Level` or the split `Resident 1 Name` /
 *      `Resident 1 PGY` / `Resident 2 Name (Optional)` columns for the
 *      residents; `Supervising Faculty` / `Faculty Preceptor` for the
 *      supervisor; and `Faculty In-Charge` / `In-Charge Faculty` / `Daily
 *      Lead` for the session lead. Header matching is alias-driven
 *      (`ROSTER_ALIASES`), so a valid alias is never rejected as a missing
 *      column.
 *   3. `legacy` — the long format older exports used (`Day / Time`,
 *      `Session / Context`, `Clinic Column / Name`, `Resident 1 Name`, …).
 *
 * All three normalise to one row shape: the day, its shift and PGY level, the
 * clinic column, up to two residents, the supervising faculty and the session
 * lead. Cells that name nobody are *skipped* rather than rejected — an
 * unfilled template must import cleanly — and a name that does not exist in the
 * programme's roster or faculty list is an error, because a rota written
 * against the wrong person is worse than no import at all.
 *
 * The Leaves column and the backup pools are read but never invented: pools are
 * persisted by the controller when the metadata sheet carries them; leave rows
 * are display-only here, since absences are edited in their own modal.
 */

const XLSX = require('xlsx');
const { makeBuffer, makeWorkbookBuffer } = require('./common');

/* -------------------------------------------------------------------------- *
 * The labels both sides agree on. Changing a string here changes the parser.
 * -------------------------------------------------------------------------- */

const SHEET_MATRIX = 'CCC Matrix';
const SHEET_ROSTER = 'CCC Roster';
const SHEET_METADATA = 'Metadata';

const CCC_MATRIX_DAY_HEADER = 'DAY / SHIFT & PGY';
const CCC_MATRIX_IN_CHARGE_HEADER = 'IN-CHARGE FACULTY';
const CCC_MATRIX_LEAVES_HEADER = 'Leaves / Away';
const CCC_MATRIX_HEADERS = [CCC_MATRIX_DAY_HEADER, CCC_MATRIX_IN_CHARGE_HEADER];

const CCC_ROSTER_DAY_HEADER = 'Day / Time & Session';
const CCC_ROSTER_CLINIC_HEADER = 'Clinic Slot';
const CCC_ROSTER_RESIDENTS_HEADER = 'Resident(s) & PGY Level';
const CCC_ROSTER_FACULTY_HEADER = 'Supervising Faculty';
const CCC_ROSTER_HEADERS = [
  CCC_ROSTER_DAY_HEADER,
  CCC_ROSTER_CLINIC_HEADER,
  CCC_ROSTER_RESIDENTS_HEADER,
  CCC_ROSTER_FACULTY_HEADER,
];

const CCC_UNASSIGNED = 'Unassigned';
const CCC_NO_LEAVE = 'No leave';

const CCC_METADATA_POOLS_HEADING = 'BACKUP / CATCHUP FACULTY POOLS';
const CCC_METADATA_RATIONALE_HEADING = 'ROTATION WINDOW & RATIONALE';

const CCC_BANNER_KEYS = {
  academicYear: 'Academic Year',
  cycle: 'Cycle',
  weekStartDate: 'Week Start Date',
  weekEndDate: 'Week End Date',
  duration: 'Duration / Window',
};

const CCC_METADATA_KEYS = {
  academicYear: 'Academic Year',
  cycle: 'Cycle Number',
  weekNumber: 'Week Number',
  weekStartDate: 'Week Start Date',
  weekEndDate: 'Week End Date',
  duration: 'Duration / Rotation Window',
  rationale: 'Rationale',
  backupPools: 'Backup / Catchup Faculty Pools',
};

/** Legacy long-format header aliases, kept so old exports still import. */
const LEGACY_ALIASES = {
  dayTime: ['day / time', 'day/time', 'day', 'time'],
  sessionContext: ['session / context', 'session/context', 'session', 'context', 'pgy'],
  clinicColumn: ['clinic column / name', 'clinic column/name', 'clinic column', 'clinic name', 'clinic'],
  resident1Name: ['resident 1 name', 'resident1 name', 'resident 1', 'resident1'],
  resident1Pgy: ['resident 1 pgy', 'resident1 pgy', 'pgy 1'],
  resident2Name: ['resident 2 name (optional)', 'resident 2 name', 'resident2 name', 'resident 2', 'resident2'],
  resident2Pgy: ['resident 2 pgy', 'resident2 pgy', 'pgy 2'],
  supervisingFaculty: ['supervising faculty', 'faculty', 'supervisor'],
  facultyInCharge: ['faculty in-charge (session lead)', 'faculty in-charge', 'in-charge', 'session lead', 'in charge'],
};

/**
 * Operational roster header aliases. A header cell is matched against each
 * list in order, so the first spelling a sheet uses wins: the template's own
 * `Clinic Slot` / `Resident(s) & PGY Level`, the operational grid export's
 * `Clinic` / `Resident 1 Name` / `Resident 1 PGY`, and looser hand-filled
 * variants all normalise to the same fields. Nothing here is ever reported as
 * a "missing column" while a valid alias is present.
 */
const ROSTER_ALIASES = {
  daySession: [
    'day / time & session',
    'day/time & session',
    'day / time',
    'day/time',
    'day & session',
    'day and session',
    'day',
  ],
  clinicIdentifier: ['clinic slot', 'clinic position', 'clinic name', 'clinic column / name', 'clinic column/name', 'clinic column', 'clinic'],
  resident1: ['resident(s) & pgy level', 'resident 1 name', 'resident 1', 'resident1 name', 'resident1', 'resident name'],
  resident1Pgy: ['resident 1 pgy', 'resident1 pgy', 'resident 1 pgy level', 'pgy 1'],
  resident2: ['resident 2 name (optional)', 'resident 2 name', 'resident2 name', 'resident 2', 'resident2'],
  resident2Pgy: ['resident 2 pgy', 'resident2 pgy', 'resident 2 pgy level', 'pgy 2'],
  sessionContext: ['session / context', 'session/context', 'session', 'context'],
  supervisingFaculty: ['supervising faculty', 'faculty preceptor', 'preceptor', 'faculty', 'supervisor'],
  inChargeFaculty: [
    'faculty in-charge (session lead)',
    'faculty in-charge',
    'in-charge faculty',
    'daily lead',
    'faculty in charge',
    'session lead',
    'in-charge',
    'in charge',
  ],
};

/** The combined residents column, singled out so split columns can be detected. */
const ROSTER_RESIDENTS_COMBINED = ROSTER_ALIASES.resident1[0];
const ROSTER_RESIDENT1_SPLIT = ROSTER_ALIASES.resident1.slice(1);

const LEGACY_HEADERS = [
  'Day / Time',
  'Session / Context',
  'Clinic Column / Name',
  'Resident 1 Name',
  'Resident 1 PGY',
  'Resident 2 Name (Optional)',
  'Resident 2 PGY',
  'Supervising Faculty',
  'Faculty In-Charge (Session Lead)',
];

const LEGACY_SAMPLE_ROWS = [
  ['Sunday 10:30–14:00', 'PGY-3', 'Clinic 1', 'Maha Mansour Nguyen', 'PGY-3', '', '', 'Dr. Hassan Al-Hussein', 'Dr. Hassan Al-Hussein'],
  ['Sunday 10:30–14:00', 'PGY-3', 'Clinic 2', 'Amira Mansour', 'PGY-3', '', '', 'Dr. Areen Khalil', 'Dr. Hassan Al-Hussein'],
  ['Monday 10:30–14:00', 'PGY-2', 'Clinic 1', 'Yara Al-Malki', 'PGY-2', '', '', 'Dr. Ahmed Bawazir', 'Dr. Hassan Al-Hussein'],
  ['Tuesday 07:00–14:00', 'FMC', 'Clinic 1', 'Razan Hourani', 'PGY-1', 'Nematalla Abdelmaksoud', 'PGY-1', 'Dr. Saleh Al-Mutairi', 'Dr. Areen Khalil'],
  ['Wednesday 10:30–14:00', 'PGY-1', 'Clinic 1', 'Soha El-Sayed', 'PGY-2', '', '', 'Dr. Areen Khalil', 'Dr. Areen Khalil'],
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* -------------------------------------------------------------------------- *
 * Formatting helpers — pure, timezone-free, mirrored in cccTemplate.ts.
 * -------------------------------------------------------------------------- */

function calendarParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { day, month, year };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** `12 Oct` — the day column's short date. */
function cccDayDateLabel(value) {
  const parts = calendarParts(value);
  if (!parts) return '';
  return `${pad2(parts.day)} ${MONTHS_SHORT[parts.month - 1]}`;
}

/** `12 Oct 2026` — the banner's full date. */
function cccFullDateLabel(value) {
  const parts = calendarParts(value);
  if (!parts) return '';
  return `${pad2(parts.day)} ${MONTHS_SHORT[parts.month - 1]} ${parts.year}`;
}

/** 0-based weekday index for a day name, or -1. */
function weekdayIndex(day) {
  const normalized = String(day ?? '').trim().toLowerCase();
  if (!normalized) return -1;
  return DAY_NAMES.findIndex((name) => {
    const full = name.toLowerCase();
    return normalized === full || normalized === full.slice(0, 3) || normalized.startsWith(full.slice(0, 3));
  });
}

/** Canonical weekday name for whatever spelling is stored, or null. */
function canonicalDayName(day) {
  const index = weekdayIndex(day);
  return index < 0 ? null : DAY_NAMES[index];
}

function dayNameOfCalendarDate(value) {
  const parts = calendarParts(value);
  if (!parts) return null;
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day);
  return DAY_NAMES[new Date(utc).getUTCDay()];
}

/** `Mon 12 Oct` — the day column's day label. */
function cccDayLabel(day, date) {
  const index = weekdayIndex(day);
  const short = index >= 0 ? WEEKDAY_SHORT[index] : String(day ?? '').trim().slice(0, 3);
  const dateLabel = cccDayDateLabel(date);
  return dateLabel ? `${short} ${dateLabel}` : short;
}

/** `Mon 12 Oct 2026` — the banner's day-and-date fragment. */
function cccBannerDateLabel(day, date) {
  const index = weekdayIndex(day);
  const short = index >= 0 ? WEEKDAY_SHORT[index] : String(day ?? '').trim().slice(0, 3);
  const dateLabel = cccFullDateLabel(date);
  return dateLabel ? `${short} ${dateLabel}` : short;
}

/** One ASCII hyphen and single spaces: `10:30 - 2:00`. */
function normalizeShiftLabel(shift) {
  return String(shift ?? '')
    .trim()
    .replace(/[–—−]/g, '-')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s{2,}/g, ' ');
}

/** A single, and only a single, `Dr. ` title on a faculty display name. */
function cccFormatFacultyName(name) {
  const base = String(name ?? '')
    .trim()
    .replace(/^Dr\.?\s+/i, '')
    .trim();
  return base ? `Dr. ${base}` : '';
}

/** `SICK_LEAVE` -> `Sick Leave`. */
function cccLeaveTypeLabel(value) {
  if (!value) return 'Leave';
  return String(value)
    .toLowerCase()
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** The matrix cell's text: `Dr. A & Dr. B / Dr. Faculty`, or `Unassigned`. */
function cccCellText(cell) {
  if (cell.isLeaves) {
    if (cell.residents.length === 0) return CCC_NO_LEAVE;
    return cell.residents.join(', ');
  }
  const names = cell.residents.length > 0 ? cell.residents.join(' & ') : CCC_UNASSIGNED;
  return cell.faculty ? `${names} / ${cell.faculty}` : names;
}

/** The roster cell's resident text: `Dr. A & Dr. B / PGY-2`. */
function cccRosterResidentsText(cell, pgy) {
  if (cell.residents.length === 0) return CCC_UNASSIGNED;
  return `${cell.residents.join(' & ')} / ${pgy}`;
}

/** The banner: one pipe-separated line spanning the whole sheet. */
function cccTemplateBanner(payload) {
  return [
    `${CCC_BANNER_KEYS.academicYear}: ${payload.academicYear ?? ''}`,
    `${CCC_BANNER_KEYS.cycle}: ${payload.cycleNumber ?? ''}`,
    `${CCC_BANNER_KEYS.weekStartDate}: ${payload.weekStartDate ?? ''}`,
    `${CCC_BANNER_KEYS.weekEndDate}: ${payload.weekEndDate ?? ''}`,
    `${CCC_BANNER_KEYS.duration}: ${payload.durationLabel ?? ''}`,
  ].join(' | ');
}

/** `Mon 12 Oct | 10:30 - 2:00 | PGY-2` — the matrix and roster day cell. */
function cccMatrixDayCell(day) {
  return [cccDayLabel(day.day, day.date), day.shift, day.pgy]
    .filter((part) => part && part.length > 0)
    .join(' | ');
}

/* -------------------------------------------------------------------------- *
 * Payload -> sheet rows. These three functions are the layout.
 * -------------------------------------------------------------------------- */

function cccMatrixSheet(payload) {
  const columns = (payload.columns ?? []).filter((column) => !column.isLeaves);
  const headers = [
    CCC_MATRIX_DAY_HEADER,
    CCC_MATRIX_IN_CHARGE_HEADER,
    ...columns.map((column) => column.title),
    CCC_MATRIX_LEAVES_HEADER,
  ];

  const rows = [
    [cccTemplateBanner(payload)],
    headers,
    ...(payload.days ?? []).map((day) => [
      cccMatrixDayCell(day),
      `Faculty In-charge: ${day.inCharge || CCC_UNASSIGNED}`,
      ...(day.cells ?? []).map(cccCellText),
    ]),
  ];

  return {
    name: SHEET_MATRIX,
    rows,
    merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(headers.length - 1, 0) } }],
  };
}

function cccRosterSheet(payload) {
  const headers = [...CCC_ROSTER_HEADERS];

  const bannerParts = [cccTemplateBanner(payload), `${CCC_METADATA_KEYS.rationale}: ${payload.rationale ?? ''}`];
  const pools = payload.backupPools ?? [];
  if (pools.length > 0) {
    bannerParts.push(
      `${CCC_METADATA_KEYS.backupPools}: ${pools
        .map((pool) => `${pool.day} (${pool.names.join(', ')})`)
        .join('; ')}`,
    );
  }

  const rows = [[bannerParts.join(' | ')], headers];
  for (const day of payload.days ?? []) {
    const session = [cccMatrixDayCell(day), `Faculty In-charge: ${day.inCharge || CCC_UNASSIGNED}`].join(' | ');
    for (const cell of day.cells ?? []) {
      if (cell.isLeaves) {
        rows.push([
          session,
          cell.title,
          cell.residents.length > 0 ? cell.residents.join(', ') : 'No one away',
          cell.leaveTypes && cell.leaveTypes.length > 0 ? cell.leaveTypes.join(', ') : '—',
        ]);
        continue;
      }
      rows.push([session, cell.title, cccRosterResidentsText(cell, day.pgy), cell.faculty ?? CCC_UNASSIGNED]);
    }
  }

  return {
    name: SHEET_ROSTER,
    rows,
    merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(headers.length - 1, 0) } }],
  };
}

function cccMetadataSheet(payload) {
  const rows = [[CCC_METADATA_POOLS_HEADING], ['Day', 'Faculty']];
  const pools = payload.backupPools ?? [];
  if (pools.length === 0) {
    rows.push(['—', 'No backup faculty set yet.']);
  } else {
    for (const pool of pools) rows.push([`${pool.day} catchup`, pool.names.join(', ')]);
  }

  rows.push([]);
  rows.push([CCC_METADATA_RATIONALE_HEADING, '']);
  rows.push([CCC_METADATA_KEYS.academicYear, payload.academicYear ?? '']);
  rows.push([CCC_METADATA_KEYS.cycle, payload.cycleNumber ?? '']);
  rows.push([CCC_METADATA_KEYS.weekNumber, payload.weekNumber ?? '']);
  rows.push([CCC_METADATA_KEYS.weekStartDate, payload.weekStartDate ?? '']);
  rows.push([CCC_METADATA_KEYS.weekEndDate, payload.weekEndDate ?? '']);
  rows.push([CCC_METADATA_KEYS.duration, payload.durationLabel ?? '']);
  rows.push([CCC_METADATA_KEYS.rationale, payload.rationale ?? '']);

  return { name: SHEET_METADATA, rows, merges: [] };
}

/** The whole workbook, matrix or roster first, metadata always last. */
function cccTemplateSheets(payload) {
  const lead = payload.viewMode === 'roster' ? cccRosterSheet(payload) : cccMatrixSheet(payload);
  return [lead, cccMetadataSheet(payload)];
}

/* -------------------------------------------------------------------------- *
 * Buffer builders.
 * -------------------------------------------------------------------------- */

/** Two sample rows for a payload that has no day rows yet. */
function sampleMatrixRows(clinicCount) {
  return [
    ['Mon 12 Oct | 10:30 - 2:00 | PGY-2', 'Faculty In-charge: Dr. Hassan Al-Hussein', ...Array(clinicCount).fill('Unassigned'), 'No leave'],
    ['Tue 13 Oct | 07:00 - 2:00 | FMC', 'Faculty In-charge: Dr. Areen Khalil', ...Array(clinicCount).fill('Unassigned'), 'No leave'],
  ];
}

function sampleRosterRows() {
  return [
    ['Mon 12 Oct | 10:30 - 2:00 | PGY-2 | Faculty In-charge: Dr. Hassan Al-Hussein', 'Clinic 1', 'Unassigned', 'Unassigned'],
    ['Tue 13 Oct | 07:00 - 2:00 | FMC | Faculty In-charge: Dr. Areen Khalil', 'Clinic 1', 'Unassigned', 'Unassigned'],
  ];
}

/**
 * Build the CCC workbook from a payload.
 *
 * A payload without day rows still gets a usable file: the banner, the headers
 * and a couple of sample rows, so a programme that has not configured its week
 * yet can download a template, fill it and upload it to *create* the week.
 */
function buildCccTemplateBuffer(payload) {
  const sheets = cccTemplateSheets(payload);
  if ((payload.days ?? []).length === 0) {
    const clinicCount = (payload.columns ?? []).filter((column) => !column.isLeaves).length || 10;
    if (payload.viewMode === 'roster') {
      sheets[0] = { ...sheets[0], rows: [...sheets[0].rows, ...sampleRosterRows()] };
    } else {
      sheets[0] = { ...sheets[0], rows: [...sheets[0].rows, ...sampleMatrixRows(clinicCount)] };
    }
  }
  return makeWorkbookBuffer(sheets, SHEET_MATRIX);
}

/**
 * The query-string form of the template, for callers that send parameters
 * rather than a payload. It carries the same banner and headers; the day rows
 * are the two samples, since a query string cannot hold a schedule.
 */
function buildDynamicTemplate(options = {}) {
  const clinicCount = Number(options.clinicCount) || 10;
  const viewMode = String(options.viewMode || 'matrix').toLowerCase() === 'roster' ? 'roster' : 'matrix';
  const columns = Array.from({ length: clinicCount }, (_, index) => ({
    clinicNumber: index + 1,
    title: `Clinic ${index + 1}`,
    isLeaves: false,
  }));
  columns.push({ clinicNumber: 0, title: CCC_MATRIX_LEAVES_HEADER, isLeaves: true });

  const payload = {
    viewMode,
    programLabel: options.programLabel || 'Programme',
    programCode: options.programCode || null,
    academicYear: options.academicYear || '',
    cycleNumber: options.cycle || '',
    weekNumber: options.week || '',
    weekStartDate: options.startDate || '',
    weekEndDate: options.endDate || '',
    durationLabel: options.duration || '',
    rationale: options.rationale || '',
    columns,
    days: [],
    backupPools: Array.isArray(options.backupPools) ? options.backupPools : [],
  };

  return buildCccTemplateBuffer(payload);
}

/** The legacy one-sheet template, kept for callers that still ask for it. */
function generateCccMatrixTemplate(rows = LEGACY_SAMPLE_ROWS, sheetName = SHEET_MATRIX) {
  return makeBuffer(LEGACY_HEADERS, rows, sheetName);
}

/* -------------------------------------------------------------------------- *
 * Parsing.
 * -------------------------------------------------------------------------- */

function cellText(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return cellText(value).toLowerCase();
}

function headerIndex(headers, keys) {
  const normalised = headers.map(lower);
  for (const key of keys) {
    const at = normalised.indexOf(key);
    if (at >= 0) return at;
  }
  return -1;
}

function isBlankRow(row) {
  return !row.some((value) => cellText(value) !== '');
}

/** `Mon 12 Oct | 10:30 - 2:00 | PGY-2` and every looser spelling of it. */
function parseDayCell(text) {
  const value = cellText(text);
  if (!value) return { dayOfWeek: null, shift: null, pgy: null, inCharge: null };

  const segments = value.split('|').map((segment) => segment.trim());
  const head = segments[0] ?? '';

  const dayMatch = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*/i.exec(head) ?? /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*/i.exec(value);
  const dayOfWeek = dayMatch ? canonicalDayName(dayMatch[0]) : null;

  const timeMatch = /(\d{1,2}[:.]\d{2})\s*(?:-|–|—)\s*(\d{1,2}[:.]\d{2})/.exec(value);
  const shift = timeMatch ? `${timeMatch[1].replace('.', ':')} - ${timeMatch[2].replace('.', ':')}` : null;

  let pgy = null;
  for (const segment of segments.slice(1)) {
    const candidate = segment.trim();
    if (/^pgy\s*[-–—]?\s*\d+$/i.test(candidate)) {
      pgy = candidate.toUpperCase().replace(/\s+/g, '-').replace(/–|—/g, '-');
      break;
    }
    if (/^(fmc|all)$/i.test(candidate)) {
      pgy = candidate.toUpperCase();
      break;
    }
  }
  if (!pgy) {
    const pgyMatch = /\b(pgy\s*[-–—]?\s*\d+|fmc)\b/i.exec(value);
    if (pgyMatch) pgy = pgyMatch[1].toUpperCase().replace(/\s+/g, '-').replace(/–|—/g, '-');
  }

  let inCharge = null;
  const lead = segments.find((segment) => /faculty\s*in[- ]?charge/i.test(segment));
  if (lead) {
    inCharge = cellText(lead.replace(/^.*faculty\s*in[- ]?charge\s*:?\s*/i, ''));
  } else {
    const leadMatch = /in[- ]?charge\s*:?\s*(.+)$/i.exec(value);
    if (leadMatch) inCharge = cellText(leadMatch[1]);
  }
  if (inCharge && /^unassigned$/i.test(inCharge)) inCharge = null;

  return { dayOfWeek, shift, pgy, inCharge };
}

/** `Dr. A & Dr. B / Dr. Faculty` -> the residents and the supervisor. */
function parseClinicCell(text) {
  const value = cellText(text);
  if (!value || /^unassigned$/i.test(value)) return { residents: [], faculty: null };

  const parts = value.split(/\s+\/\s+/).map((part) => part.trim());
  let faculty = null;
  let residentsPart = value;
  if (parts.length > 1) {
    faculty = parts[parts.length - 1];
    residentsPart = parts.slice(0, -1).join(' / ');
    if (!faculty || /^unassigned$/i.test(faculty) || /^—+$/.test(faculty)) faculty = null;
  }

  const residents = residentsPart
    .split(/\s*&\s*/)
    .map((name) => cellText(name))
    .filter((name) => name.length > 0 && !/^unassigned$/i.test(name) && !/^—+$/.test(name));

  return { residents, faculty };
}

/** `Dr. A & Dr. B / PGY-2` -> the residents and the level. */
function parseRosterResidentsCell(text) {
  const value = cellText(text);
  if (!value || /^unassigned$/i.test(value) || /^no one away$/i.test(value) || /^[-—–]+$/.test(value)) {
    return { residents: [], pgy: null };
  }

  const parts = value.split(/\s+\/\s+/).map((part) => part.trim());
  let pgy = null;
  let residentsPart = value;
  const last = parts[parts.length - 1];
  if (parts.length > 1 && /^pgy\s*[-–—]?\s*\d+$/i.test(last)) {
    pgy = last.toUpperCase().replace(/\s+/g, '-').replace(/–|—/g, '-');
    residentsPart = parts.slice(0, -1).join(' / ');
  }

  const residents = residentsPart
    .split(/\s*&\s*/)
    .map((name) => cellText(name))
    .filter((name) => name.length > 0 && !/^unassigned$/i.test(name));

  return { residents, pgy };
}

function parseFacultyCell(text) {
  const value = cellText(text);
  if (!value) return null;
  if (/^unassigned$/i.test(value)) return null;
  if (/^none$/i.test(value)) return null;
  if (/^—+$/.test(value) || /^-$/.test(value)) return null;
  return value;
}

/**
 * A split-column resident name cell that names nobody -> null. The grid
 * export writes `—` (or `-`, `Unassigned`, `N/A`) in the empty half of a
 * partially filled row, and an empty slot must skip rather than reject.
 */
function cleanResidentName(text) {
  const name = cellText(text);
  if (!name) return null;
  if (/^[-—–]+$/.test(name)) return null;
  if (/^(unassigned|no one away|none|n\/a|vacant)$/i.test(name)) return null;
  return name;
}

/** `Faculty In-charge: Dr. X` -> `Dr. X`, or null when nobody is named. */
function parseInChargeCell(text) {
  const value = cellText(text);
  if (!value) return null;
  const stripped = value.replace(/^.*faculty\s*in[- ]?charge\s*:?\s*/i, '').trim();
  const name = stripped || value;
  if (!name || /^unassigned$/i.test(name)) return null;
  return name;
}

function isLeavesTitle(title) {
  return /^leaves/i.test(cellText(title));
}

/** `Clinic 7` -> 7. A custom label resolves against the programme's columns. */
function clinicNumberFromTitle(title, columns) {
  const value = cellText(title);
  if (!value || isLeavesTitle(value)) return { clinicNumber: null, isLeaves: isLeavesTitle(value) };

  const generic = /^clinic\s*(\d+)$/i.exec(value);
  if (generic) return { clinicNumber: Number(generic[1]), isLeaves: false };

  const match = (columns ?? []).find((column) => cellText(column.label).toLowerCase() === value.toLowerCase());
  if (match) return { clinicNumber: Number(match.clinic_number), isLeaves: false };

  return { clinicNumber: null, isLeaves: false, unresolvedTitle: value };
}

/**
 * Read the banner (row 1) and the metadata sheet into the values the import
 * needs to find the right cycle: the cycle number, the week start date, the
 * rotation window and the backup pools.
 */
function parseMetadata(sheetRows, allSheets) {
  const metadata = {
    academicYear: null,
    cycleNumber: null,
    weekNumber: null,
    weekStartDate: null,
    weekEndDate: null,
    durationLabel: null,
    rationale: null,
    backupPools: [],
  };

  const banner = cellText((sheetRows[0] ?? [])[0]);
  if (banner.includes(':')) {
    const pairs = banner.split('|').map((fragment) => fragment.trim());
    for (const pair of pairs) {
      const at = pair.indexOf(':');
      if (at < 0) continue;
      const key = pair.slice(0, at).trim().toLowerCase();
      const value = pair.slice(at + 1).trim();
      if (!value) continue;
      if (key === CCC_BANNER_KEYS.academicYear.toLowerCase()) metadata.academicYear = value;
      else if (key === CCC_BANNER_KEYS.cycle.toLowerCase()) metadata.cycleNumber = value;
      else if (key === CCC_BANNER_KEYS.weekStartDate.toLowerCase()) metadata.weekStartDate = value;
      else if (key === CCC_BANNER_KEYS.weekEndDate.toLowerCase()) metadata.weekEndDate = value;
      else if (key === CCC_BANNER_KEYS.duration.toLowerCase()) metadata.durationLabel = value;
      else if (key === CCC_METADATA_KEYS.rationale.toLowerCase()) metadata.rationale = value;
      else if (key === CCC_METADATA_KEYS.backupPools.toLowerCase()) metadata.bannerPools = value;
    }
  }

  // Legacy sheets carried their own metadata rows above the header.
  for (let i = 1; i < Math.min(sheetRows.length, 6); i++) {
    const row = sheetRows[i] ?? [];
    const text = row.map(lower).join(' ');
    if (/cycle/.test(text) && metadata.cycleNumber === null) {
      const value = row.map(cellText).find((cell) => /cycle/i.test(cell) && cell.length > 1);
      if (value) metadata.cycleNumber = value;
    }
    const iso = row.map(cellText).find((cell) => /^\d{4}-\d{2}-\d{2}$/.test(cell));
    if (iso && /start/.test(text)) metadata.weekStartDate = metadata.weekStartDate ?? iso;
  }

  // The metadata sheet, if the file has one, wins over the banner for pools.
  const metaSheet = (allSheets ?? []).find(
    (sheet) => cellText(sheet.name).toLowerCase() === SHEET_METADATA.toLowerCase(),
  );
  const poolRows = metaSheet
    ? metaSheet.rows
    : (allSheets ?? []).flatMap((sheet) => sheet.rows ?? []);

  let inPools = false;
  let inRationale = false;
  for (const row of poolRows) {
    const first = cellText((row ?? [])[0]);
    if (!first) continue;
    const upper = first.toUpperCase();
    if (upper === CCC_METADATA_POOLS_HEADING) {
      inPools = true;
      inRationale = false;
      continue;
    }
    if (upper === CCC_METADATA_RATIONALE_HEADING) {
      inPools = false;
      inRationale = true;
      continue;
    }
    if (inPools) {
      const day = canonicalDayName(first.replace(/\s*catchup\s*$/i, ''));
      if (!day) continue;
      const names = cellText((row ?? [])[1])
        .split(/[,|]/)
        .map((name) => cellText(name))
        .filter((name) => name.length > 0 && !/^no backup/i.test(name));
      if (names.length > 0) metadata.backupPools.push({ day, names });
      continue;
    }
    if (inRationale) {
      const key = first.toLowerCase();
      const value = cellText((row ?? [])[1]);
      if (key === CCC_METADATA_KEYS.rationale.toLowerCase()) metadata.rationale = value || metadata.rationale;
      else if (key === CCC_METADATA_KEYS.cycle.toLowerCase()) metadata.cycleNumber = value || metadata.cycleNumber;
      else if (key === CCC_METADATA_KEYS.weekNumber.toLowerCase()) metadata.weekNumber = value || metadata.weekNumber;
      else if (key === CCC_METADATA_KEYS.duration.toLowerCase()) metadata.durationLabel = value || metadata.durationLabel;
      else if (key === CCC_METADATA_KEYS.weekStartDate.toLowerCase()) metadata.weekStartDate = value || metadata.weekStartDate;
      else if (key === CCC_METADATA_KEYS.weekEndDate.toLowerCase()) metadata.weekEndDate = value || metadata.weekEndDate;
      else if (key === CCC_METADATA_KEYS.academicYear.toLowerCase()) metadata.academicYear = value || metadata.academicYear;
    }
  }

  // A banner pool line is the roster sheet's fallback when there is no
  // metadata sheet at all: `Sunday (Dr. A, Dr. B); Monday (…)`.
  if (metadata.backupPools.length === 0 && metadata.bannerPools) {
    for (const fragment of metadata.bannerPools.split(';')) {
      const match = /^\s*([A-Za-z]+)\s*\((.+)\)\s*$/.exec(fragment);
      if (!match) continue;
      const day = canonicalDayName(match[1]);
      if (!day) continue;
      const names = match[2]
        .split(/,/)
        .map((name) => cellText(name))
        .filter((name) => name.length > 0);
      if (names.length > 0) metadata.backupPools.push({ day, names });
    }
  }

  // `Week Start Date: Mon 12 Oct 2026` -> `2026-10-12`, for cycle lookup.
  metadata.weekStartCalendarDate = bannerDateToCalendarDate(metadata.weekStartDate);

  return metadata;
}

/** `Mon 12 Oct 2026` -> `2026-10-12`, or null when it is not that shape. */
function bannerDateToCalendarDate(value) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cellText(value));
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const match = /^[A-Za-z]{3,9}\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(cellText(value));
  if (!match) return null;
  const month = MONTHS_SHORT.findIndex((name) => name.toLowerCase() === match[2].toLowerCase());
  if (month < 0) return null;
  return `${match[3]}-${pad2(month + 1)}-${pad2(Number(match[1]))}`;
}

/**
 * Read a CCC workbook.
 *
 * @param {Buffer} buffer the uploaded `.xlsx`
 * @param {{columns?: {clinic_number: number|string, label: string|null}[]}} [options]
 *   the programme's configured clinic columns, so a custom header (`WBC`)
 *   resolves to its numbered slot. Without them only `Clinic N` headers resolve.
 * @returns {{
 *   format: 'matrix'|'roster'|'legacy',
 *   rows: object[],
 *   errors: {row?: number, field?: string, message: string}[],
 *   metadata: object,
 *   dataRowCount: number,
 * }}
 */
function parseCccMatrixFile(buffer, options = {}) {
  const configuredColumns = Array.isArray(options.columns) ? options.columns : [];
  const resolveTitle = (title) => clinicNumberFromTitle(title, configuredColumns);
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  if (!workbook.SheetNames.length) throw new Error('The file has no readable sheet.');

  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) throw new Error('The file has no readable sheet.');

  const gridRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false, blankrows: true });
  if (gridRows.length < 1) throw new Error('The file needs a header row.');

  const allSheets = workbook.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, blankrows: true }),
  }));

  // --- find the header row and which layout it announces --------------------
  // Detection is shape-driven and alias-aware: the same sheet may call the
  // clinic column `Clinic`, `Clinic Slot`, `Clinic Position` or `Clinic Name`,
  // and the residents `Resident(s) & PGY Level` or split `Resident 1 Name` /
  // `Resident 1 PGY` columns. What distinguishes the layouts is the shape of
  // the row — a horizontal run of `Clinic N` headers is the matrix grid; a
  // clinic column beside a resident column is one row per clinic slot — and a
  // valid alias is never reported as a missing column.
  let headerRowIndex = -1;
  let format = null;
  for (let i = 0; i < Math.min(gridRows.length, 20); i++) {
    const row = gridRows[i] ?? [];
    const lowered = row.map(lower);

    // Matrix grid mode: the template's own headers...
    if (lowered.includes(CCC_MATRIX_DAY_HEADER.toLowerCase()) && lowered.includes(CCC_MATRIX_IN_CHARGE_HEADER.toLowerCase())) {
      headerRowIndex = i;
      format = 'matrix';
      break;
    }
    // ...or any sheet that runs `Clinic 1`, `Clinic 2`, … across its columns.
    const numberedClinicHeaders = row.filter((cell) => /^clinic\s*\d+$/i.test(cellText(cell))).length;
    if (numberedClinicHeaders >= 2) {
      headerRowIndex = i;
      format = 'matrix';
      break;
    }

    // The long-format legacy export keeps its own, stricter validation.
    const legacy = {
      dayTime: headerIndex(row, LEGACY_ALIASES.dayTime),
      clinicColumn: headerIndex(row, LEGACY_ALIASES.clinicColumn),
      resident1Name: headerIndex(row, LEGACY_ALIASES.resident1Name),
    };
    if (legacy.dayTime >= 0 && legacy.clinicColumn >= 0 && legacy.resident1Name >= 0) {
      headerRowIndex = i;
      format = 'legacy';
      break;
    }

    // Operational roster mode: a clinic column beside a resident column, in
    // either the template's spelling or the grid export's.
    const clinicAt = headerIndex(row, ROSTER_ALIASES.clinicIdentifier);
    const residentAt = headerIndex(row, ROSTER_ALIASES.resident1);
    if (clinicAt >= 0 && residentAt >= 0) {
      headerRowIndex = i;
      format = 'roster';
      break;
    }
  }

  if (headerRowIndex < 0 || !format) {
    throw new Error(
      `Missing required columns: expected a header row carrying a clinic column (${CCC_ROSTER_CLINIC_HEADER}, Clinic, Clinic Position or Clinic Name), a resident column (${CCC_ROSTER_RESIDENTS_HEADER} or Resident 1 Name), or the matrix grid (${CCC_MATRIX_DAY_HEADER} with Clinic 1 … Clinic N).`,
    );
  }

  const headers = (gridRows[headerRowIndex] ?? []).map(cellText);
  const metadata = parseMetadata(gridRows, allSheets);

  const errors = [];
  const rows = [];
  const unresolvedTitles = new Set();
  let dataRowCount = 0;

  if (format === 'matrix') {
    const dayAt = Math.max(
      headers.findIndex((header) => lower(header) === CCC_MATRIX_DAY_HEADER.toLowerCase()),
      headerIndex(headers, ROSTER_ALIASES.daySession),
    );
    const inChargeAt = Math.max(
      headers.findIndex((header) => lower(header) === CCC_MATRIX_IN_CHARGE_HEADER.toLowerCase()),
      headerIndex(headers, ROSTER_ALIASES.inChargeFaculty),
    );
    const clinicColumns = [];
    for (let i = 0; i < headers.length; i++) {
      if (i === dayAt || i === inChargeAt) continue;
      if (!headers[i]) continue;
      const resolvedHeader = resolveTitle(headers[i]);
      clinicColumns.push({
        index: i,
        title: headers[i],
        clinicNumber: resolvedHeader.clinicNumber ?? null,
        isLeaves: resolvedHeader.isLeaves,
        unresolvedTitle: resolvedHeader.unresolvedTitle ?? null,
      });
    }

    // A header the programme does not recognise is one complaint, not one per
    // row: the fix belongs in the header row, not in fifty cells.
    for (const column of clinicColumns) {
      if (column.unresolvedTitle) unresolvedTitles.add(column.unresolvedTitle);
    }

    for (let i = headerRowIndex + 1; i < gridRows.length; i++) {
      const source = gridRows[i] ?? [];
      if (isBlankRow(source)) continue;
      dataRowCount += 1;
      const rowNumber = i + 1;

      const parsed = parseDayCell(source[dayAt]);
      if (!parsed.dayOfWeek) {
        errors.push({ row: rowNumber, field: CCC_MATRIX_DAY_HEADER, message: 'does not name a day of the week' });
        continue;
      }
      if (!parsed.shift) {
        errors.push({ row: rowNumber, field: CCC_MATRIX_DAY_HEADER, message: 'does not include a shift time range' });
        continue;
      }
      if (!parsed.pgy) {
        errors.push({ row: rowNumber, field: CCC_MATRIX_DAY_HEADER, message: 'does not include a PGY level or FMC' });
        continue;
      }

      // The session lead lives in its own column, not in the day cell.
      const inCharge = inChargeAt >= 0 ? parseInChargeCell(source[inChargeAt]) : parsed.inCharge;

      for (const column of clinicColumns) {
        if (column.isLeaves) continue;
        const cell = parseClinicCell(source[column.index]);
        if (cell.residents.length === 0 && !cell.faculty) continue;

        rows.push({
          row: rowNumber,
          format,
          cellRef: `${columnName(column.index)}${rowNumber}`,
          dayOfWeek: parsed.dayOfWeek,
          shift: parsed.shift,
          pgy: parsed.pgy,
          clinicTitle: column.title,
          clinicNumber: column.clinicNumber,
          unresolvedTitle: column.unresolvedTitle,
          residents: cell.residents,
          faculty: cell.faculty,
          inCharge,
        });
      }
    }
  } else if (format === 'roster') {
    const dayAt = headerIndex(headers, ROSTER_ALIASES.daySession);
    const clinicAt = headerIndex(headers, ROSTER_ALIASES.clinicIdentifier);
    const combinedAt = headerIndex(headers, [ROSTER_RESIDENTS_COMBINED]);
    const splitAt = headerIndex(headers, ROSTER_RESIDENT1_SPLIT);
    const residentsAt = combinedAt >= 0 ? combinedAt : splitAt;
    const resident1PgyAt = headerIndex(headers, ROSTER_ALIASES.resident1Pgy);
    const resident2At = headerIndex(headers, ROSTER_ALIASES.resident2);
    const facultyAt = headerIndex(headers, ROSTER_ALIASES.supervisingFaculty);
    const inChargeAt = headerIndex(headers, ROSTER_ALIASES.inChargeFaculty);
    const sessionAt = headerIndex(headers, ROSTER_ALIASES.sessionContext);

    // Detection only fires when the clinic and resident columns both resolve
    // through an alias, so this guard is defensive: the complaint names the
    // canonical headers rather than whichever spelling the sheet used. The day
    // and faculty columns are *not* required here — a missing day surfaces as
    // a per-row error, never as a blanket rejection of a file whose clinic and
    // resident columns are present.
    const missing = [];
    if (clinicAt < 0) missing.push(CCC_ROSTER_CLINIC_HEADER);
    if (residentsAt < 0) missing.push(CCC_ROSTER_RESIDENTS_HEADER);
    if (missing.length > 0) {
      throw new Error(
        `Missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
      );
    }

    const dayField = dayAt >= 0 ? headers[dayAt] : CCC_ROSTER_DAY_HEADER;
    const clinicField = headers[clinicAt] || CCC_ROSTER_CLINIC_HEADER;
    const residentsField = headers[residentsAt] || CCC_ROSTER_RESIDENTS_HEADER;

    for (let i = headerRowIndex + 1; i < gridRows.length; i++) {
      const source = gridRows[i] ?? [];
      if (isBlankRow(source)) continue;
      dataRowCount += 1;
      const rowNumber = i + 1;

      const parsed = parseDayCell(dayAt >= 0 ? source[dayAt] : null);
      if (!parsed.dayOfWeek) {
        errors.push({ row: rowNumber, field: dayField, message: 'does not name a day of the week' });
        continue;
      }
      if (!parsed.shift) {
        errors.push({ row: rowNumber, field: dayField, message: 'does not include a shift time range' });
        continue;
      }

      const title = cellText(source[clinicAt]);
      if (!title) {
        errors.push({ row: rowNumber, field: clinicField, message: 'is required' });
        continue;
      }
      const resolved = resolveTitle(title);
      if (resolved.isLeaves) continue;
      if (resolved.unresolvedTitle) unresolvedTitles.add(resolved.unresolvedTitle);

      // The residents live either in one combined `A & B / PGY-2` cell or in
      // the grid export's split name / PGY columns. Both read into the same
      // row shape; the split form also checks that Resident 1 and Resident 2
      // are not the same person.
      let residents;
      let pgy;
      if (combinedAt >= 0) {
        const residentsCell = parseRosterResidentsCell(source[combinedAt]);
        residents = residentsCell.residents;
        pgy = residentsCell.pgy;
      } else {
        const resident1 = cleanResidentName(source[splitAt]);
        const resident2 = resident2At >= 0 ? cleanResidentName(source[resident2At]) : null;
        if (resident1 && resident2 && resident1.toLowerCase() === resident2.toLowerCase()) {
          errors.push({ row: rowNumber, message: 'Resident 1 and Resident 2 cannot be the same' });
          continue;
        }
        residents = [resident1, resident2].filter(Boolean);
        pgy = resident1PgyAt >= 0 ? cellText(source[resident1PgyAt]) || null : null;
      }
      if (!pgy) pgy = sessionAt >= 0 ? cellText(source[sessionAt]) || null : null;
      if (!pgy) pgy = parsed.pgy;

      const faculty = facultyAt >= 0 ? parseFacultyCell(source[facultyAt]) : null;
      const inCharge =
        (inChargeAt >= 0 ? parseInChargeCell(source[inChargeAt]) : null) || parsed.inCharge;

      if (residents.length === 0 && !faculty) continue;
      if (residents.length > 0 && !pgy) {
        errors.push({ row: rowNumber, field: residentsField, message: 'does not include a PGY level' });
        continue;
      }

      rows.push({
        row: rowNumber,
        format,
        cellRef: `${columnName(clinicAt)}${rowNumber}`,
        dayOfWeek: parsed.dayOfWeek,
        shift: parsed.shift,
        pgy: pgy || null,
        clinicTitle: title,
        clinicNumber: resolved.clinicNumber ?? null,
        unresolvedTitle: resolved.unresolvedTitle ?? null,
        residents,
        faculty,
        inCharge,
      });
    }
  } else {
    const idx = {
      dayTime: headerIndex(headers, LEGACY_ALIASES.dayTime),
      sessionContext: headerIndex(headers, LEGACY_ALIASES.sessionContext),
      clinicColumn: headerIndex(headers, LEGACY_ALIASES.clinicColumn),
      resident1Name: headerIndex(headers, LEGACY_ALIASES.resident1Name),
      resident1Pgy: headerIndex(headers, LEGACY_ALIASES.resident1Pgy),
      resident2Name: headerIndex(headers, LEGACY_ALIASES.resident2Name),
      resident2Pgy: headerIndex(headers, LEGACY_ALIASES.resident2Pgy),
      supervisingFaculty: headerIndex(headers, LEGACY_ALIASES.supervisingFaculty),
      facultyInCharge: headerIndex(headers, LEGACY_ALIASES.facultyInCharge),
    };

    const missing = [];
    if (idx.dayTime < 0) missing.push(LEGACY_HEADERS[0]);
    if (idx.sessionContext < 0) missing.push(LEGACY_HEADERS[1]);
    if (idx.clinicColumn < 0) missing.push(LEGACY_HEADERS[2]);
    if (idx.resident1Name < 0) missing.push(LEGACY_HEADERS[3]);
    if (idx.supervisingFaculty < 0) missing.push(LEGACY_HEADERS[7]);
    if (missing.length > 0) {
      throw new Error(`Missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
    }

    for (let i = headerRowIndex + 1; i < gridRows.length; i++) {
      const source = gridRows[i] ?? [];
      if (isBlankRow(source)) continue;
      dataRowCount += 1;
      const rowNumber = i + 1;
      const at = (key) => (idx[key] >= 0 ? cellText(source[idx[key]]) : '');

      const parsed = parseDayCell(at('dayTime'));
      const rowErrors = [];
      if (!parsed.dayOfWeek) {
        rowErrors.push({ row: rowNumber, field: LEGACY_HEADERS[0], message: 'does not name a day of the week' });
      }
      const clinicTitle = at('clinicColumn');
      if (!clinicTitle) rowErrors.push({ row: rowNumber, field: LEGACY_HEADERS[2], message: 'is required' });

      const r1 = at('resident1Name');
      const r2 = at('resident2Name');
      const r1Pgy = at('resident1Pgy');
      const r2Pgy = at('resident2Pgy');
      const faculty = at('supervisingFaculty');
      if (!r1) rowErrors.push({ row: rowNumber, field: LEGACY_HEADERS[3], message: 'is required' });
      if (!faculty) rowErrors.push({ row: rowNumber, field: LEGACY_HEADERS[7], message: 'is required' });
      if (r2 && !r2Pgy) {
        rowErrors.push({ row: rowNumber, field: LEGACY_HEADERS[6], message: 'is required when Resident 2 Name is provided' });
      }
      if (r2Pgy && !r2) {
        rowErrors.push({ row: rowNumber, field: LEGACY_HEADERS[5], message: 'is required when Resident 2 PGY is provided' });
      }
      if (r1 && r2 && r1.toLowerCase() === r2.toLowerCase()) {
        rowErrors.push({ row: rowNumber, message: 'Resident 1 and Resident 2 cannot be the same' });
      }
      if (rowErrors.length > 0) {
        errors.push(...rowErrors);
        continue;
      }

      const resolved = resolveTitle(clinicTitle);
      if (resolved.isLeaves) continue;
      if (resolved.unresolvedTitle) unresolvedTitles.add(resolved.unresolvedTitle);

      const pgy = at('sessionContext') || r1Pgy || null;
      rows.push({
        row: rowNumber,
        format,
        cellRef: `${columnName(idx.clinicColumn)}${rowNumber}`,
        dayOfWeek: parsed.dayOfWeek,
        shift: parsed.shift,
        pgy,
        clinicTitle,
        clinicNumber: resolved.clinicNumber ?? null,
        unresolvedTitle: resolved.unresolvedTitle ?? null,
        residents: r2 ? [r1, r2] : [r1],
        faculty,
        inCharge: at('facultyInCharge') || parsed.inCharge || null,
      });
    }

    // The legacy layout's metadata rows live above the header, exactly where
    // `parseMetadata` looks, so its cycle hints are already collected.
  }

  if (dataRowCount === 0 && errors.length === 0) {
    throw new Error('No clinic slot rows were found under the header.');
  }

  // Column titles the programme does not know become a single file-level error
  // rather than one complaint per row: the fix is the header, not fifty cells.
  for (const title of unresolvedTitles) {
    errors.push({
      field: 'Clinic Slot',
      message: `'${title}' is not a clinic column of this programme`,
    });
  }
  if (unresolvedTitles.size > 0) {
    for (const row of rows) delete row.unresolvedTitle;
  }

  return { format, rows, errors, metadata, dataRowCount };
}

/** 0-based column index -> spreadsheet column letters (`0` -> `A`). */
function columnName(index) {
  let value = Math.max(index, 0) + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

module.exports = {
  LEGACY_HEADERS,
  LEGACY_SAMPLE_ROWS,
  SHEET_MATRIX,
  SHEET_ROSTER,
  SHEET_METADATA,
  CCC_MATRIX_DAY_HEADER,
  CCC_MATRIX_IN_CHARGE_HEADER,
  CCC_MATRIX_LEAVES_HEADER,
  CCC_MATRIX_HEADERS,
  CCC_ROSTER_HEADERS,
  CCC_METADATA_POOLS_HEADING,
  CCC_METADATA_RATIONALE_HEADING,
  CCC_BANNER_KEYS,
  CCC_METADATA_KEYS,
  CCC_UNASSIGNED,
  CCC_NO_LEAVE,
  DAY_NAMES,
  WEEKDAY_SHORT,
  // Legacy names kept so existing requires keep working.
  HEADERS: LEGACY_HEADERS,
  SAMPLE_ROWS: LEGACY_SAMPLE_ROWS,
  generateCccMatrixTemplate,
  buildDynamicTemplate,
  buildCccTemplateBuffer,
  cccTemplateSheets,
  cccMatrixSheet,
  cccRosterSheet,
  cccMetadataSheet,
  cccTemplateBanner,
  parseCccMatrixFile,
  parseMetadata,
  canonicalDayName,
  bannerDateToCalendarDate,
  // Label helpers, shared with the PDF renderer and the template service so the
  // three artefacts cannot drift apart.
  cccDayDateLabel,
  cccFullDateLabel,
  cccDayLabel,
  cccBannerDateLabel,
  normalizeShiftLabel,
  cccFormatFacultyName,
  cccLeaveTypeLabel,
  cccCellText,
  cccRosterResidentsText,
  cccMatrixDayCell,
};
