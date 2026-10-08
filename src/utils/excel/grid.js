const XLSX = require('xlsx');
const { makeBuffer, makeSheetBuffer } = require('./common');
const {
  BLOCK_COUNT,
  WEEKS_PER_BLOCK,
  WEEK_COUNT,
  blockWeeks,
  formatDmy,
  weekNumberForDate,
  weekWindow,
} = require('../masterGridCalendar');

/**
 * The master-grid and CCC workbooks.
 *
 * ## The master grid is a 52-week sheet, not a 13-column one
 *
 * The institutional spreadsheet this mirrors is laid out as 13 blocks of four
 * weekly subcolumns, running from Sunday 28/06/2026 to Saturday 26/06/2027:
 *
 *     row 1  Resident Level | Resident Name | Corp. ID | Mobile | Email
 *            |<-------- Block 1 -------->| |<-------- Block 2 --------| …
 *     row 2  (blank ×5)  28/06/2026  05/07/2026  12/07/2026 …   ← Start Sun
 *     row 3  (blank ×5)  04/07/2026  11/07/2026  18/07/2026 …   ← End Sat
 *     row 4+ one resident per row
 *
 * The dates are the contract. Columns are matched to weeks **by date window**
 * wherever they exist, because a coordinator who sorts, inserts or renames a
 * column must not silently shift every rotation one week to the left. Only when
 * a file carries no date rows does the parser fall back to headings —
 * `Block 3`, `W7`, `B2W3` — resolved against the same calendar.
 *
 * Both templates are handed out *and* parsed here, and the mobile client builds
 * the same workbook locally when the API is unreachable, so the header strings
 * are fixed — a name change here is a format change — while parsing accepts
 * close variants because coordinators rename columns.
 *
 * `mobile/src/services/excelTemplates.ts` builds the offline copy of this
 * template and must stay in step with `generateMasterGridTemplate`.
 */

/** The frozen left-hand columns, in order. */
const LEFT_HEADERS = ['Resident Level', 'Resident Name', 'Corp. ID', 'Mobile', 'Email'];

/** @deprecated Prefer `LEFT_HEADERS`; kept because callers import this name. */
const MASTER_HEADERS = LEFT_HEADERS;
const CCC_HEADERS = ['Academic Day / Clinic', 'Resident Pairings', 'Faculty Leads', 'Catchup Pools'];

/** `Corp. ID`, `Corporate ID`, `Employee id` … case- and punctuation-insensitively. */
const MASTER_CORP_ALIASES = [
  'corp. id',
  'corp id',
  'corporate id',
  'resident corporate id',
  'corporate/employee id',
  'employee id',
  'emp id',
  'staff id',
];

const NAME_ALIASES = ['resident name', 'name', 'resident'];
const LEVEL_ALIASES = ['resident level', 'pgy level', 'level', 'pgy'];
const MOBILE_ALIASES = ['mobile', 'mobile number', 'phone', 'contact', 'contact number'];
const EMAIL_ALIASES = ['email', 'e-mail', 'email address'];

/**
 * How many columns must resolve as in-range dates before a row is believed to
 * be the date header rather than a resident's data row.
 *
 * A data row has a handful of numeric cells (a corporate id at most), while a
 * real date row is almost entirely dates — so the count is paired with a share
 * check in `looksLikeDateRow`.
 */
const MIN_DATE_COLUMNS = 8;

/** Excel's day 0 for the 1900 date system, accounting for its 1900-02-29 bug. */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

function normalizeHeader(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function findHeader(headers, aliases) {
  const normalized = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const at = normalized.indexOf(alias);
    if (at >= 0) return at;
  }
  return -1;
}

/* ------------------------------------------------------------------ *
 * Dates inside a workbook: serial numbers, `DD/MM/YYYY`, ISO, locale.
 * ------------------------------------------------------------------ */

