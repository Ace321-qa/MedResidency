/**
 * End-to-end checks for the Rotations Catalogue API.
 *
 *     node scripts/verify-catalogue.js
 *
 * Needs the API on :5001 and a reachable MySQL, because what is under test is
 * the projection itself: the `rotations_catalogue` view over `rotations`, the
 * per-programme abbreviation rule the master grid resolves by, the workbook
 * round trip, and the delete that must refuse while a resident is still
 * scheduled against the rotation.
 *
 * Everything it creates is deleted again. The first list read is the baseline,
 * and the last assertion is that the catalogue is exactly what it was — a
 * verify script that quietly adds five rotations to a live programme is worse
 * than one that fails.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const db = require('../src/config/db');
const { HEADERS, SAMPLE_ROWS } = require('../src/utils/excel/catalogue');

const BASE = process.env.API_BASE || 'http://localhost:5001/api/v1';
const PROGRAM_ID = 1;
/** Prefix every hand-made test rotation uses, so cleanup cannot miss one. */
const TEST_PREFIX = 'TV-';

const failures = [];

function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    if (detail !== undefined) console.log(`        ${detail}`);
    failures.push(label);
  }
}

function equal(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    failures.push(label);
  }
}

/** Every row the API returns under `data`, or `[]`. */
async function listCatalogue(programId) {
  const res = await call('GET', `/rotations/catalogue?program_id=${programId}`);
  if (res.status !== 200) throw new Error(`list failed: ${res.status} ${res.text}`);
  return res.body.data;
}

