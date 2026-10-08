/**
 * Checks the 52-week Master Rotation Grid calendar and its Excel engine.
 *
 *     node scripts/verify-master-grid-52w.js
 *
 * The feature is defined by one date — Sunday 28/06/2026 — and 52 weeks of
 * arithmetic on top of it. Every expectation below is stated as a literal
 * (`'2026-07-26'`, `'26/06/2027'`) rather than recomputed with the code under
 * test, which is the only way an off-by-one in the week formula can fail a test
 * instead of passing it.
 *
 * Three things are checked:
 *
 *   1. `src/utils/masterGridCalendar.js` maps weeks 1..52 onto blocks 1..13.
 *   2. `src/utils/excel/grid.js` *generates* the institutional workbook —
 *      three header rows, 13 merged block headings, DD/MM/YYYY date rows.
 *   3. the same module *parses* it back — by date window, by heading, through
 *      merged cells and stray title rows — including the forward-fill rule that
 *      turns one merged cell into four populated weeks.
 *
 * The client mirror (`mobile/src/utils/masterGridCalendar.ts`) is transpiled and
 * checked against the same literals when TypeScript is installed, so the sheet
 * the server sends and the columns the app draws cannot drift apart.
 *
 * No database and no running server required.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const {
  MASTER_GRID_START,
  BLOCK_COUNT,
  WEEKS_PER_BLOCK,
  WEEK_COUNT,
  allWeeks,
  blockWeeks,
  blockWindows,
  clampWindow,
  formatDmy,
  formatShortRange,
  overlapsWeek,
  weekNumberForDate,
  weekWindow,
  weeksSpanned,
} = require('../src/utils/masterGridCalendar');
const {
  generateMasterGridTemplate,
  parseMasterGrid,
  parseHeaderDate,
} = require('../src/utils/excel/grid');

const failures = [];

function assertEqual(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    failures.push(label);
  }
}

/** Independent arithmetic: the formula from the brief, not the module's. */
function literalWeekStart(week) {
  const time = Date.UTC(2026, 5, 28) + (week - 1) * 7 * 86_400_000;
  const date = new Date(time);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
    date.getUTCDate(),
  ).padStart(2, '0')}`;
}

function literalWeekEnd(week) {
  const time = Date.UTC(2026, 5, 28) + ((week - 1) * 7 + 6) * 86_400_000;
  const date = new Date(time);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
    date.getUTCDate(),
  ).padStart(2, '0')}`;
}

function isoToDayName(iso) {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    new Date(`${iso}T00:00:00Z`).getUTCDay()
  ];
}

function buildSheet(rows, merges = []) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  if (merges.length > 0) ws['!merges'] = merges;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Master Grid');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/* ------------------------------------------------------------------ *
 * 1. The calendar.
 * ------------------------------------------------------------------ */

console.log('\n-- 52 weeks from 28/06/2026 --');
assertEqual('base start is Sunday 28/06/2026', MASTER_GRID_START, '2026-06-28');
assertEqual('13 blocks × 4 weeks = 52 columns', [BLOCK_COUNT, WEEKS_PER_BLOCK, WEEK_COUNT], [13, 4, 52]);
assertEqual('allWeeks() has 52 entries', allWeeks().length, 52);
assertEqual(
  'every week starts on a Sunday and ends on a Saturday',
  allWeeks().every((week) => isoToDayName(week.start) === 'Sunday' && isoToDayName(week.end) === 'Saturday'),
  true,
);
assertEqual(
  'every week matches 28/06/2026 + (W-1)×7 days',
  allWeeks().every((week, index) => week.start === literalWeekStart(index + 1) && week.end === literalWeekEnd(index + 1)),
  true,
);
assertEqual(
  'weeks are contiguous: each starts the day after the previous ends',
  allWeeks().every((week, index) => index === 0 || Date.parse(week.start) === Date.parse(allWeeks()[index - 1].end) + 86_400_000),
  true,
);
assertEqual(
  'week W sits in block ceil(W/4) at position ((W-1) mod 4) + 1',
  allWeeks().every(
    (week) => week.blockNumber === Math.ceil(week.weekNumber / 4) && week.weekInBlock === ((week.weekNumber - 1) % 4) + 1,
  ),
  true,
);

