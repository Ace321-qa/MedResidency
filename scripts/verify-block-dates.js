/**
 * Checks the block-date arithmetic that both halves of the app depend on.
 *
 *     node scripts/verify-block-dates.js
 *
 * `src/utils/blockDates.js` is the authority for what a block window is and
 * `mobile/src/utils/dateCalc.ts` is its client mirror; the mobile half is checked
 * by `mobile/scripts/verify-date-calc.ts`. What matters is that they agree, so
 * this file also states the expected answers as literals rather than recomputing
 * them, which is what makes it a real test rather than a restatement.
 *
 * No database and no running server required.
 */

const {
  DAY_NAMES,
  addDays,
  addMonths,
  dayNameOf,
  describeWindow,
  diffDays,
  durationWeeksBetween,
  endDateForDuration,
  isCalendarDate,
  normalizeWeekStartDay,
  resolveBlockWindow,
  weekEndDay,
} = require('../src/utils/blockDates');
const {
  academicYearMatchValues,
  expandAcademicYear,
  normalizeAcademicYear,
} = require('../src/utils/academicYear');
const { BLOCK_WINDOW_CASES, BLOCK_WINDOW_VALIDATION_CASES } = require('./date-parity-cases');

const failures = [];

function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    failures.push(label);
  }
}

/* ------------------------------------------------------------------ *
 * 1. The boundary rule from the brief, spelled out.
 * ------------------------------------------------------------------ */

console.log('\n-- 4-week blocks --');
assert('Sunday 05 Jul 2026 + 27 days = Saturday 01 Aug 2026', endDateForDuration('2026-07-05', 4), '2026-08-01');
assert('  ...and that day is a Saturday', dayNameOf('2026-08-01'), 'Saturday');
assert('Sunday 02 Aug 2026 + 27 days = Saturday 29 Aug 2026', endDateForDuration('2026-08-02', 4), '2026-08-29');
assert('Monday 06 Jul 2026 + 27 days = Sunday 02 Aug 2026', endDateForDuration('2026-07-06', 4), '2026-08-02');
assert('  ...and that day is a Sunday', dayNameOf('2026-08-02'), 'Sunday');

console.log('\n-- shorter blocks --');
assert('1 week from Sunday ends Saturday (+6)', endDateForDuration('2026-07-05', 1), '2026-07-11');
assert('2 weeks from Sunday ends Saturday (+13)', endDateForDuration('2026-07-05', 2), '2026-07-18');
assert('3 weeks from Sunday ends Saturday (+20)', endDateForDuration('2026-07-05', 3), '2026-07-25');
assert('1 week from Monday ends Sunday (+6)', endDateForDuration('2026-07-06', 1), '2026-07-12');
assert('2 weeks from Monday ends Sunday (+13)', endDateForDuration('2026-07-06', 2), '2026-07-19');
assert('3 weeks from Monday ends Sunday (+20)', endDateForDuration('2026-07-06', 3), '2026-07-26');

console.log('\n-- every block ends the day before it starts, any weekday --');
let boundaryOk = true;
const offenders = [];
for (let day = 1; day <= 31; day += 1) {
  for (let month = 1; month <= 12; month += 1) {
    const start = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!isCalendarDate(start)) continue;
    for (let weeks = 1; weeks <= 13; weeks += 1) {
      const end = endDateForDuration(start, weeks);
      const expected = DAY_NAMES[(new Date(`${start}T00:00:00Z`).getUTCDay() + 6) % 7];
      if (dayNameOf(end) !== expected) {
        boundaryOk = false;
        offenders.push(`${weeks}w ${start}->${end} (${dayNameOf(end)})`);
      }
    }
  }
}
assert('every 1-13 week block ends on the day before its start', boundaryOk, true);
if (offenders.length > 0) console.log(`        ${offenders.slice(0, 5).join(', ')}`);

console.log('\n-- the bug this replaces --');
// `weeks * 7` instead of `weeks * 7 - 1`: the old form landed on the *next*
// week's start day, which is what put block 5 on a Thursday in production.
assert('the naive weeks*7 offset lands one day late', addDays('2026-07-05', 4 * 7), '2026-08-02');
assert('production block 5 (Sun 25 Oct -> Thu 19 Nov) is rejected', resolveBlockWindow({
  start_date: '2026-10-25',
  end_date: '2026-11-19',
  duration_weeks: 4,
  week_start_day: 'SUNDAY',
}).errors.length > 0, true);
assert('  ...with the corrected Saturday named in the error', resolveBlockWindow({
  start_date: '2026-10-25',
  end_date: '2026-11-19',
  duration_weeks: 4,
  week_start_day: 'SUNDAY',
}).errors.some((m) => m.includes('2026-11-21')), true);

/* ------------------------------------------------------------------ *
 * 2. Round-tripping and validation.
 * ------------------------------------------------------------------ */

console.log('\n-- duration round trip --');
assert('4-week window measures back as 4', durationWeeksBetween('2026-07-05', '2026-08-01'), 4);
assert('28-day span is not a block', durationWeeksBetween('2026-07-05', '2026-08-01'.replace('08-01', '08-02')), null);
assert('inclusive day count', diffDays('2026-07-05', '2026-08-01') + 1, 28);

