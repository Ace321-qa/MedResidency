const XLSX = require('xlsx');
const { makeBuffer } = require('./common');

/**
 * The master-grid and CCC workbooks.
 *
 * Both templates are handed out *and* parsed here, and the mobile client builds
 * the same two workbooks locally when the API is unreachable. So the headers are
 * fixed strings — a name change here is a format change — and parsing accepts
 * close variants because coordinators rename columns.
 */

const MASTER_HEADERS = ['Resident Corporate ID', 'Resident Name'];
const CCC_HEADERS = ['Academic Day / Clinic', 'Resident Pairings', 'Faculty Leads', 'Catchup Pools'];

/** `Resident Corporate ID` or `Corporate ID`, case-insensitively. */
const MASTER_CORP_ALIASES = ['resident corporate id', 'corporate id', 'employee id', 'corporate/employee id'];

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

function headerRow(buffer, sheetHint) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The file has no readable sheet.');
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, blankrows: false });
  return { rows, sheetName: wb.SheetNames[0] ?? sheetHint };
}

function generateMasterGridTemplate(blockCount = 13) {
  const headers = [...MASTER_HEADERS];
  for (let i = 1; i <= blockCount; i++) headers.push(`Block ${i}`);
  return makeBuffer(headers, [], 'Master Grid');
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
 * @returns {{headers:string[], corporateIndex:number, cells:{row:number, corporateId:string, rotations:Record<number,string>}[]}}
 */
function parseMasterGrid(buffer) {
  const { rows } = headerRow(buffer, 'Master Grid');
  if (rows.length < 1) throw new Error('The file needs a header row.');

  const headers = rows[0].map((header) => String(header ?? '').trim());
  const corporateIndex = findHeader(headers, MASTER_CORP_ALIASES);
  if (corporateIndex < 0) {
    throw new Error(`Missing required column: ${MASTER_HEADERS[0]}`);
  }
  const blockColumns = masterBlockColumns(headers);
  if (blockColumns.length === 0) {
    throw new Error('No block columns were found. Expected headers like "Block 1" to "Block 13".');
  }

  const cells = [];
  for (let i = 1; i < rows.length; i++) {
    const source = rows[i];
    if (!source || !source.some((value) => String(value ?? '').trim() !== '')) continue;

    const corporateId = String(source[corporateIndex] ?? '').trim();
    // A row without a Corporate ID cannot be attributed to a resident. The
    // controller turns this into a `Row N: Corporate ID is required` error,
    // but the row still has to survive parsing so that error can be reported.
    const rotations = {};
    for (const column of blockColumns) {
      const value = String(source[column.index] ?? '').trim();
      if (value !== '') rotations[column.blockNumber] = value;
    }
    cells.push({ row: i + 1, corporateId, rotations });
  }

  return { headers, corporateIndex, cells };
}

function generateCccTemplate() {
  return makeBuffer(CCC_HEADERS, [], 'CCC Matrix');
}

/**
 * @returns {{headers:string[], rows:{row:number, dayClinic:string, pairings:string, faculty:string, catchup:string}[]}}
 */
function parseCcc(buffer) {
  const { rows } = headerRow(buffer, 'CCC Matrix');
  if (rows.length < 1) throw new Error('The file needs a header row.');

  const headers = rows[0].map((header) => String(header ?? '').trim());
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
  for (let i = 1; i < rows.length; i++) {
    const source = rows[i];
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
  MASTER_HEADERS,
  CCC_HEADERS,
  masterBlockColumns,
  generateMasterGridTemplate,
  parseMasterGrid,
  generateCccTemplate,
  parseCcc,
};