console.log('\n-- the dates the brief names --');
assertEqual('Block 1 W1 start', weekWindow(1).start, '2026-06-28');
assertEqual('Block 1 W1 end', weekWindow(1).end, '2026-07-04');
assertEqual('Block 1 W2 start', weekWindow(2).start, '2026-07-05');
assertEqual('Block 1 W2 end', weekWindow(2).end, '2026-07-11');
assertEqual('Block 1 W3 start', weekWindow(3).start, '2026-07-12');
assertEqual('Block 1 W3 end', weekWindow(3).end, '2026-07-18');
assertEqual('Block 1 W4 start', weekWindow(4).start, '2026-07-19');
assertEqual('Block 1 W4 end', weekWindow(4).end, '2026-07-25');
assertEqual('Block 2 W1 start', weekWindow(5).start, '2026-07-26');
assertEqual('Block 2 W1 end', weekWindow(5).end, '2026-08-01');
assertEqual('Block 13 W4 start', weekWindow(52).start, '2027-06-20');
assertEqual('Block 13 W4 end', weekWindow(52).end, '2027-06-26');
assertEqual('week 0 is outside the grid', weekWindow(0), null);
assertEqual('week 53 is outside the grid', weekWindow(53), null);

console.log('\n-- block windows --');
const blocks = blockWindows();
assertEqual('13 block windows', blocks.length, 13);
assertEqual('Block 1 window', [blocks[0].start, blocks[0].end], ['2026-06-28', '2026-07-25']);
assertEqual('Block 2 starts the day Block 1 ends', blocks[1].start, '2026-07-26');
assertEqual('Block 13 window', [blocks[12].start, blocks[12].end], ['2027-05-30', '2027-06-26']);
assertEqual(
  'blocks are contiguous across the year',
  blocks.every((block, index) => index === 0 || Date.parse(block.start) === Date.parse(blocks[index - 1].end) + 86_400_000),
  true,
);
assertEqual('blockWeeks(1) is weeks 1-4', blockWeeks(1).map((week) => week.weekNumber), [1, 2, 3, 4]);
assertEqual('blockWeeks(13) is weeks 49-52', blockWeeks(13).map((week) => week.weekNumber), [49, 50, 51, 52]);
assertEqual('blockWeeks(14) is empty', blockWeeks(14), []);

console.log('\n-- dates resolve back to weeks --');
assertEqual('28/06/2026 is week 1', weekNumberForDate('2026-06-28'), 1);
assertEqual('04/07/2026 (Saturday) is still week 1', weekNumberForDate('2026-07-04'), 1);
assertEqual('05/07/2026 is week 2', weekNumberForDate('2026-07-05'), 2);
assertEqual('25/07/2026 is week 4', weekNumberForDate('2026-07-25'), 4);
assertEqual('26/07/2026 is week 5', weekNumberForDate('2026-07-26'), 5);
assertEqual('26/06/2027 is week 52', weekNumberForDate('2027-06-26'), 52);
assertEqual('27/06/2026 is before the grid', weekNumberForDate('2026-06-27'), null);
assertEqual('27/06/2027 is after the grid', weekNumberForDate('2027-06-27'), null);

console.log('\n-- formatting --');
assertEqual('DD/MM/YYYY', formatDmy('2026-06-28'), '28/06/2026');
assertEqual('zero-padded month', formatDmy('2026-07-04'), '04/07/2026');
assertEqual('short range', formatShortRange('2026-06-28', '2026-07-04'), '28/06–04/07');
assertEqual('overlap: whole week inside', overlapsWeek(1, '2026-06-28', '2026-07-04'), true);
assertEqual('overlap: adjacent weeks excluded', overlapsWeek(2, '2026-06-28', '2026-07-04'), false);
assertEqual('overlap: shared Saturday counts', overlapsWeek(1, '2026-07-01', '2026-07-05'), true);
assertEqual('weeksSpanned of a block', weeksSpanned('2026-06-28', '2026-07-25'), 4);
assertEqual('clampWindow inside the block', clampWindow('2026-06-28', '2026-07-25', '2026-06-28', '2026-07-25'), {
  start: '2026-06-28',
  end: '2026-07-25',
});
assertEqual('clampWindow trims an overrun', clampWindow('2026-06-28', '2026-08-08', '2026-06-28', '2026-07-25'), {
  start: '2026-06-28',
  end: '2026-07-25',
});
assertEqual('clampWindow rejects a disjoint window', clampWindow('2026-09-01', '2026-09-07', '2026-06-28', '2026-07-25'), null);