async function call(method, apiPath, body, init = {}) {
  const response = await fetch(`${BASE}${apiPath}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...init,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text, headers: response.headers };
}

function workbookBuffer(headers, rows, sheetName = 'Rotations') {
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

/** POST `multipart/form-data` with an xlsx in the `file` field. */
async function uploadWorkbook(apiPath, headers, rows, fields = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  form.append(
    'file',
    new Blob([workbookBuffer(headers, rows)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    'catalogue.xlsx',
  );
  const response = await fetch(`${BASE}${apiPath}`, { method: 'POST', body: form });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text };
}

/** POST with no `file` field at all. */
async function uploadNothing(apiPath, fields = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  const response = await fetch(`${BASE}${apiPath}`, { method: 'POST', body: form });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text };
}

/** The sentence `flattenIssues` on the client would show for this response. */
function flattenIssues(body) {
  const raw = Array.isArray(body?.errors)
    ? body.errors
    : Array.isArray(body?.issues)
      ? body.issues
      : [];
  const sentences = raw.map((entry) => {
    if (typeof entry === 'string') return entry;
    const where = Number.isFinite(Number(entry.row)) ? `Row ${Number(entry.row)}: ` : '';
    const what = entry.field ? `${entry.field} ${entry.message}` : entry.message;
    return `${where}${what}`;
  });
  if (sentences.length === 0 && (body?.error || body?.message)) {
    return [String(body.error ?? body.message)];
  }
  return sentences.length > 0 ? sentences : ['The file was rejected for an unknown reason.'];
}

const createdIds = [];
const sampleAbbreviations = SAMPLE_ROWS.map((row) => String(row[2]).toUpperCase());

async function cleanup(baseline) {
  const current = await listCatalogue(PROGRAM_ID);
  const baselineIds = new Set(baseline.map((row) => row.id));
  const disposable = current.filter(
    (row) =>
      !baselineIds.has(row.id) &&
      (String(row.abbreviation).startsWith(TEST_PREFIX) || sampleAbbreviations.includes(row.abbreviation)),
  );
  for (const row of disposable) {
    await call('DELETE', `/rotations/catalogue/${row.id}`);
  }
  // The cross-programme row, and anything left from an aborted earlier run.
  const other = await listCatalogue(2);
  for (const row of other.filter((r) => String(r.abbreviation).startsWith(TEST_PREFIX))) {
    await call('DELETE', `/rotations/catalogue/${row.id}`);
  }
  for (const id of createdIds) {
    await call('DELETE', `/rotations/catalogue/${id}`);
  }
}

async function main() {
  const reachable = await fetch(`${BASE}/health`).then(
    (r) => r.ok,
    () => false,
  );
  if (!reachable) {
    console.error(`The API at ${BASE} is not answering. Start it with: node src/server.js`);
    process.exit(1);
  }

  /* ------------------------------------------------------------------ *
   * 1. The schema the whole feature rests on.
   * ------------------------------------------------------------------ */

  console.log('\n-- schema --');

  const [viewRows] = await db.query(
    "SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rotations_catalogue'",
  );
  equal('rotations_catalogue exists as a view', viewRows[0]?.TABLE_TYPE ?? null, 'VIEW');

  const [columnRows] = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rotations_catalogue' ORDER BY ORDINAL_POSITION",
  );
  equal(
    'the view projects every field the API promises',
    columnRows.map((row) => row.COLUMN_NAME),
    [
      'id',
      'program_id',
      'full_name',
      'department',
      'abbreviation',
      'is_active',
      'default_duration_weeks',
      'created_at',
      'updated_at',
    ],
  );

  const [indexRows] = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rotations' AND INDEX_NAME = 'uq_program_rotation_code' ORDER BY SEQ_IN_INDEX",
  );
  equal(
    'abbreviation uniqueness is a database constraint, not a check in code',
    indexRows.map((row) => row.COLUMN_NAME),
    ['program_id', 'rotation_code'],
  );

  /* ------------------------------------------------------------------ *
   * 2. Reading the catalogue.
   * ------------------------------------------------------------------ */

  console.log('\n-- reading --');

  const missingParam = await call('GET', '/rotations/catalogue');
  equal('GET without program_id is rejected', missingParam.status, 400);
  equal(
    'the rejection says which parameter is missing',
    missingParam.body?.error,
    'Missing required query parameter: program_id',
  );

  const baseline = await listCatalogue(PROGRAM_ID);
  equal('GET returns the seeded programme', baseline.length >= 5, true);
  equal(
    'every row carries the catalogue field names',
    baseline.every(
      (row) =>
        typeof row.id === 'number' &&
        typeof row.program_id === 'number' &&
        typeof row.full_name === 'string' &&
        typeof row.department === 'string' &&
        typeof row.abbreviation === 'string' &&
        typeof row.is_active === 'number' &&
        typeof row.default_duration_weeks === 'number',
    ),
    true,
  );
  equal(
    'abbreviations are returned upper case',
    baseline.every((row) => row.abbreviation === row.abbreviation.toUpperCase()),
    true,
  );
  const byName = (a, b) => {
    const left = a.toLowerCase();
    const right = b.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  };
  equal(
    'rows are ordered by rotation name',
    baseline.map((row) => row.full_name),
    baseline.map((row) => row.full_name).slice().sort(byName),
  );

  const otherProgramme = await listCatalogue(2);
  const baselineOther = otherProgramme.slice();
  check(
    'rotations are scoped to the programme that owns them',
    otherProgramme.every(
      (row) => row.program_id === 2 && !baseline.some((seeded) => seeded.id === row.id),
    ),
    JSON.stringify(otherProgramme.map((row) => ({ id: row.id, program_id: row.program_id }))),
  );

  /* ------------------------------------------------------------------ *
   * 3. Adding one by hand.
   * ------------------------------------------------------------------ */

  console.log('\n-- create --');

  const created = await call('POST', '/rotations/catalogue', {
    program_id: PROGRAM_ID,
    full_name: 'Verify Created Rotation',
    department: 'Verification Department',
    abbreviation: 'tv-create',
  });
  equal('POST creates a rotation', created.status, 201);
  equal('the abbreviation is stored upper case', created.body?.data?.abbreviation, 'TV-CREATE');
  equal('the department is stored as given', created.body?.data?.department, 'Verification Department');
  createdIds.push(created.body?.data?.id);

  const duplicate = await call('POST', '/rotations/catalogue', {
    program_id: PROGRAM_ID,
    full_name: 'Verify Duplicate Rotation',
    department: 'Verification Department',
    abbreviation: 'tv-create',
  });
  equal('a duplicate abbreviation in the same programme is 409', duplicate.status, 409);
  check(
    'the 409 explains the clash',
    /already used by another rotation/.test(duplicate.body?.error ?? ''),
    duplicate.body?.error,
  );

  const noDepartment = await call('POST', '/rotations/catalogue', {
    program_id: PROGRAM_ID,
    full_name: 'Verify Missing Department',
    abbreviation: 'TV-NODEPT',
  });
  equal('a missing department is a 400', noDepartment.status, 400);
  equal('the field is named in the error', noDepartment.body?.error, 'Hospital Department is required');

  const noProgramme = await call('POST', '/rotations/catalogue', {
    full_name: 'Verify No Programme',
    department: 'Verification Department',
    abbreviation: 'TV-NOPROG',
  });
  equal('a missing programme is a 400', noProgramme.status, 400);
  equal('the missing programme is named', noProgramme.body?.error, 'program_id is required');

  const unknownProgramme = await call('POST', '/rotations/catalogue', {
    program_id: 999999,
    full_name: 'Verify Unknown Programme',
    department: 'Verification Department',
    abbreviation: 'TV-BADPROG',
  });
  equal('an unknown programme is a 400', unknownProgramme.status, 400);
  check(
    'the unknown programme is named',
    /does not exist/.test(unknownProgramme.body?.error ?? ''),
    unknownProgramme.body?.error,
  );

  const longAbbreviation = await call('POST', '/rotations/catalogue', {
    program_id: PROGRAM_ID,
    full_name: 'Verify Long Abbreviation',
    department: 'Verification Department',
    abbreviation: 'x'.repeat(51),
  });
  equal('an abbreviation over 50 characters is a 400', longAbbreviation.status, 400);
  check(
    'the length limit is stated',
    /must be 50 characters or fewer/.test(longAbbreviation.body?.error ?? ''),
    longAbbreviation.body?.error,
  );

  const blankName = await call('POST', '/rotations/catalogue', {
    program_id: PROGRAM_ID,
    full_name: '   ',
    department: 'Verification Department',
    abbreviation: 'TV-BLANK',
  });
  equal('a blank name is a 400', blankName.status, 400);
  equal('the blank field is named', blankName.body?.error, 'Full Rotation Name is required');

  // Uniqueness is per programme on purpose: two programmes may both run a
  // "PHC" without either renaming itself after the other.
  const [programmeRows] = await db.query('SELECT id FROM programs WHERE id <> ? ORDER BY id LIMIT 1', [
    PROGRAM_ID,
  ]);
  if (programmeRows.length === 0) {
    console.log('SKIP  the same abbreviation in a second programme (no second programme exists)');
  } else {
    const elsewhere = await call('POST', '/rotations/catalogue', {
      program_id: programmeRows[0].id,
      full_name: 'Family Medicine Continuity Clinic',
      department: 'Family Medicine',
      abbreviation: 'FM-CLINIC',
    });
    equal('the same abbreviation may be reused by another programme', elsewhere.status, 201);
    createdIds.push(elsewhere.body?.data?.id);
  }

  /* ------------------------------------------------------------------ *
   * 4. Editing.
   * ------------------------------------------------------------------ */

  console.log('\n-- edit --');

  const edited = await call('PUT', `/rotations/catalogue/${created.body?.data?.id}`, {
    full_name: 'Verify Renamed Rotation',
    abbreviation: 'tv-edited',
  });
  equal('PUT renames a rotation', edited.status, 200);
  equal('the new name is returned', edited.body?.data?.full_name, 'Verify Renamed Rotation');
  equal('the new abbreviation is returned', edited.body?.data?.abbreviation, 'TV-EDITED');
  equal('an untouched field is left alone', edited.body?.data?.department, 'Verification Department');

  const clash = await call('PUT', `/rotations/catalogue/${created.body?.data?.id}`, {
    abbreviation: 'fm-clinic',
  });
  equal('renaming onto another rotation’s abbreviation is 409', clash.status, 409);

  const missing = await call('PUT', '/rotations/catalogue/999999', { full_name: 'Nowhere' });
  equal('editing a rotation that does not exist is 404', missing.status, 404);

  const nothing = await call('PUT', `/rotations/catalogue/${created.body?.data?.id}`, {});
  equal('an empty edit is a 400', nothing.status, 400);
  check(
    'the empty edit says what it wanted',
    /Nothing to update/.test(nothing.body?.error ?? ''),
    nothing.body?.error,
  );

  const badId = await call('PUT', '/rotations/catalogue/abc', { full_name: 'Nope' });
  equal('a non-numeric id is a 400', badId.status, 400);

  /* ------------------------------------------------------------------ *
   * 5. The template.
   * ------------------------------------------------------------------ */

  console.log('\n-- template --');

  const templateResponse = await fetch(`${BASE}/rotations/catalogue/template`);
  equal('the template downloads', templateResponse.status, 200);
  const disposition = templateResponse.headers.get('content-disposition') ?? '';
  check(
    'it is offered as a download',
    /rotations_catalogue_template\.xlsx/.test(disposition),
    disposition,
  );
  const templateBuffer = Buffer.from(await templateResponse.arrayBuffer());
  equal('it is a real xlsx (zip magic bytes)', templateBuffer.subarray(0, 2).toString('latin1'), 'PK');

  const workbook = XLSX.read(templateBuffer, { type: 'buffer' });
  equal('the workbook has one sheet named Rotations', workbook.SheetNames, ['Rotations']);
  const sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets.Rotations, {
    header: 1,
    raw: false,
    blankrows: false,
  });
  equal('the headers are the ones the parser looks for', sheetRows[0], HEADERS);
  equal('it ships the five sample rotations', sheetRows.slice(1), SAMPLE_ROWS);

  const clientSource = fs.readFileSync(
    path.join(__dirname, '..', 'mobile', 'src', 'services', 'excelTemplates.ts'),
    'utf8',
  );
  check(
    'the mobile client ships the same headers',
    HEADERS.every((header) => clientSource.includes(`'${header}'`)),
  );
  check(
    'the mobile client ships the same sample rows',
    SAMPLE_ROWS.flat().every((cell) => clientSource.includes(`'${cell}'`)),
  );
  check(
    'the mobile client downloads this endpoint',
    clientSource.includes("'/rotations/catalogue/template'"),
  );
  check(
    'the mobile client uploads to this endpoint',
    clientSource.includes("'/rotations/catalogue/import'"),
  );

  /* ------------------------------------------------------------------ *
   * 6. Bulk import.
   * ------------------------------------------------------------------ */

  console.log('\n-- import --');

  const beforeImport = (await listCatalogue(PROGRAM_ID)).length;

  const noFile = await uploadNothing('/rotations/catalogue/import', { program_id: PROGRAM_ID });
  equal('an upload with no file is a 400', noFile.status, 400);
  equal('it says so plainly', noFile.body?.error, 'No file was uploaded.');

  const aliasRows = [
    ['Verify Import One', 'Verification Department', 'TV-IMP-1'],
    ['Verify Import Two', 'Verification Department', 'TV-IMP-2'],
    ['Verify Import Three', 'Verification Department', 'TV-IMP-3'],
  ];
  const aliased = await uploadWorkbook(
    '/rotations/catalogue/import',
    ['Full Name', 'Hospital Dept', 'Abbr'],
    aliasRows,
    { program_id: PROGRAM_ID },
  );
  equal('renamed headers are accepted', aliased.status, 200);
  equal('three rows came in', aliased.body?.count, 3);
  equal('all three were new', aliased.body?.created, 3);
  const afterFirst = await listCatalogue(PROGRAM_ID);
  equal('the catalogue grew by exactly three', afterFirst.length, beforeImport + 3);
  equal(
    'the imported rows are readable through the API',
    afterFirst
      .filter((row) => String(row.abbreviation).startsWith('TV-IMP-'))
      .map((row) => row.abbreviation)
      .sort(),
    ['TV-IMP-1', 'TV-IMP-2', 'TV-IMP-3'],
  );

  const again = await uploadWorkbook(
    '/rotations/catalogue/import',
    ['Full Name', 'Hospital Dept', 'Abbr'],
    aliasRows,
    { program_id: PROGRAM_ID },
  );
  equal('uploading the same file again succeeds', again.status, 200);
  equal('nothing was created the second time', again.body?.created, 0);
  equal('the same three rows were updated', again.body?.updated, 3);
  equal('the catalogue did not grow', (await listCatalogue(PROGRAM_ID)).length, beforeImport + 3);

  const blankCell = await uploadWorkbook(
    '/rotations/catalogue/import',
    HEADERS,
    [['Verify Blank Abbreviation', 'Verification Department', '   ']],
    { program_id: PROGRAM_ID },
  );
  equal('a row with a blank abbreviation is a 400', blankCell.status, 400);
  equal(
    'the complaint carries the spreadsheet row number',
    blankCell.body?.issues,
    [{ row: 2, field: 'Abbreviation', message: 'is required' }],
  );
  equal(
    'it reads the way the app shows it',
    flattenIssues(blankCell.body),
    ['Row 2: Abbreviation is required'],
  );
  equal(
    'a rejected workbook writes nothing at all',
    (await listCatalogue(PROGRAM_ID)).length,
    beforeImport + 3,
  );

  const inFileDuplicate = await uploadWorkbook(
    '/rotations/catalogue/import',
    HEADERS,
    [
      ['Verify Duplicate First', 'Verification Department', 'TV-DUP'],
      ['Verify Duplicate Second', 'Verification Department', 'TV-DUP'],
    ],
    { program_id: PROGRAM_ID },
  );
  equal('the same abbreviation twice in one file is a 400', inFileDuplicate.status, 400);
  equal(
    'the second row is named',
    inFileDuplicate.body?.issues,
    [{ row: 3, field: 'Abbreviation', message: 'duplicates row 2 in this file (TV-DUP)' }],
  );

  const missingColumn = await uploadWorkbook(
    '/rotations/catalogue/import',
    ['Full Rotation Name', 'Hospital Department'],
    [['Verify Missing Column', 'Verification Department']],
    { program_id: PROGRAM_ID },
  );
  equal('a missing column is a 400', missingColumn.status, 400);
  equal(
    'the missing column is named',
    flattenIssues(missingColumn.body),
    ['File Missing required column: Abbreviation'],
  );

  const unknownProgrammeImport = await uploadWorkbook(
    '/rotations/catalogue/import',
    HEADERS,
    [['Verify Nowhere', 'Verification Department', 'TV-NOWHERE']],
    { program_id: 999999 },
  );
  equal('importing for a programme that does not exist is a 400', unknownProgrammeImport.status, 400);
  check(
    'it explains why',
    /no programme exists/.test((unknownProgrammeImport.body?.issues ?? []).map((i) => i.message).join(' ')),
    JSON.stringify(unknownProgrammeImport.body),
  );

  // The round trip a coordinator actually performs: download, do not touch,
  // upload. It must insert the five sample rotations the first time and only
  // update them afterwards.
  const expectedNew = sampleAbbreviations.filter(
    (abbreviation) => !baseline.some((row) => row.abbreviation === abbreviation),
  ).length;
  const untouchedTemplate = await (async () => {
    const form = new FormData();
    form.append('program_id', String(PROGRAM_ID));
    form.append(
      'file',
      new Blob([templateBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      'rotations_catalogue_template.xlsx',
    );
    const response = await fetch(`${BASE}/rotations/catalogue/import`, {
      method: 'POST',
      body: form,
    });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) };
  })();
  equal('the untouched template imports', untouchedTemplate.status, 200);
  equal('it contains five rows', untouchedTemplate.body?.count, 5);
  equal(
    'only the rows that were not already there were created',
    untouchedTemplate.body?.created,
    expectedNew,
  );
  equal(
    'every row was accounted for',
    (untouchedTemplate.body?.created ?? 0) + (untouchedTemplate.body?.updated ?? 0),
    5,
  );

  const templateAgain = await (async () => {
    const form = new FormData();
    form.append('program_id', String(PROGRAM_ID));
    form.append(
      'file',
      new Blob([templateBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      'rotations_catalogue_template.xlsx',
    );
    const response = await fetch(`${BASE}/rotations/catalogue/import`, {
      method: 'POST',
      body: form,
    });
    return { status: response.status, body: JSON.parse(await response.text()) };
  })();
  equal('uploading it twice is still a success', templateAgain.status, 200);
  equal('the second upload created nothing', templateAgain.body?.created, 0);
  equal(
    'the catalogue did not duplicate the samples',
    (await listCatalogue(PROGRAM_ID)).length,
    beforeImport + 3 + expectedNew,
  );

  /* ------------------------------------------------------------------ *
   * 7. Deleting.
   * ------------------------------------------------------------------ */

  console.log('\n-- delete --');

  const [referenced] = await db.query(
    `SELECT rotation_id AS id FROM resident_rotation_assignments GROUP BY rotation_id LIMIT 1`,
  );
  if (referenced.length === 0) {
    console.log('SKIP  deleting a rotation residents are assigned to (no assignments in the database)');
  } else {
    const protectedId = referenced[0].id;
    const refused = await call('DELETE', `/rotations/catalogue/${protectedId}`);
    equal('a rotation with assignments cannot be deleted', refused.status, 400);
    check(
      'the refusal counts the assignments',
      (refused.body?.assignments ?? 0) >= 1 && /resident assignment/.test(refused.body?.error ?? ''),
      `${refused.body?.assignments} — ${refused.body?.error}`,
    );
    equal('it also counts the ones still running', typeof refused.body?.active_assignments, 'number');
    equal(
      'the rotation is still there afterwards',
      (await listCatalogue(PROGRAM_ID)).some((row) => row.id === protectedId),
      true,
    );
  }

  const removable = createdIds.find(Boolean);
  const deleted = await call('DELETE', `/rotations/catalogue/${removable}`);
  equal('an unused rotation can be deleted', deleted.status, 200);
  equal('the response names the row it removed', deleted.body?.data?.id, removable);
  equal(
    'it is gone from the catalogue',
    (await listCatalogue(PROGRAM_ID)).some((row) => row.id === removable),
    false,
  );
  const deletedAgain = await call('DELETE', `/rotations/catalogue/${removable}`);
  equal('deleting it twice is a 404', deletedAgain.status, 404);

  const badDelete = await call('DELETE', '/rotations/catalogue/abc');
  equal('a non-numeric id is a 400', badDelete.status, 400);

  /* ------------------------------------------------------------------ *
   * 8. Leave the programme exactly as it was found.
   * ------------------------------------------------------------------ */

  console.log('\n-- cleanup --');

  await cleanup(baseline);
  const restored = await listCatalogue(PROGRAM_ID);
  equal(
    'every row this script added was removed',
    restored.map((row) => row.abbreviation).sort(),
    baseline.map((row) => row.abbreviation).sort(),
  );
  equal('the catalogue count is back to its baseline', restored.length, baseline.length);
  const otherRestored = await listCatalogue(2);
  equal(
    'the other programme is back to its own baseline',
    otherRestored.map((row) => row.abbreviation).sort(),
    baselineOther.map((row) => row.abbreviation).sort(),
  );
}

main()
  .catch((error) => {
    console.error(`\nThe catalogue checks could not run: ${error.message}`);
    failures.push(`run: ${error.message}`);
  })
  .finally(async () => {
    await db.end().catch(() => {});
    if (failures.length > 0) {
      console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
      process.exit(1);
    }
    console.log('\nAll rotation-catalogue checks passed.');
    process.exit(0);
  });
