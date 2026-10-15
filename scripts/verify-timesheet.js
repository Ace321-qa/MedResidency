/**
 * Server-side contract for the single-day timesheet and the duty-time helpers.
 *
 * A timesheet row is one calendar day: bare `HH:MM` clock times bounded by the
 * row's `Shift Date`, with `24:00` as the day boundary, and an overnight shift
 * written as two rows. This suite pins that contract from both ends — the pure
 * clock arithmetic in `src/utils/dutyTime.js` and the Excel round-trip in
 * `src/utils/excel/timesheet.js` — because the two are the only things standing
 * between a coordinator's spreadsheet and a stored duty-hours record.
 *
 * Run with `node scripts/verify-timesheet.js`.
 */

const assert = require('assert');
const {
  parseTimeOfDay,
  normalizeClockTime,
  decimalHoursBetween,
  addDays,
  continuousDutyChains,
  MINUTES_PER_DAY,
  DutyTimeError,
} = require('../src/utils/dutyTime');
const { parseTimesheetFile, generateTimesheetTemplate } = require('../src/utils/excel/timesheet');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name}\n        ${error.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
section('parseTimeOfDay — 24:00 is a boundary, not an error');
// ---------------------------------------------------------------------------

check('midnight is zero', () => assert.strictEqual(parseTimeOfDay('00:00'), 0));
check('a normal time is minutes past midnight', () => assert.strictEqual(parseTimeOfDay('08:30'), 8 * 60 + 30));
check('honours a leading zero-less hour', () => assert.strictEqual(parseTimeOfDay('8:05'), 8 * 60 + 5));
check('24:00 is the end of the day', () => assert.strictEqual(parseTimeOfDay('24:00'), MINUTES_PER_DAY));
check('seconds are ignored', () => assert.strictEqual(parseTimeOfDay('17:45:59'), 17 * 60 + 45));
check('23:59 is the last normal minute', () => assert.strictEqual(parseTimeOfDay('23:59'), 23 * 60 + 59));
check('24:01 is rejected', () => assert.strictEqual(parseTimeOfDay('24:01'), null));
check('25:00 is rejected', () => assert.strictEqual(parseTimeOfDay('25:00'), null));
check('a bad minute is rejected', () => assert.strictEqual(parseTimeOfDay('08:60'), null));
check('a non-time is rejected', () => assert.strictEqual(parseTimeOfDay('morning'), null));

// ---------------------------------------------------------------------------
section('normalizeClockTime — 24:00 rolls to the next midnight');
// ---------------------------------------------------------------------------

check('24:00 closes the shift day', () =>
  assert.strictEqual(normalizeClockTime('24:00', '2026-10-02'), '2026-10-03 00:00:00'));
check('a bare time pairs with the shift date', () =>
  assert.strictEqual(normalizeClockTime('08:00', '2026-10-02'), '2026-10-02 08:00:00'));
check('seconds are discarded', () =>
  assert.strictEqual(normalizeClockTime('2026-10-02 08:00:45'), '2026-10-02 08:00:00'));
check('an ISO T separator is accepted', () =>
  assert.strictEqual(normalizeClockTime('2026-10-02T17:30'), '2026-10-02 17:30:00'));
check('a bare 24:00 rolls even without a full stamp', () =>
  assert.strictEqual(normalizeClockTime('24:00', '2026-10-02'), '2026-10-03 00:00:00'));
check('an absent value stays absent', () => assert.strictEqual(normalizeClockTime(null), null));
check('a bare time without a date is an error', () =>
  assert.throws(() => normalizeClockTime('08:00'), DutyTimeError));

// ---------------------------------------------------------------------------
section('arithmetic primitives');
// ---------------------------------------------------------------------------

check('addDays crosses a month boundary', () =>
  assert.strictEqual(addDays('2026-10-31', 1), '2026-11-01'));
check('addDays handles a negative step', () =>
  assert.strictEqual(addDays('2026-01-01', -1), '2025-12-31'));
check('decimalHoursBetween measures a straight span', () =>
  assert.strictEqual(decimalHoursBetween('2026-10-02 08:00:00', '2026-10-02 17:00:00'), 9));
check('decimalHoursBetween reads a night as overnight', () =>
  assert.strictEqual(decimalHoursBetween('2026-10-02 20:00:00', '2026-10-02 06:00:00'), 10));

// ---------------------------------------------------------------------------
section('continuousDutyChains — a split call is one chain');
// ---------------------------------------------------------------------------

check('two split rows stitch into a 24-hour chain', () => {
  const chains = continuousDutyChains([
    { log_id: 1, clock_in: '2026-10-02 08:00:00', clock_out: '2026-10-03 00:00:00' },
    { log_id: 2, clock_in: '2026-10-03 00:00:00', clock_out: '2026-10-03 08:00:00' },
  ]);
  assert.strictEqual(chains.length, 1);
  assert.strictEqual(chains[0].totalHours, 24);
  assert.strictEqual(chains[0].logs.length, 2);
});

check('a gap of a day breaks the chain', () => {
  const chains = continuousDutyChains([
    { log_id: 1, clock_in: '2026-10-01 08:00:00', clock_out: '2026-10-01 17:00:00' },
    { log_id: 2, clock_in: '2026-10-03 08:00:00', clock_out: '2026-10-03 17:00:00' },
  ]);
  assert.strictEqual(chains.length, 2);
  assert.strictEqual(chains[0].totalHours, 9);
});

check('overlapping rows merge into one chain', () => {
  const chains = continuousDutyChains([
    { log_id: 1, clock_in: '2026-10-02 07:00:00', clock_out: '2026-10-03 07:00:00' },
    { log_id: 2, clock_in: '2026-10-02 19:00:00', clock_out: '2026-10-03 11:00:00' },
  ]);
  assert.strictEqual(chains.length, 1);
  assert.strictEqual(chains[0].totalHours, 28);
});

// ---------------------------------------------------------------------------
section('parseTimesheetFile — the workbook the client mirrors');
// ---------------------------------------------------------------------------

const SAMPLE_ROWS = [
  ['2026-10-01', 'PRESENT', '08:00', '17:00', 8, 'Regular day shift'],
  ['2026-10-02', 'ON_CALL', '08:00', '24:00', 16, 'Continuous duty (Part 1 - Day 1)'],
  ['2026-10-03', 'ON_CALL', '00:00', '08:00', 8, 'Continuous duty (Part 2 - Day 2)'],
];

function parseRows(rows) {
  return parseTimesheetFile(generateTimesheetTemplate(rows));
}

check('the template round-trips its own sample rows', () => {
  const { rows, errors } = parseTimesheetFile(generateTimesheetTemplate(SAMPLE_ROWS));
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(rows.length, 3);

  assert.strictEqual(rows[0].shift_date, '2026-10-01');
  assert.strictEqual(rows[0].clock_in, '2026-10-01 08:00:00');
  assert.strictEqual(rows[0].clock_out, '2026-10-01 17:00:00');
  assert.strictEqual(rows[0].total_hours, 8);
  assert.strictEqual(rows[0].attendance_status, 'PRESENT');

  // Part 1 ends at the day boundary: 24:00 becomes the next midnight.
  assert.strictEqual(rows[1].shift_date, '2026-10-02');
  assert.strictEqual(rows[1].clock_in, '2026-10-02 08:00:00');
  assert.strictEqual(rows[1].clock_out, '2026-10-03 00:00:00');
  assert.strictEqual(rows[1].total_hours, 16);

  // Part 2 is the same instant one day on, attributed to the new calendar day.
  assert.strictEqual(rows[2].shift_date, '2026-10-03');
  assert.strictEqual(rows[2].clock_in, '2026-10-03 00:00:00');
  assert.strictEqual(rows[2].clock_out, '2026-10-03 08:00:00');
  assert.strictEqual(rows[2].total_hours, 8);
});

check('hours are derived when the cell is blank', () => {
  const { rows } = parseRows([['2026-10-01', 'PRESENT', '08:00', '17:00', '', '']]);
  assert.strictEqual(rows[0].total_hours, 9);
});

check('statuses normalise from spaced spellings', () => {
  const { rows } = parseRows([['2026-10-01', 'annual leave', '08:00', '17:00', 9, '']]);
  assert.strictEqual(rows[0].attendance_status, 'ANNUAL_LEAVE');
});

check('a renamed header is still understood', () => {
  const legacy = require('xlsx');
  const ws = legacy.utils.aoa_to_sheet([
    ['Date', 'Status', 'Clock In', 'Clock Out', 'Hours', 'Notes'],
    ['2026-10-01', 'PRESENT', '08:00', '17:00', 9, ''],
  ]);
  const wb = legacy.utils.book_new();
  legacy.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buffer = legacy.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const { rows } = parseTimesheetFile(buffer);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].total_hours, 9);
});