function isoFromUtc(year, month, day) {
  const time = Date.UTC(year, month - 1, day);
  const parsed = new Date(time);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** An Excel serial (`46201`) back to `YYYY-MM-DD`. */
function serialToIso(serial) {
  const days = Math.round(serial);
  if (!Number.isFinite(days) || days < 1 || days > 200_000) return null;
  const date = new Date(EXCEL_EPOCH_UTC + (days - 1) * MS_PER_DAY); // 1899-12-30 + 1 = 1899-12-31, but Excel 1900 leap year quirk
  return isoFromUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/**
 * Whatever shape a header date arrives in, as `YYYY-MM-DD`.
 *
 * Excel stores a typed date as a serial number and *displays* it in whatever
 * locale the workbook was created with, so `28/06/2026` may come back as
 * `46201`, `28/06/2026`, `6/28/2026` or `2026-06-28`. The only safe tie-break
 * when both halves are ≤ 12 is the institution's own convention: day first.
 *
 * @returns {string|null}
 */
function parseHeaderDate(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return isoFromUtc(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return serialToIso(value);
  }

  const text = String(value).trim();
  if (!text) return null;

  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (iso) return isoFromUtc(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  if (/^\d+(\.\d+)?$/.test(text)) {
    return serialToIso(Number(text));
  }

  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(text);
  if (!dmy) return null;

  let first = Number(dmy[1]);
  let second = Number(dmy[2]);
  let year = Number(dmy[3]);
  if (year < 100) year += 2000;

  // One of the two must be a month, and a month is never above 12.
  if (first > 12 && second <= 12) {
    return isoFromUtc(year, second, first);
  }
  if (second > 12 && first <= 12) {
    return isoFromUtc(year, first, second);
  }
  if (first > 12 || second > 12) return null;

  // Both ≤ 12: day-first, which is the format this template is written in.
  return isoFromUtc(year, second, first);
}

/* ------------------------------------------------------------------ *
 * Reading the workbook.
 * ------------------------------------------------------------------ */

/**
 * Both passes over the sheet, because neither alone is enough: `raw: false`
 * yields the *displayed* text (what a corporate id reads as, including any
 * leading zeros) while `raw: true` yields numbers — the only way to recognise a
 * date cell Excel has stored as a serial.
 */
function headerRow(buffer, sheetHint) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The file has no readable sheet.');

  const textRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, blankrows: false, defval: '' });
  const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false, defval: '' });

  return { textRows, rawRows, sheetName: wb.SheetNames[0] ?? sheetHint };
}

function isBlankRow(row) {
  return !row.some((value) => String(value ?? '').trim() !== '');
}

/**
 * The week each column of `rowIndex` heads, or null when the row is not a date
 * header.
 *
 * `mode` says which edge of the window the row carries: a "start" row maps each
 * date straight to its week, an "end" row maps it back six days first. Both are
 * accepted because a coordinator may have kept only the End Sat row.
 *
 * @returns {{week:number, columnIndex:number}[]|null} null when the row does not
 *   look like a date header at all.
 */
function resolveDateColumns(textRows, rawRows, rowIndex, mode) {
  const textRow = textRows[rowIndex] ?? [];
  const rawRow = rawRows[rowIndex] ?? [];
  const width = Math.max(textRow.length, rawRow.length);
  if (width === 0) return null;

  const columns = [];
  let nonEmpty = 0;

  for (let column = 0; column < width; column += 1) {
    const rawValue = rawRow[column];
    const textValue = textRow[column];
    const hasValue =
      (rawValue !== '' && rawValue !== null && rawValue !== undefined) ||
      String(textValue ?? '').trim() !== '';
    if (hasValue) nonEmpty += 1;

    const iso = parseHeaderDate(rawValue) ?? parseHeaderDate(textValue);
    if (!iso) continue;

    const week = mode === 'end' ? weekForEndDate(iso) : weekNumberForDate(iso);
    if (!week) continue;

    columns.push({ columnIndex: column, week });
  }

  if (columns.length < MIN_DATE_COLUMNS) return null;
  // A resident's data row is mostly rotation names; a date row is mostly dates.
  if (columns.length < nonEmpty * 0.5) return null;
  return columns;
}

