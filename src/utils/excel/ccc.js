const XLSX = require('xlsx');
const { makeBuffer, makeSheetBuffer } = require('./common');

const HEADERS = [
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

const HEADER_ALIASES = {
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

const SAMPLE_ROWS = [
  ['Sunday 10:30–14:00', 'PGY-3', 'Clinic 1', 'Maha Mansour Nguyen', 'PGY-3', '', '', 'Hassan Al-Hussein', 'Hassan Al-Hussein'],
  ['Sunday 10:30–14:00', 'PGY-3', 'Clinic 2', 'Amira Mansour', 'PGY-3', '', '', 'Areen Khalil', 'Hassan Al-Hussein'],
  ['Monday 10:30–14:00', 'PGY-3', 'Clinic 1', 'Yara Al-Malki', 'PGY-3', '', '', 'Ahmed Bawazir', 'Hassan Al-Hussein'],
  ['Tuesday 10:30–14:00', 'FMC', 'Clinic 1', 'Razan Hourani', 'PGY-1', 'Nematalla Abdelmaksoud', 'PGY-1', 'Saleh Al-Mutairi', 'Areen Khalil'],
  ['Wednesday 10:30–14:00', 'PGY-2', 'Clinic 1', 'Soha El-Sayed', 'PGY-2', '', '', 'Areen Khalil', 'Areen Khalil'],
];

function headerIndex(headers, keys) {
  const normalised = headers.map((header) => String(header ?? '').trim().toLowerCase());
  for (const key of keys) {
    const at = normalised.indexOf(key);
    if (at >= 0) return at;
  }
  return -1;
}

function generateCccMatrixTemplate(rows = SAMPLE_ROWS, sheetName = 'CCC Matrix') {
  return makeBuffer(HEADERS, rows, sheetName);
}

function buildDynamicTemplate(options = {}) {
  const clinicCount = Number(options.clinicCount) || 10;
  const startDate = options.startDate;
  const endDate = options.endDate;
  const cycle = options.cycle || '';
  const academicYear = options.academicYear || '';
  const viewMode = (options.viewMode || 'matrix').toLowerCase();
  const headers = [];
  if (viewMode === 'roster') {
    headers.push('Day / Time & Session');
    headers.push('Clinic Slot');
    headers.push('Resident(s) & PGY Level');
    headers.push('Supervising Faculty');
  } else {
    headers.push('DAY / SHIFT & PGY');
    headers.push('IN-CHARGE FACULTY');
    for (let i = 1; i <= clinicCount; i++) headers.push(`Clinic ${i}`);
    headers.push('Leaves / Away');
  }
  const metaRow = [`Academic Year: ${academicYear}`, `Cycle: ${cycle}`, `Week Start Date: ${startDate || ''}`, `Week End Date: ${endDate || ''}`, `Duration / Window: ${options.duration || ''}`].filter((x, i) => i < 5);
  while (metaRow.length < 5) metaRow.push('');
  const rows = [metaRow.slice(0, Math.max(metaRow.length, headers.length))];
  if (rows[0].length < headers.length) {
    for (let i = rows[0].length; i < headers.length; i++) rows[0].push('');
  } else if (rows[0].length > headers.length) {
    rows[0] = rows[0].slice(0, headers.length);
  }
  rows.push(headers);
  // minimal sample rows
  const sampleRows = [];
  if (viewMode === 'roster') {
    sampleRows.push(['Mon 12 Oct | 10:30 - 2:00 | PGY-2', 'Clinic 1', 'Razan Hourani & Soha / PGY-2', 'Dr. Saleh Al-Mutairi']);
    sampleRows.push(['Tue 13 Oct | 07:00 - 14:00 | FMC', 'Clinic 1', 'Unassigned', 'Dr. Areen Khalil']);
  } else {
    sampleRows.push(['Mon 12 Oct | 10:30 - 2:00 | PGY-2', 'Faculty In-charge: Dr. Hassan Al-Hussein', ...Array(clinicCount).fill('Unassigned'), 'No leave']);
    sampleRows.push(['Tue 13 Oct | 07:00 - 14:00 | FMC', 'Faculty In-charge: Dr. Areen Khalil', ...Array(clinicCount).fill('Unassigned'), 'No leave']);
  }
  return makeSheetBuffer([rows[0], headers, ...sampleRows], 'CCC Matrix');
}

function parseCccMatrixFile(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The file has no readable sheet.');

  const sheetRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, blankrows: true });
  if (sheetRows.length < 1) throw new Error('The file needs a header row.');

  let headerRowIndex = 0;
  for (let i = 0; i < Math.min(sheetRows.length, 15); i++) {
    const candidate = (sheetRows[i] ?? []).map((h) => String(h ?? '').trim().toLowerCase());
    if (candidate.some((c) => (c.includes('day') && (c.includes('time') || c.includes('clinic') || c.includes('shift'))) || c.includes('clinic slot') || c.includes('resident'))) {
      headerRowIndex = i;
      break;
    }
  }

  const headers = (sheetRows[headerRowIndex] ?? []).map((header) => String(header ?? '').trim());
  const idx = {
    dayTime: headerIndex(headers, HEADER_ALIASES.dayTime),
    sessionContext: headerIndex(headers, HEADER_ALIASES.sessionContext),
    clinicColumn: headerIndex(headers, HEADER_ALIASES.clinicColumn),
    resident1Name: headerIndex(headers, HEADER_ALIASES.resident1Name),
    resident1Pgy: headerIndex(headers, HEADER_ALIASES.resident1Pgy),
    resident2Name: headerIndex(headers, HEADER_ALIASES.resident2Name),
    resident2Pgy: headerIndex(headers, HEADER_ALIASES.resident2Pgy),
    supervisingFaculty: headerIndex(headers, HEADER_ALIASES.supervisingFaculty),
    facultyInCharge: headerIndex(headers, HEADER_ALIASES.facultyInCharge),
  };

  const required = [
    { key: 'dayTime', name: HEADERS[0] },
    { key: 'sessionContext', name: HEADERS[1] },
    { key: 'clinicColumn', name: HEADERS[2] },
    { key: 'resident1Name', name: HEADERS[3] },
    { key: 'resident1Pgy', name: HEADERS[4] },
    { key: 'supervisingFaculty', name: HEADERS[7] },
  ];
  const missing = required.filter((r) => idx[r.key] < 0).map((r) => r.name);
  if (missing.length > 0) {
    throw new Error(`Missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
  }

  const errors = [];
  const rows = [];
  const metadata = {
    cycleNumber: null,
    startDate: null,
  };

  for (let i = 0; i < Math.min(headerRowIndex, 10); i++) {
    const source = sheetRows[i] ?? [];
    const text = source.map((v) => String(v ?? '').trim().toLowerCase()).join(' ');
    if (/cycle.*number/.test(text)) {
      const val = source.find((v) => v && /cycle/i.test(String(v))) || source[source.length - 1];
      metadata.cycleNumber = String(val ?? '').replace(/.*cycle\s*/i, '').trim() || metadata.cycleNumber;
    }
    if (/start.*date|date.*start/.test(text)) {
      const val = source.find((v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim())) || source.find((v) => /\d{4}-\d{2}-\d{2}/.test(String(v)));
      if (val) metadata.startDate = String(val).trim();
    }
  }

  for (let i = headerRowIndex + 1; i < sheetRows.length; i++) {
    const source = sheetRows[i] ?? [];
    const rowNumber = i + 1;
    if (!source.some((value) => String(value ?? '').trim() !== '')) continue;

    const cell = (key) => (idx[key] >= 0 ? String(source[idx[key]] ?? '').trim() : '');

    const dayTime = cell('dayTime');
    const sessionContext = cell('sessionContext');
    const clinicColumn = cell('clinicColumn');
    const resident1Name = cell('resident1Name');
    const resident1Pgy = cell('resident1Pgy');
    const supervisingFaculty = cell('supervisingFaculty');

    const rowErrors = [];
    if (!dayTime) rowErrors.push({ row: rowNumber, field: 'Day / Time', message: 'is required' });
    if (!sessionContext) rowErrors.push({ row: rowNumber, field: 'Session / Context', message: 'is required' });
    if (!clinicColumn) rowErrors.push({ row: rowNumber, field: 'Clinic Column / Name', message: 'is required' });
    if (!resident1Name) rowErrors.push({ row: rowNumber, field: 'Resident 1 Name', message: 'is required' });
    if (!resident1Pgy) rowErrors.push({ row: rowNumber, field: 'Resident 1 PGY', message: 'is required' });
    if (!supervisingFaculty) rowErrors.push({ row: rowNumber, field: 'Supervising Faculty', message: 'is required' });

    const resident2Name = cell('resident2Name');
    const resident2Pgy = cell('resident2Pgy');
    if (resident2Name && !resident2Pgy) {
      rowErrors.push({ row: rowNumber, field: 'Resident 2 PGY', message: 'is required when Resident 2 Name is provided' });
    }
    if (resident2Pgy && !resident2Name) {
      rowErrors.push({ row: rowNumber, field: 'Resident 2 Name', message: 'is required when Resident 2 PGY is provided' });
    }
    if (resident1Name && resident2Name && resident1Name.toLowerCase() === resident2Name.toLowerCase()) {
      rowErrors.push({ row: rowNumber, message: 'Resident 1 and Resident 2 cannot be the same' });
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }

    rows.push({
      row: rowNumber,
      dayTime,
      sessionContext,
      clinicColumn,
      resident1Name,
      resident1Pgy,
      resident2Name: resident2Name || null,
      resident2Pgy: resident2Pgy || null,
      supervisingFaculty,
      facultyInCharge: cell('facultyInCharge') || null,
    });
  }

  if (rows.length === 0 && errors.length === 0) {
    throw new Error('No clinic slot rows were found under the header.');
  }

  return { rows, errors, metadata };
}

module.exports = {
  HEADERS,
  SAMPLE_ROWS,
  generateCccMatrixTemplate,
  parseCccMatrixFile,
  buildDynamicTemplate,
};