check('a legacy full stamp keeps only its clock', () => {
  const legacy = require('xlsx');
  const ws = legacy.utils.aoa_to_sheet([
    ['Shift Date', 'Attendance Status', 'Clock In', 'Clock Out', 'Total Hours', 'Notes'],
    ['2026-10-01', 'PRESENT', '2026-10-01 08:00', '2026-10-01 17:00', '', ''],
  ]);
  const wb = legacy.utils.book_new();
  legacy.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buffer = legacy.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const { rows } = parseTimesheetFile(buffer);
  assert.strictEqual(rows[0].clock_in, '2026-10-01 08:00:00');
  assert.strictEqual(rows[0].clock_out, '2026-10-01 17:00:00');
});

// ---------------------------------------------------------------------------
section('parseTimesheetFile — the rejections');
// ---------------------------------------------------------------------------

function firstError(rows) {
  const { errors } = parseRows(rows);
  assert.ok(errors.length > 0, 'expected an error but the row parsed');
  return errors[0];
}

check('an unsplit overnight shift is rejected', () => {
  const error = firstError([['2026-10-02', 'ON_CALL', '20:00', '06:00', '', '']]);
  assert.match(error.message, /split an overnight shift/);
});

check('a clock-out past 24:00 is rejected', () => {
  const error = firstError([['2026-10-02', 'ON_CALL', '08:00', '25:00', '', '']]);
  assert.strictEqual(error.field, 'Clock Out Time');
});

check('24:00 is not allowed as a clock-in', () => {
  const error = firstError([['2026-10-02', 'ON_CALL', '24:00', '24:00', '', '']]);
  assert.match(error.message, /before 24:00/);
});

check('a missing shift date is rejected', () => {
  const error = firstError([['', 'PRESENT', '08:00', '17:00', '', '']]);
  assert.strictEqual(error.field, 'Shift Date');
});

check('an unknown status is rejected', () => {
  const error = firstError([['2026-10-01', 'HOLIDAY', '08:00', '17:00', '', '']]);
  assert.strictEqual(error.field, 'Attendance Status');
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