/** Shift a `YYYY-MM-DD` string by whole days. */
function shiftIso(iso, days) {
  const time = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(time)) return iso;
  const shifted = new Date(time + days * MS_PER_DAY);
  return `${String(shifted.getUTCFullYear()).padStart(4, '0')}-${String(shifted.getUTCMonth() + 1).padStart(
    2,
    '0',
  )}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

/**
 * The week an End Sat date heads.
 *
 * A proper End Sat is the Saturday of its window, so it maps straight back; any
 * other weekday is walked to the Sunday that starts the same window, which is
 * how a stray `05/07/2026` typed into the End row still lands on a week instead
 * of being read as somebody's corporate id.
 */
function weekForEndDate(iso) {
  const direct = weekNumberForDate(iso);
  if (direct && weekWindow(direct).end === iso) return direct;
  const byStart = weekNumberForDate(shiftIso(iso, -6));
  return byStart ?? direct;
}

/** True when the row carries enough in-range dates to be a date header. */
function looksLikeDateRow(textRows, rawRows, rowIndex) {
  return (
    resolveDateColumns(textRows, rawRows, rowIndex, 'start') !== null ||
    resolveDateColumns(textRows, rawRows, rowIndex, 'end') !== null
  );
}

/**
 * Week columns from headings alone — the legacy single-header layout.
 *
 * Accepts `Block 3` (and a bare `3`), which fans out to that block's four
 * weeks, plus explicit week labels: `W7`, `Week 7`, `B2W3`, `Block 2 Week 3`.
 *
 * @returns {{week:number, columnIndex:number}[]}
 */
function resolveWeekColumnsFromHeadings(headers) {
  const columns = [];
  headers.forEach((header, columnIndex) => {
    const text = normalizeHeader(header);
    if (!text) return;

    const block = /^block\s*(\d+)$/.exec(text) ?? /^(\d{1,2})$/.exec(text);
    if (block) {
      const blockNumber = Number(block[1]);
      if (blockNumber >= 1 && blockNumber <= BLOCK_COUNT) {
        for (const week of blockWeeks(blockNumber)) {
          columns.push({ week: week.weekNumber, columnIndex });
        }
      }
      return;
    }

    const blockWeek = /^(?:block\s*)?b?\s*(\d{1,2})\s*[-/ ]?\s*w(?:eek)?\s*[-#. ]?\s*(\d{1,2})$/.exec(text);
    if (blockWeek) {
      const week = (Number(blockWeek[1]) - 1) * WEEKS_PER_BLOCK + Number(blockWeek[2]);
      if (week >= 1 && week <= WEEK_COUNT) columns.push({ week, columnIndex });
      return;
    }

    const weekOnly = /^w(?:eek)?\s*[-#. ]?\s*(\d{1,2})$/.exec(text);
    if (weekOnly) {
      const week = Number(weekOnly[1]);
      if (week >= 1 && week <= WEEK_COUNT) columns.push({ week, columnIndex });
    }
  });
  return columns;
}

/**
 * `Block 3`, `block3` and a bare `3` all name block 3.
 * @returns {{index:number, blockNumber:number}[]}
 */
function masterBlockColumns(headers) {
  const columns = [];
  headers.forEach((header, index) => {
    const text = normalizeHeader(header);
    const named = text.match(/^block\s*(\d+)$/);
    const bare = text.match(/^(\d+)$/);
    const blockNumber = named ? Number(named[1]) : bare ? Number(bare[1]) : null;
    if (blockNumber) columns.push({ index, blockNumber });
  });
  return columns;
}

/**
 * Carry a rotation forward across the empty weeks of its block.
 *
 * A 4-week rotation is entered once — often as a merged cell, which SheetJS
 * reads as one value followed by blanks — and a split block leaves its own
 * gaps (`Ped OPD` in weeks 1-2, blank in 3, `NICU` in 4). Filling forwards
 * *within a block only* handles both: the merged cell fans out, the split block
 * reads `Ped OPD, Ped OPD, NICU, NICU`, and a block left entirely empty stays
 * empty rather than inheriting its predecessor's rota, because "no rotation
 * here" is a gap a coordinator needs to see.
 *
 * @param {Record<number, string>} weeks
 */
function forwardFillWeeks(weeks) {
  for (let blockNumber = 1; blockNumber <= BLOCK_COUNT; blockNumber += 1) {
    let last = null;
    for (const week of blockWeeks(blockNumber)) {
      const value = weeks[week.weekNumber];
      if (value) {
        last = value;
      } else if (last !== null) {
        weeks[week.weekNumber] = last;
      }
    }
  }
}

/**
 * One row per resident, one column per week.
 *
 * @returns {{
 *   headers: string[],
 *   corporateIndex: number,
 *   layout: 'dates'|'headings',
 *   weekColumns: {week:number, columnIndex:number}[],
 *   cells: {row:number, corporateId:string, name:string, level:string,
 *           mobile:string, email:string, weeks:Record<number,string>}[],
 * }}
 */
function parseMasterGrid(buffer) {
  const { textRows, rawRows } = headerRow(buffer, 'Master Grid');
  if (textRows.length < 1) throw new Error('The file needs a header row.');

  // The corp-id heading may sit on row 1 or under a title a coordinator typed.
  let headerIndex = -1;
  for (let index = 0; index < Math.min(6, textRows.length); index += 1) {
    if (findHeader(textRows[index] ?? [], MASTER_CORP_ALIASES) >= 0) {
      headerIndex = index;
      break;
    }
  }
  if (headerIndex < 0) {
    throw new Error(
      `Missing required column: ${MASTER_HEADERS[2]} (accepted headings include ${MASTER_CORP_ALIASES
        .slice(0, 3)
        .join(', ')}).`,
    );
  }

  const headers = (textRows[headerIndex] ?? []).map((header) => String(header ?? '').trim());
  const corporateIndex = findHeader(headers, MASTER_CORP_ALIASES);
  const nameIndex = findHeader(headers, NAME_ALIASES);
  const levelIndex = findHeader(headers, LEVEL_ALIASES);
  const mobileIndex = findHeader(headers, MOBILE_ALIASES);
  const emailIndex = findHeader(headers, EMAIL_ALIASES);

  // --- week columns ------------------------------------------------------
  let weekColumns = null;
  let layout = 'dates';
  let firstDataRow = headerIndex + 1;

  for (let offset = 1; offset <= 3 && weekColumns === null; offset += 1) {
    const rowIndex = headerIndex + offset;
    if (rowIndex >= textRows.length) break;
    const columns = resolveDateColumns(textRows, rawRows, rowIndex, 'start');
    if (columns) {
      weekColumns = columns;
      firstDataRow = rowIndex + 1;
    }
  }
  if (weekColumns === null) {
    for (let offset = 1; offset <= 3 && weekColumns === null; offset += 1) {
      const rowIndex = headerIndex + offset;
      if (rowIndex >= textRows.length) break;
      const columns = resolveDateColumns(textRows, rawRows, rowIndex, 'end');
      if (columns) {
        weekColumns = columns;
        firstDataRow = rowIndex + 1;
      }
    }
  }
  if (weekColumns === null) {
    weekColumns = resolveWeekColumnsFromHeadings(headers);
    layout = 'headings';
  }
  if (!weekColumns || weekColumns.length === 0) {
    throw new Error(
      'No weekly columns were found. Expected date headers like 28/06/2026 (Start Sun / End Sat rows) or headings like "Block 1" or "W1".',
    );
  }

  // An End Sat row directly under the Start Sun row is still header, not data.
  while (
    firstDataRow < textRows.length &&
    firstDataRow - headerIndex <= 4 &&
    (isBlankRow(textRows[firstDataRow] ?? []) || looksLikeDateRow(textRows, rawRows, firstDataRow))
  ) {
    firstDataRow += 1;
  }

  // --- data rows ---------------------------------------------------------
  const cells = [];
  for (let index = firstDataRow; index < textRows.length; index += 1) {
    const source = textRows[index] ?? [];
    if (isBlankRow(source)) continue;

    const corporateId = String(source[corporateIndex] ?? '').trim();
    const pick = (column) => (column >= 0 ? String(source[column] ?? '').trim() : '');

    const weeks = {};
    for (const { week, columnIndex } of weekColumns) {
      const value = String(source[columnIndex] ?? '').trim();
      if (value !== '') weeks[week] = value;
    }
    forwardFillWeeks(weeks);

    cells.push({
      row: index + 1,
      corporateId,
      name: pick(nameIndex),
      level: pick(levelIndex),
      mobile: pick(mobileIndex),
      email: pick(emailIndex),
      weeks,
    });
  }

  return { headers, corporateIndex, layout, weekColumns, cells };
}

/* ------------------------------------------------------------------ *
 * Template
 * ------------------------------------------------------------------ */

/**
 * Two filled-in residents, so the sheet shows what "done" looks like: a full
 * four-week rotation repeated across its weeks, a 2+2 split inside one block, a
 * one-week rotation, and a merged cell that the importer is expected to fan out.
 *
 * They are recognisably fake (`SAMPLE-001`) and the importer skips any row
 * whose corporate id starts with "sample", so a template uploaded untouched
 * imports nothing rather than failing on residents who do not exist.
 */
function sampleRows() {
  const left = (level, name, id, mobile, email) => [level, name, id, mobile, email];
  const columnFor = (week) => LEFT_HEADERS.length + (week - 1);

  const rowA = left('PGY-1', 'Sample Resident A — delete this row', 'SAMPLE-001', '+971500000001', 'sample.a@example.org');
  const rowB = left('PGY-2', 'Sample Resident B — delete this row', 'SAMPLE-002', '+971500000002', 'sample.b@example.org');

  const fill = (row, week, value) => {
    row[columnFor(week)] = value;
  };

  // Resident A: block 1 in full, then a 2 + 2 split across block 2.
  for (let week = 1; week <= 4; week += 1) fill(rowA, week, 'Medicine Inpatient');
  fill(rowA, 5, 'Ped OPD');
  fill(rowA, 6, 'Ped OPD');
  fill(rowA, 7, 'NICU');
  fill(rowA, 8, 'NICU');

  // Resident B: a full block entered once (merged style), a single-week
  // rotation followed by a 3-week one, and a merged cell in block 3.
  fill(rowB, 1, 'PHC');
  fill(rowB, 5, 'Emergency Medicine');
  for (let week = 6; week <= 8; week += 1) fill(rowB, week, 'Ped Inpatient');
  fill(rowB, 9, 'Specialty OPD');

  return [rowA, rowB];
}

/**
 * The downloadable workbook: three header rows, merged block headings and the
 * sample residents.
 *
 * @param {number} [blockCount]
 * @returns {Buffer}
 */
function generateMasterGridTemplate(blockCount = BLOCK_COUNT) {
  const headerRowCells = [...LEFT_HEADERS];
  const startRow = LEFT_HEADERS.map(() => '');
  const endRow = LEFT_HEADERS.map(() => '');
  const merges = [];

  // The left-hand headings stand over all three header rows.
  LEFT_HEADERS.forEach((_, index) => {
    merges.push({ s: { r: 0, c: index }, e: { r: 2, c: index } });
  });

  const weeks = blockCount * WEEKS_PER_BLOCK;
  for (let week = 1; week <= weeks; week += 1) {
    const window = weekWindow(week);
    const isFirstWeekOfBlock = (week - 1) % WEEKS_PER_BLOCK === 0;
    headerRowCells.push(isFirstWeekOfBlock ? `Block ${window.blockNumber}` : '');
    startRow.push(formatDmy(window.start));
    endRow.push(formatDmy(window.end));

    if (isFirstWeekOfBlock) {
      const firstColumn = LEFT_HEADERS.length + (week - 1);
      merges.push({
        s: { r: 0, c: firstColumn },
        e: { r: 0, c: firstColumn + WEEKS_PER_BLOCK - 1 },
      });
    }
  }

  const rows = [headerRowCells, startRow, endRow, ...sampleRows()];
  return makeSheetBuffer(rows, 'Master Grid', merges);
}

function generateCccTemplate() {
  return makeBuffer(CCC_HEADERS, [], 'CCC Matrix');
}

/**
 * @returns {{headers:string[], rows:{row:number, dayClinic:string, pairings:string, faculty:string, catchup:string}[]}}
 */
function parseCcc(buffer) {
  const { textRows } = headerRow(buffer, 'CCC Matrix');
  if (textRows.length < 1) throw new Error('The file needs a header row.');

  const headers = (textRows[0] ?? []).map((header) => String(header ?? '').trim());
  const idx = {
    dayClinic: findHeader(headers, ['academic day / clinic', 'academic day/clinic', 'day / clinic', 'academic day', 'clinic']),
    pairings: findHeader(headers, ['resident pairings', 'residents', 'resident ids', 'resident names']),
    faculty: findHeader(headers, ['faculty leads', 'faculty', 'supervisor']),
    catchup: findHeader(headers, ['catchup pools', 'catch-up pools', 'catch up pools', 'catchup']),
  };
  if (idx.dayClinic < 0) {
    throw new Error(`Missing required column: ${CCC_HEADERS[0]}`);
  }

  const parsed = [];
  for (let i = 1; i < textRows.length; i++) {
    const source = textRows[i];
    if (!source || !source.some((value) => String(value ?? '').trim() !== '')) continue;
    const cell = (key) => (idx[key] >= 0 ? String(source[idx[key]] ?? '').trim() : '');
    parsed.push({
      row: i + 1,
      dayClinic: cell('dayClinic'),
      pairings: cell('pairings'),
      faculty: cell('faculty'),
      catchup: cell('catchup'),
    });
  }
  return { headers, rows: parsed };
}

module.exports = {
  LEFT_HEADERS,
  MASTER_HEADERS,
  CCC_HEADERS,
  masterBlockColumns,
  parseHeaderDate,
  forwardFillWeeks,
  generateMasterGridTemplate,
  parseMasterGrid,
  generateCccTemplate,
  parseCcc,
};