/* ------------------------------------------------------------------ *
 * 2. The workbook.
 * ------------------------------------------------------------------ */

console.log('\n-- template --');
const template = generateMasterGridTemplate();
const workbook = XLSX.read(template, { type: 'buffer' });
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

assertEqual('sheet is named Master Grid', workbook.SheetNames[0], 'Master Grid');
assertEqual('super header carries the five left columns', rows[0].slice(0, 5), [
  'Resident Level',
  'Resident Name',
  'Corp. ID',
  'Mobile',
  'Email',
]);
assertEqual(
  'super header names Block 1 … Block 13',
  rows[0].filter((cell) => /^Block \d+$/.test(String(cell))),
  Array.from({ length: 13 }, (_, index) => `Block ${index + 1}`),
);
assertEqual('row 2 starts at 28/06/2026', rows[1][5], '28/06/2026');
assertEqual('row 2 step 2 is 05/07/2026', rows[1][6], '05/07/2026');
assertEqual('row 2 last week is 20/06/2027', rows[1][5 + 51], '20/06/2027');
assertEqual('row 3 starts at 04/07/2026', rows[2][5], '04/07/2026');
assertEqual('row 3 last week is 26/06/2027', rows[2][5 + 51], '26/06/2027');
assertEqual('52 start-date cells', rows[1].slice(5).length, 52);
assertEqual(
  'every date row cell is DD/MM/YYYY',
  [...rows[1].slice(5), ...rows[2].slice(5)].every((cell) => /^\d{2}\/\d{2}\/\d{4}$/.test(String(cell))),
  true,
);
assertEqual(
  'date rows agree with the calendar',
  rows[1].slice(5).every((cell, index) => cell === formatDmy(weekWindow(index + 1).start)) &&
    rows[2].slice(5).every((cell, index) => cell === formatDmy(weekWindow(index + 1).end)),
  true,
);

const merges = sheet['!merges'] ?? [];
assertEqual('18 merges: 5 left headings + 13 block headings', merges.length, 18);
assertEqual(
  'left headings span the three header rows',
  merges.filter((range) => range.s.c < 5 && range.s.r === 0 && range.e.r === 2).length,
  5,
);
assertEqual(
  'each block heading spans four week columns',
  Array.from({ length: 13 }, (_, index) => {
    const firstColumn = 5 + index * 4;
    return merges.some(
      (range) => range.s.r === 0 && range.e.r === 0 && range.s.c === firstColumn && range.e.c === firstColumn + 3,
    );
  }).filter(Boolean).length,
  13,
);
assertEqual(
  'Block 1 heading sits over 28/06 – 19/07 start dates',
  [rows[0][5], rows[1][5], rows[1][8]],
  ['Block 1', '28/06/2026', '19/07/2026'],
);
assertEqual('two sample residents ship with the template', rows.length - 3, 2);
assertEqual(
  'samples show a full block, a 2+2 split and a one-week rotation',
  [rows[3][5], rows[3][9], rows[3][11], rows[4][5], rows[4][9], rows[4][10]],
  [
    'Medicine Inpatient',
    'Ped OPD',
    'NICU',
    'PHC',
    'Emergency Medicine',
    'Ped Inpatient',
  ],
);

/* ------------------------------------------------------------------ *
 * 3. Parsing it back.
 * ------------------------------------------------------------------ */

