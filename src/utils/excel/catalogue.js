const XLSX = require('xlsx');
const { makeBuffer } = require('./common');

/**
 * The rotation catalogue workbook: what the coordinator downloads, fills in and
 * uploads again.
 *
 * Three columns, because the catalogue is three facts about a rotation — what it
 * is called, which hospital department owns it, and the short code that appears
 * on every rota. The headers here are the exact strings the mobile client writes
 * when it builds the same template locally, so a file produced by either path
 * parses here, and parsing then accepts common renames (`Full Name`, `Hospital
 * Dept`, `Abbr`) because a parser must be forgiving even when the format is
 * not.
 *
 * Every rejected row comes back as `Row 4: Abbreviation is required` rather
 * than being dropped: a silently dropped rotation is one a coordinator believes
 * is available to assign when it is not.
 */

const HEADERS = ['Full Rotation Name', 'Hospital Department', 'Abbreviation'];

/**
 * Sample rows shipped with the template.
 *
 * These are real rotations rather than `DELETE ME` placeholders — the point of
 * the sample is to show the shape of a row *and* to give a programme starting
 * from nothing a catalogue it can edit instead of an empty grid. Importing the
 * workbook untouched therefore inserts five usable rotations, and importing it
 * a second time updates the same five (the upsert matches on abbreviation), so
 * the template is never a trap.
 */
const SAMPLE_ROWS = [
  ['Continuity Clinic', 'Primary Health Care', 'PHC'],
  ['Inpatient Medicine', 'Internal Medicine', 'MED-INP'],
  ['General Surgery Inpatient', 'Department of Surgery', 'SURG-INP'],
  ['Pediatrics Outpatient', 'Pediatrics', 'PEDS-OPD'],
  ['Emergency Department', 'Emergency Medicine', 'EMERG-OPD'],
];

/** Tolerant header aliases, matched against a lower-cased, trimmed header. */
const HEADER_ALIASES = {
  fullName: ['full rotation name', 'full name', 'full_name', 'rotation name', 'name'],
  department: ['hospital department', 'department', 'hospital dept', 'dept', 'department name'],
  abbreviation: ['abbreviation', 'abbr', 'code', 'rotation code', 'short code'],
};

const MAX_ABBREVIATION_LENGTH = 50;
const MAX_NAME_LENGTH = 255;

function headerIndex(headers, keys) {
  const normalised = headers.map((header) => String(header ?? '').trim().toLowerCase());
  for (const key of keys) {
    const at = normalised.indexOf(key);
    if (at >= 0) return at;
  }
  return -1;
}

function generateCatalogueTemplate() {
  return makeBuffer(HEADERS, SAMPLE_ROWS, 'Rotations');
}

/**
 * Parse and validate a catalogue upload.
 *
 * @returns {{rows: {row:number, full_name:string, department:string, abbreviation:string}[],
 *            errors: {row:number, field:string, message:string}[]}}
 *   `errors` is empty only when every row can be written as-is. Row numbers are
 *   spreadsheet row numbers (the header is row 1), so they point at the cell the
 *   coordinator has to fix.
 */
function parseCatalogueFile(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The file has no readable sheet.');

  // `blankrows: true` keeps empty rows in place, so the index of a row is its
  // spreadsheet row number. Dropping them here would make every reported row
  // number after a gap wrong by however many rows were skipped.
  const sheetRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, blankrows: true });
  if (sheetRows.length < 1) throw new Error('The file needs a header row.');

  const headers = (sheetRows[0] ?? []).map((header) => String(header ?? '').trim());
  const idx = {
    fullName: headerIndex(headers, HEADER_ALIASES.fullName),
    department: headerIndex(headers, HEADER_ALIASES.department),
    abbreviation: headerIndex(headers, HEADER_ALIASES.abbreviation),
  };

  if (idx.fullName < 0 || idx.department < 0 || idx.abbreviation < 0) {
    const missing = [];
    if (idx.fullName < 0) missing.push(HEADERS[0]);
    if (idx.department < 0) missing.push(HEADERS[1]);
    if (idx.abbreviation < 0) missing.push(HEADERS[2]);
    throw new Error(`Missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
  }

  const errors = [];
  const rows = [];
  const seenAbbreviations = new Map();

  for (let i = 1; i < sheetRows.length; i++) {
    const source = sheetRows[i] ?? [];
    const rowNumber = i + 1;
    if (!source.some((value) => String(value ?? '').trim() !== '')) continue;

    const cell = (key) => (idx[key] >= 0 ? String(source[idx[key]] ?? '').trim() : '');
    const fullName = cell('fullName');
    const department = cell('department');
    const abbreviation = cell('abbreviation').toUpperCase();

    const rowErrors = [];
    if (!fullName) rowErrors.push({ row: rowNumber, field: 'Full Rotation Name', message: 'is required' });
    else if (fullName.length > MAX_NAME_LENGTH) {
      rowErrors.push({ row: rowNumber, field: 'Full Rotation Name', message: `must be ${MAX_NAME_LENGTH} characters or fewer` });
    }
    if (!department) rowErrors.push({ row: rowNumber, field: 'Hospital Department', message: 'is required' });
    else if (department.length > MAX_NAME_LENGTH) {
      rowErrors.push({ row: rowNumber, field: 'Hospital Department', message: `must be ${MAX_NAME_LENGTH} characters or fewer` });
    }
    if (!abbreviation) rowErrors.push({ row: rowNumber, field: 'Abbreviation', message: 'is required' });
    else if (abbreviation.length > MAX_ABBREVIATION_LENGTH) {
      rowErrors.push({
        row: rowNumber,
        field: 'Abbreviation',
        message: `must be ${MAX_ABBREVIATION_LENGTH} characters or fewer`,
      });
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }

    // Two rows claiming one abbreviation would silently overwrite each other in
    // a single upload, so the second one is named and rejected.
    const duplicateOf = seenAbbreviations.get(abbreviation);
    if (duplicateOf !== undefined) {
      errors.push({
        row: rowNumber,
        field: 'Abbreviation',
        message: `duplicates row ${duplicateOf} in this file (${abbreviation})`,
      });
      continue;
    }
    seenAbbreviations.set(abbreviation, rowNumber);

    rows.push({ row: rowNumber, full_name: fullName, department, abbreviation });
  }

  if (rows.length === 0 && errors.length === 0) {
    throw new Error('No rotation rows were found under the header.');
  }

  return { rows, errors };
}

module.exports = {
  HEADERS,
  SAMPLE_ROWS,
  MAX_ABBREVIATION_LENGTH,
  generateCatalogueTemplate,
  parseCatalogueFile,
};
