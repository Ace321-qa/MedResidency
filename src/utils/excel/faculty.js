const XLSX = require('xlsx');
const { makeBuffer } = require('./common');

/**
 * The faculty preceptor workbook: the list a coordinator downloads, fills in
 * and uploads to bulk-register supervising faculty.
 *
 * Eight columns — the two name parts are the identity, the rest are optional
 * contact/department/rank detail. The headers here are the exact strings the mobile
 * client writes when it builds the same template locally, so a file produced by
 * either path parses here. Parsing accepts common renames, but every rejected
 * row comes back as `Row 4: First Name and Last Name are required` rather than
 * being dropped, because a silently dropped preceptor is one who never appears
 * in any In-Charge or Supervising Faculty dropdown.
 */

const HEADERS = ['First Name', 'Last Name', 'Email', 'Phone', 'Specialty', 'Clinical Title', 'Faculty Appointment', 'Admin Role'];

const DEFAULT_SPECIALTY = 'Family Medicine';

/** Three realistic rows so the file demonstrates the expected formats. */
const SAMPLE_ROWS = [
  ['Hassan', 'Al-Hussein', 'hassan.alhussein@hamad.qa', '+974 4439 1111', 'Family Medicine', 'Specialist', 'Core Faculty', 'None'],
  ['Areen', 'Al-Mansouri', 'areen.almansouri@hamad.qa', '+974 4439 2222', 'Family Medicine', 'Consultant', 'Teaching Faculty', 'General Educator'],
  ['Omar', 'Siddiqui', 'omar.siddiqui@hamad.qa', '+974 4439 3333', 'Internal Medicine', 'Senior Consultant', 'Adjunct / Visiting Faculty', 'Rotation Director'],
];

/** Tolerant header aliases, matched against a lower-cased, trimmed header. */
const HEADER_ALIASES = {
  firstName: ['first name', 'firstname', 'given name', 'givenname'],
  lastName: ['last name', 'lastname', 'surname', 'family name'],
  email: ['email', 'e-mail', 'email address'],
  phone: ['phone', 'phone number', 'mobile', 'mobile number', 'contact'],
  specialty: ['specialty', 'speciality', 'department', 'discipline'],
  clinicalTitle: ['clinical title', 'clinical_title', 'clinical title'],
  facultyAppointment: ['faculty appointment', 'faculty_appointment', 'faculty appointment'],
  adminRole: ['admin role', 'administrative_role', 'admin role'],
};

function headerIndex(headers, keys) {
  const normalised = headers.map((header) => String(header ?? '').trim().toLowerCase());
  for (const key of keys) {
    const at = normalised.indexOf(key);
    if (at >= 0) return at;
  }
  return -1;
}

function generateFacultyTemplate() {
  return makeBuffer(HEADERS, SAMPLE_ROWS, 'Faculty');
}

/** A deliberately permissive address check: something@something.something. */
function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Parse and validate a faculty upload.
 *
 * @returns {{rows: object[], errors: {row:number, field?:string, message:string}[]}}
 *   `errors` is empty only when every row can be written as-is. Row numbers are
 *   spreadsheet row numbers (the header is row 1), so they point at the cell the
 *   coordinator has to fix.
 */
function parseFacultyFile(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The file has no readable sheet.');

  // `blankrows: true` keeps empty rows in place, so the index of a row is its
  // spreadsheet row number.
  const sheetRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, blankrows: true });
  if (sheetRows.length < 1) throw new Error('The file needs a header row.');

  const headers = (sheetRows[0] ?? []).map((header) => String(header ?? '').trim());
  const idx = {
    firstName: headerIndex(headers, HEADER_ALIASES.firstName),
    lastName: headerIndex(headers, HEADER_ALIASES.lastName),
    email: headerIndex(headers, HEADER_ALIASES.email),
    phone: headerIndex(headers, HEADER_ALIASES.phone),
    specialty: headerIndex(headers, HEADER_ALIASES.specialty),
    clinicalTitle: headerIndex(headers, HEADER_ALIASES.clinicalTitle),
    facultyAppointment: headerIndex(headers, HEADER_ALIASES.facultyAppointment),
    adminRole: headerIndex(headers, HEADER_ALIASES.adminRole),
  };

  if (idx.firstName < 0 || idx.lastName < 0) {
    const missing = [];
    if (idx.firstName < 0) missing.push(HEADERS[0]);
    if (idx.lastName < 0) missing.push(HEADERS[1]);
    throw new Error(`Missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
  }

  const errors = [];
  const rows = [];

  for (let i = 1; i < sheetRows.length; i++) {
    const source = sheetRows[i] ?? [];
    const rowNumber = i + 1;
    if (!source.some((value) => String(value ?? '').trim() !== '')) continue;

    const cell = (key) => (idx[key] >= 0 ? String(source[idx[key]] ?? '').trim() : '');

    const firstName = cell('firstName');
    const lastName = cell('lastName');
    const email = cell('email');

    const rowErrors = [];
    if (!firstName && !lastName) {
      rowErrors.push({ row: rowNumber, message: 'First Name and Last Name are required' });
    } else {
      if (!firstName) rowErrors.push({ row: rowNumber, field: 'First Name', message: 'is required' });
      if (!lastName) rowErrors.push({ row: rowNumber, field: 'Last Name', message: 'is required' });
    }
    if (email && !isEmail(email)) {
      rowErrors.push({ row: rowNumber, field: 'Email', message: 'must be a valid email address' });
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }

    rows.push({
      row: rowNumber,
      first_name: firstName,
      last_name: lastName,
      email: email || null,
      phone: cell('phone') || null,
      specialty: cell('specialty') || DEFAULT_SPECIALTY,
      clinical_title: cell('clinicalTitle') || null,
      faculty_appointment: cell('facultyAppointment') || null,
      administrative_role: cell('adminRole') || null,
    });
  }

  if (rows.length === 0 && errors.length === 0) {
    throw new Error('No faculty rows were found under the header.');
  }

  return { rows, errors };
}

module.exports = {
  HEADERS,
  SAMPLE_ROWS,
  DEFAULT_SPECIALTY,
  generateFacultyTemplate,
  parseFacultyFile,
};