console.log('\n-- resolveBlockWindow --');
assert('start + duration derives the end', resolveBlockWindow({
  start_date: '2026-07-05',
  duration_weeks: 4,
  week_start_day: 'SUNDAY',
}), {
  start_date: '2026-07-05',
  end_date: '2026-08-01',
  duration_weeks: 4,
  starts_on: 'Sunday',
  ends_on: 'Saturday',
  errors: [],
});
assert('start + end derives the duration', resolveBlockWindow({
  start_date: '2026-07-06',
  end_date: '2026-08-02',
  week_start_day: 'MONDAY',
}), {
  start_date: '2026-07-06',
  end_date: '2026-08-02',
  duration_weeks: 4,
  starts_on: 'Monday',
  ends_on: 'Sunday',
  errors: [],
});
assert('agreeing dates produce no errors', resolveBlockWindow({
  start_date: '2026-07-05',
  end_date: '2026-08-01',
  duration_weeks: 4,
  week_start_day: 'SUNDAY',
}).errors, []);
assert('contradictory dates are rejected', resolveBlockWindow({
  start_date: '2026-07-05',
  end_date: '2026-08-08',
  duration_weeks: 4,
  week_start_day: 'SUNDAY',
}).errors.length, 1);
assert('a Monday start is rejected for a Sunday programme', resolveBlockWindow({
  start_date: '2026-07-06',
  duration_weeks: 4,
  week_start_day: 'SUNDAY',
}).errors.length, 1);
assert('an impossible date is rejected', resolveBlockWindow({
  start_date: '2026-02-31',
  duration_weeks: 4,
}).errors.length > 0, true);
assert('a missing length is rejected', resolveBlockWindow({ start_date: '2026-07-05' }).errors.length, 1);
assert('end before start is rejected', resolveBlockWindow({
  start_date: '2026-07-05',
  end_date: '2026-07-01',
}).errors.length, 1);
assert('a fractional week count is rejected', resolveBlockWindow({
  start_date: '2026-07-05',
  duration_weeks: 2.5,
}).errors.length, 1);

/* ------------------------------------------------------------------ *
 * 3. Helpers the forms depend on.
 * ------------------------------------------------------------------ */

console.log('\n-- months --');
assert('3-month evaluation period', addMonths('2026-08-01', 3), '2026-11-01');
assert('clamped to a shorter month', addMonths('2026-08-31', 3), '2026-11-30');
assert('across a year boundary', addMonths('2026-11-15', 3), '2027-02-15');

console.log('\n-- week start day --');
assert('Sunday programme ends on Saturday', weekEndDay('SUNDAY'), 'Saturday');
assert('Monday programme ends on Sunday', weekEndDay('MONDAY'), 'Sunday');
assert('abbreviations are accepted', normalizeWeekStartDay('mon'), 'Monday');
assert('getDay() indices are accepted', normalizeWeekStartDay(0), 'Sunday');
assert('nonsense is rejected', normalizeWeekStartDay('someday'), null);

console.log('\n-- labels --');
assert('window label collapses a shared month', describeWindow('2026-07-05', '2026-08-01'), 'Sun 05 Jul - Sat 01 Aug 2026');
assert('window label across months', describeWindow('2026-07-05', '2026-09-26'), 'Sun 05 Jul - Sat 26 Sep 2026');

console.log('\n-- academic year spellings --');
assert('slash normalises to hyphen', normalizeAcademicYear('2026/2027'), '2026-2027');
assert('a bare year expands', normalizeAcademicYear('2026'), '2026-2027');
assert('reads match both stored spellings', academicYearMatchValues('2026/2027').sort(), ['2026-2027', '2026/2027']);
assert('reads of junk match nothing', academicYearMatchValues('whenever'), ['whenever']);

/* ------------------------------------------------------------------ *
 * 4. Cross-implementation parity.
 *
 * These cases are shared with `mobile/scripts/verify-date-calc.ts`. Two separate
 * suites each proving the right answer in isolation cannot catch the two
 * implementations drifting apart, which is the failure that only shows up as a
 * rejected write in production.
 * ------------------------------------------------------------------ */

console.log('\n-- parity with the mobile implementation --');

/**
 * The fixture names functions as strings so one file can be read by both a
 * CommonJS script and a TypeScript one. Resolving those names through an explicit
 * map rather than `eval` means a typo fails loudly instead of running something.
 */
const PARITY_FUNCTIONS = {
  addDays,
  addMonths,
  diffDays,
  endDateForDuration,
  expandAcademicYear,
  normalizeAcademicYear,
  normalizeWeekStartDay,
  weekEndDay,
};

for (const testCase of BLOCK_WINDOW_CASES) {
  const fn = PARITY_FUNCTIONS[testCase.fn];
  if (typeof fn !== 'function') {
    failures.push(`parity case names an unknown function: ${testCase.fn}`);
    console.log(`FAIL  unknown function ${testCase.fn}`);
    continue;
  }
  assert(
    `${testCase.fn}(${testCase.args.map((arg) => JSON.stringify(arg)).join(', ')})`,
    fn(...testCase.args),
    testCase.expected,
  );
}

for (const testCase of BLOCK_WINDOW_VALIDATION_CASES) {
  const result = resolveBlockWindow(testCase.input);
  // Only assert the keys the case actually declares. `resolveBlockWindow` echoes
  // the input dates back even when it rejects them, so an expectation of
  // `undefined` would be asserting an accident of that echoing, not a contract.
  const actual = { errorCount: result.errors.length };
  const expected = { errorCount: testCase.errorCount };
  if ('start' in testCase) actual.start = result.start_date;
  if ('end' in testCase) actual.end = result.end_date;
  if ('start' in testCase) expected.start = testCase.start;
  if ('end' in testCase) expected.end = testCase.end;

  assert(`resolveBlockWindow: ${testCase.name}`, actual, expected);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nAll block-date checks passed.');