console.log('\n-- parser: the template round-trips --');
const parsed = parseMasterGrid(template);
assertEqual('layout detected from dates', parsed.layout, 'dates');
assertEqual('52 week columns', parsed.weekColumns.length, 52);
assertEqual('column 5 heads week 1', parsed.weekColumns.find((column) => column.columnIndex === 5).week, 1);
assertEqual('column 56 heads week 52', parsed.weekColumns.find((column) => column.columnIndex === 56).week, 52);
assertEqual('two resident rows', parsed.cells.length, 2);
assertEqual('resident A: block 1 in full', [parsed.cells[0].weeks[1], parsed.cells[0].weeks[4]], [
  'Medicine Inpatient',
  'Medicine Inpatient',
]);
assertEqual('resident A: 2 + 2 split survives', [
  parsed.cells[0].weeks[5],
  parsed.cells[0].weeks[6],
  parsed.cells[0].weeks[7],
  parsed.cells[0].weeks[8],
], ['Ped OPD', 'Ped OPD', 'NICU', 'NICU']);
assertEqual('resident B: one merged cell fans out across four weeks', [
  parsed.cells[1].weeks[1],
  parsed.cells[1].weeks[2],
  parsed.cells[1].weeks[3],
  parsed.cells[1].weeks[4],
], ['PHC', 'PHC', 'PHC', 'PHC']);
assertEqual('resident B: a one-week rotation stays one week', parsed.cells[1].weeks[5], 'Emergency Medicine');
assertEqual('resident B: the rotation after it fills the rest of the block', [
  parsed.cells[1].weeks[6],
  parsed.cells[1].weeks[7],
  parsed.cells[1].weeks[8],
], ['Ped Inpatient', 'Ped Inpatient', 'Ped Inpatient']);
assertEqual('forward-fill never crosses a block boundary', parsed.cells[1].weeks[13], undefined);
assertEqual('corporate id read as text', parsed.cells[0].corporateId, 'SAMPLE-001');
assertEqual('resident name read', parsed.cells[1].name, 'Sample Resident B — delete this row');

console.log('\n-- parser: an Excel that stores the dates as serial numbers --');
{
  const serialRows = [
    [
      'Resident Level',
      'Resident Name',
      'Corp. ID',
      'Mobile',
      'Email',
      ...Array.from({ length: 52 }, (_, i) => (i % 4 === 0 ? `Block ${i / 4 + 1}` : '')),
    ],
    ['', '', '', '', '', ...Array.from({ length: 52 }, (_, i) => 46202 + i * 7)],
    ['', '', '', '', '', ...Array.from({ length: 52 }, (_, i) => 46208 + i * 7)],
    ['PGY-1', 'Serial Resident', '51040', '', '', ...Array.from({ length: 52 }, () => '')],
  ];
  serialRows[3][5] = 'PHC';
  const variant = parseMasterGrid(buildSheet(serialRows));
  assertEqual('serial 46202 maps to week 1', weekNumberForDate(parseHeaderDate(46202)), 1);
  assertEqual('serial dates resolve to 52 weeks', variant.weekColumns.length, 52);
  assertEqual('merged-style single cell fills the block', [
    variant.cells[0].weeks[1],
    variant.cells[0].weeks[2],
    variant.cells[0].weeks[3],
    variant.cells[0].weeks[4],
  ], ['PHC', 'PHC', 'PHC', 'PHC']);
}

console.log('\n-- parser: a title row above the headers --');
{
  const titleRows = [
    ['Family Medicine — Master Grid 2026/2027'],
    ['Resident Level', 'Resident Name', 'Corp. ID', 'Mobile', 'Email', ...Array.from({ length: 13 }, (_, i) => `Block ${i + 1}`)],
    ['', '', '', '', '', ...allWeeks().map((week) => formatDmy(week.start))],
    ['', '', '', '', '', ...allWeeks().map((week) => formatDmy(week.end))],
    ['PGY-1', 'Titled Resident', '51041', '', '', ...Array.from({ length: 52 }, () => '')],
  ];
  titleRows[4][5] = 'MED';
  const variant = parseMasterGrid(buildSheet(titleRows));
  assertEqual('header row located under the title', variant.cells.length, 1);
  assertEqual('its corporate id was read', variant.cells[0].corporateId, '51041');
  assertEqual('its week 1 rotation was read', variant.cells[0].weeks[1], 'MED');
}

console.log('\n-- parser: legacy one-row headings --');
{
  const legacy = buildSheet([
    ['Resident Corporate ID', 'Resident Name', ...Array.from({ length: 13 }, (_, i) => `Block ${i + 1}`)],
    ['51040', 'Legacy Resident', 'PHC', '', 'MED', ...Array.from({ length: 10 }, () => '')],
  ]);
  const variant = parseMasterGrid(legacy);
  assertEqual('layout detected from headings', variant.layout, 'headings');
  assertEqual('13 headings fan out to 52 weeks', variant.weekColumns.length, 52);
  assertEqual('a filled block repeats across its four weeks', [
    variant.cells[0].weeks[1],
    variant.cells[0].weeks[2],
    variant.cells[0].weeks[4],
  ], ['PHC', 'PHC', 'PHC']);
  assertEqual('an empty block stays empty', [variant.cells[0].weeks[5], variant.cells[0].weeks[8]], [
    undefined,
    undefined,
  ]);
  assertEqual('a later block reads from its own heading', [
    variant.cells[0].weeks[9],
    variant.cells[0].weeks[12],
  ], ['MED', 'MED']);
}

