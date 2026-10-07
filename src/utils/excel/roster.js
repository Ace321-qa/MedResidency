const XLSX = require('xlsx');
const { makeBuffer } = require('./common');

/**
 * The resident roster workbook: what the coordinator downloads, fills in, and
 * uploads again.
 *
 * The headers are the exact strings the mobile client writes when it builds the
 * template locally, so a file produced by either path parses here. Parsing then
 * accepts common renames — parsers must be forgiving even when the format is
 * not — but every rejected row comes back as `Row 4: Corporate ID is required`
 * rather than being dropped, because a silently dropped resident is a resident
 * who never appears on any rota.
 */

const HEADERS = [
  'First Name',
  'Middle Name',
  'Last Name',
  'Corporate ID',
  'PGY Level',
  'Email',
  'Mobile',
  'Training Site',
  'Start Date (YYYY-MM-DD)',
  'Expected Completion Date (YYYY-MM-DD)',
];

const HEADER_ALIASES = {
  firstName: ['first name'],
  middleName: ['middle name', 'middle initial'],
  lastName: ['last name', 'surname', 'family name'],
  corporateId: ['corporate id', 'corporate/employee id', 'employee id', 'corporate no', 'corp id'],
  pgyLevel: ['pgy level', 'pgy', 'year in program', 'level'],
  email: ['email', 'e-mail', 'email address'],
  mobile: ['mobile', 'mobile number', 'phone', 'phone number'],
  trainingSite: ['training site', 'site', 'hospital'],
  startDate: ['start date (yyyy-mm-dd)', 'start date'],
  expectedCompletion: [
    'expected completion date (yyyy-mm-dd)',
    'expected completion date',
    'completion date',
    'end date',
  ],
};

function headerIndex(headers, keys) {
  const normalised = headers.map((header) => String(header ?? '').trim().toLowerCase());
  for (const key of keys) {
    const at = normalised.indexOf(key);
    if (at >= 0) return at;
  }
  return -1;
}

function generateRosterTemplate() {
  return makeBuffer(HEADERS, [], 'Roster');
}

/** `2026-07-01`, or `null` when the cell is not a plain ISO date. */
function asIsoDate(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return Number.isNaN(new Date(`${match[0].slice(0, 10)}T00:00:00Z`).getTime()) ? null : match[0].slice(0, 10);
}

/**
 * Parse and validate a roster upload.
 *
 * @returns {{rows: object[], errors: {row:number, field:string, message:string}[]}}
 *   `errors` is empty only when every row can be written as-is.
 */
function parseRosterFile(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The file has no readable sheet.');

  const sheetRows = XLSX.utils
    .sheet_to_json(ws, { header: 1, raw: false, dateNF: 'YYYY-MM-DD', blankrows: false });
  if (sheetRows.length < 1) throw new Error('The file needs a header row.');

  const headers = sheetRows[0].map((header) => String(header ?? '').trim());
  const idx = {
    firstName: headerIndex(headers, HEADER_ALIASES.firstName),
    middleName: headerIndex(headers, HEADER_ALIASES.middleName),
    lastName: headerIndex(headers, HEADER_ALIASES.lastName),
    corporateId: headerIndex(headers, HEADER_ALIASES.corporateId),
    pgyLevel: headerIndex(headers, HEADER_ALIASES.pgyLevel),
    email: headerIndex(headers, HEADER_ALIASES.email),
    mobile: headerIndex(headers, HEADER_ALIASES.mobile),
    trainingSite: headerIndex(headers, HEADER_ALIASES.trainingSite),
    startDate: headerIndex(headers, HEADER_ALIASES.startDate),
    expectedCompletion: headerIndex(headers, HEADER_ALIASES.expectedCompletion),
  };

  if (idx.firstName < 0 || idx.lastName < 0 || idx.corporateId < 0) {
    const missing = [];
    if (idx.firstName < 0) missing.push(HEADERS[0]);
    if (idx.lastName < 0) missing.push(HEADERS[2]);
    if (idx.corporateId < 0) missing.push(HEADERS[3]);
    throw new Error(`Missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
  }

  const errors = [];
  const rows = [];

  for (let i = 1; i < sheetRows.length; i++) {
    const source = sheetRows[i];
    const rowNumber = i + 1;
    if (!source || !source.some((value) => String(value ?? '').trim() !== '')) continue;

    const cell = (key) => (idx[key] >= 0 ? String(source[idx[key]] ?? '').trim() : '');
    const rowErrors = [];

    const firstName = cell('firstName');
    const lastName = cell('lastName');
    const corporateId = cell('corporateId');

    if (!firstName) rowErrors.push({ row: rowNumber, field: 'First Name', message: 'is required' });
    if (!lastName) rowErrors.push({ row: rowNumber, field: 'Last Name', message: 'is required' });
    if (!corporateId) rowErrors.push({ row: rowNumber, field: 'Corporate ID', message: 'is required' });

    const pgyRaw = cell('pgyLevel');
    const pgyLevel = pgyRaw === '' ? null : Number(pgyRaw);
    if (pgyRaw !== '' && (!Number.isInteger(pgyLevel) || pgyLevel < 1)) {
      rowErrors.push({ row: rowNumber, field: 'PGY Level', message: 'must be a whole number of 1 or more' });
    }

    const startRaw = cell('startDate');
    const startDate = asIsoDate(startRaw);
    if (startRaw === '') {
      rowErrors.push({ row: rowNumber, field: 'Start Date', message: 'is required' });
    } else if (!startDate) {
      rowErrors.push({ row: rowNumber, field: 'Start Date', message: 'must be YYYY-MM-DD' });
    }

    const endRaw = cell('expectedCompletion');
    const expectedCompletionDate = asIsoDate(endRaw);
    if (endRaw === '') {
      rowErrors.push({ row: rowNumber, field: 'Expected Completion Date', message: 'is required' });
    } else if (!expectedCompletionDate) {
      rowErrors.push({ row: rowNumber, field: 'Expected Completion Date', message: 'must be YYYY-MM-DD' });
    }

    if (startDate && expectedCompletionDate && expectedCompletionDate <= startDate) {
      rowErrors.push({
        row: rowNumber,
        field: 'Expected Completion Date',
        message: 'must be after the start date',
      });
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }

    rows.push({
      row: rowNumber,
      first_name: firstName,
      middle_initial: cell('middleName') ? cell('middleName').slice(0, 10) : null,
      last_name: lastName,
      corporate_id: corporateId,
      pgy_level: pgyLevel,
      email: cell('email') || null,
      mobile: cell('mobile') || null,
      training_site: cell('trainingSite') || null,
      start_date: startDate,
      expected_completion_date: expectedCompletionDate,
    });
  }

  if (rows.length === 0 && errors.length === 0) {
    throw new Error('No resident rows were found under the header.');
  }

  return { rows, errors };
}

module.exports = { HEADERS, generateRosterTemplate, parseRosterFile };