console.log('\n-- parser: explicit week labels --');
{
  const labelled = buildSheet([
    ['Corp. ID', 'Resident Name', 'W1', 'W2', 'Block 3 W1', 'Week 9'],
    ['51040', 'Labelled Resident', 'PHC', 'PHC', 'NICU', 'PEC'],
  ]);
  const variant = parseMasterGrid(labelled);
  assertEqual('W1/W2/Block 3 W1/Week 9 all resolve', variant.weekColumns.map((column) => column.week), [
    1, 2, 9, 9,
  ]);
}

console.log('\n-- parser: header date cells read in every shape --');
assertEqual('DD/MM/YYYY', parseHeaderDate('28/06/2026'), '2026-06-28');
assertEqual('D/M/YYYY', parseHeaderDate('5/7/2026'), '2026-07-05');
assertEqual('ISO', parseHeaderDate('2026-06-28'), '2026-06-28');
assertEqual('month-first only when forced', parseHeaderDate('06/28/2026'), '2026-06-28');
assertEqual('serial number', parseHeaderDate(46202), '2026-06-28');
assertEqual('serial as text', parseHeaderDate('46202'), '2026-06-28');
assertEqual('an impossible date is refused', parseHeaderDate('31/02/2026'), null);
assertEqual('a rotation name is not a date', parseHeaderDate('Medicine Inpatient'), null);

console.log('\n-- parser: refusals --');
assert.throws(
  () => parseMasterGrid(buildSheet([['Resident Name', 'Block 1'], ['Omar', 'PHC']])),
  /Missing required column/,
  'a file without a corporate id column must be refused',
);
console.log('PASS  a file without a corporate id column is refused');
assert.throws(
  () =>
    parseMasterGrid(
      buildSheet([
        ['Corp. ID', 'Resident Name', 'Notes'],
        ['51040', 'Omar', 'no dates here'],
      ]),
    ),
  /No weekly columns/,
  'a file without week columns must be refused',
);
console.log('PASS  a file without week columns is refused');

/* ------------------------------------------------------------------ *
 * 4. The mobile mirror.
 * ------------------------------------------------------------------ */

console.log('\n-- mobile mirror (mobile/src/utils/masterGridCalendar.ts) --');
{
  const typescriptPath = path.join(__dirname, '..', 'mobile', 'node_modules', 'typescript');
  if (!fs.existsSync(typescriptPath)) {
    console.log('SKIP  typescript is not installed under mobile/, parity not checked');
  } else {
    const ts = require(typescriptPath);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'master-grid-52w-'));
    try {
      for (const file of ['dateCalc.ts', 'masterGridCalendar.ts']) {
        const source = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'src', 'utils', file), 'utf8');
        const output = ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
          fileName: file,
        }).outputText;
        fs.writeFileSync(path.join(outDir, file.replace(/\.ts$/, '.js')), output);
      }
      const client = require(path.join(outDir, 'masterGridCalendar.js'));

      assertEqual('client start date matches', client.MASTER_GRID_START, MASTER_GRID_START);
      assertEqual('client column counts match', [client.BLOCK_COUNT, client.WEEKS_PER_BLOCK, client.WEEK_COUNT], [13, 4, 52]);
      assertEqual(
        'client weeks match the server for all 52 columns',
        client.allWeeks().map((week) => `${week.start}/${week.end}`),
        allWeeks().map((week) => `${week.start}/${week.end}`),
      );
      assertEqual('client Block 13 W4 matches', [client.weekWindow(52).start, client.weekWindow(52).end], [
        '2027-06-20',
        '2027-06-26',
      ]);
      assertEqual('client resolves a date to the same week', client.weekNumberForDate('2026-07-26'), 5);
      assertEqual('client short range matches', client.formatShortRange('2026-06-28', '2026-07-04'), '28/06–04/07');
      assertEqual(
        'client weeksForRange matches overlap of weeks 1-2',
        client.weeksForRange('2026-06-28', '2026-07-11'),
        [1, 2],
      );
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
}

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('ALL 52-week master grid checks passed');
