/**
 * Checks the mobile date engine against the same expectations as the backend.
 *
 * `../src/utils/dateCalc.ts` is a hand-written mirror of the backend's
 * `src/utils/blockDates.js`, and the two drifting apart is the failure mode this
 * file exists to prevent: the phone would preview one window and the server
 * would store another.
 *
 * The parity cases at the bottom come from `scripts/date-parity-cases.js`, which
 * `scripts/verify-block-dates.js` also reads. Duplicating the expectations by hand
 * meant each suite could pass while the two implementations disagreed — the
 * duplication was the bug. Sharing one fixture means changing an answer on either
 * side fails the other side's suite, which is what CI running both is for.
 *
 * The remaining literals below cover behaviour that has no counterpart on the
 * backend: mobile-only helpers like `nextWeekday` and the display formatter.
 *
 * Run it with:
 *
 *     npx tsc -p tsconfig.verify.json && node .tmp/verify/mobile/scripts/verify-date-calc.js
 */

import {
  DAY_NAMES,
  addDays,
  addMonths,
  describeWindow,
  diffDays,
  durationWeeksBetween,
  endDateForDuration,
  evaluationEndDate,
  isCalendarDate,
  nextWeekday,
  normalizeWeekStartDay,
  resolveBlockWindow,
  weekEndDay,
} from '../src/utils/dateCalc';
import {
  academicYearMatchValues,
  expandAcademicYear,
  formatAcademicYear,
  normalizeAcademicYear,
  sameAcademicYear,
} from '../src/utils/academicYear';

import {
  BLOCK_WINDOW_CASES,
  BLOCK_WINDOW_VALIDATION_CASES,
} from '../../scripts/date-parity-cases.js';

const failures: string[] = [];

function assert(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    failures.push(label);
  }
}

/* ------------------------------------------------------------------ *
 * The boundary rule, identical to the backend check.
 * ------------------------------------------------------------------ */

console.log('\n-- 4-week blocks --');
assert('Sunday 05 Jul 2026 + 27 days = Saturday 01 Aug 2026', endDateForDuration('2026-07-05', 4), '2026-08-01');
assert('Monday 06 Jul 2026 + 27 days = Sunday 02 Aug 2026', endDateForDuration('2026-07-06', 4), '2026-08-02');
assert('Sunday 02 Aug 2026 + 27 days = Saturday 29 Aug 2026', endDateForDuration('2026-08-02', 4), '2026-08-29');

console.log('\n-- shorter blocks --');
assert('1 week from Sunday ends Saturday', endDateForDuration('2026-07-05', 1), '2026-07-11');
assert('2 weeks from Sunday ends Saturday', endDateForDuration('2026-07-05', 2), '2026-07-18');
assert('3 weeks from Sunday ends Saturday', endDateForDuration('2026-07-05', 3), '2026-07-25');
assert('1 week from Monday ends Sunday', endDateForDuration('2026-07-06', 1), '2026-07-12');
assert('2 weeks from Monday ends Sunday', endDateForDuration('2026-07-06', 2), '2026-07-19');
assert('3 weeks from Monday ends Sunday', endDateForDuration('2026-07-06', 3), '2026-07-26');

console.log('\n-- every block ends the day before it starts, any weekday --');
let boundaryOk = true;
const offenders: string[] = [];
for (let month = 1; month <= 12; month += 1) {
  for (let day = 1; day <= 31; day += 1) {
    const start = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!isCalendarDate(start)) continue;
    const startDay = new Date(`${start}T00:00:00Z`).getUTCDay();
    for (let weeks = 1; weeks <= 13; weeks += 1) {
      const end = endDateForDuration(start, weeks);
      if (!end || DAY_NAMES[new Date(`${end}T00:00:00Z`).getUTCDay()] !== DAY_NAMES[(startDay + 6) % 7]) {
        boundaryOk = false;
        offenders.push(`${weeks}w ${start}->${end}`);
      }
    }
  }
}
assert('every 1-13 week block ends on the day before its start', boundaryOk, true);
if (offenders.length > 0) console.log(`        ${offenders.slice(0, 5).join(', ')}`);

/* ------------------------------------------------------------------ *
 * Round-tripping and validation.
 * ------------------------------------------------------------------ */

console.log('\n-- duration round trip --');
assert('4-week window measures back as 4', durationWeeksBetween('2026-07-05', '2026-08-01'), 4);
assert('28-day span measured inclusively', (diffDays('2026-07-05', '2026-08-01') ?? 0) + 1, 28);
assert('endDateForDuration round-trips through durationWeeksBetween', durationWeeksBetween('2026-02-02', endDateForDuration('2026-02-02', 4) as string), 4);

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
assert('an impossible date is rejected', resolveBlockWindow({ start_date: '2026-02-31', duration_weeks: 4 }).errors.length > 0, true);
assert('a missing length is rejected', resolveBlockWindow({ start_date: '2026-07-05' }).errors.length, 1);
assert('end before start is rejected', resolveBlockWindow({ start_date: '2026-07-05', end_date: '2026-07-01' }).errors.length, 1);
assert('a fractional week count is rejected', resolveBlockWindow({ start_date: '2026-07-05', duration_weeks: 2.5 }).errors.length, 1);
assert(
  'the malformed production block is rejected',
  resolveBlockWindow({ start_date: '2026-10-25', end_date: '2026-11-19', duration_weeks: 4, week_start_day: 'SUNDAY' })
    .errors.some((message) => message.includes('2026-11-21')),
  true,
);

/* ------------------------------------------------------------------ *
 * Helpers the forms depend on.
 * ------------------------------------------------------------------ */

console.log('\n-- months --');
assert('3-month evaluation period', addMonths('2026-08-01', 3), '2026-11-01');
assert('clamped to a shorter month', addMonths('2026-08-31', 3), '2026-11-30');
assert('across a year boundary', addMonths('2026-11-15', 3), '2027-02-15');
assert('evaluationEndDate delegates to addMonths', evaluationEndDate('2026-09-01', 3), '2026-12-01');

console.log('\n-- week start day --');
assert('Sunday programme ends on Saturday', weekEndDay('SUNDAY'), 'Saturday');
assert('Monday programme ends on Sunday', weekEndDay('MONDAY'), 'Sunday');
assert('abbreviations are accepted', normalizeWeekStartDay('mon'), 'Monday');
assert('getDay() indices are accepted', normalizeWeekStartDay(0), 'Sunday');
assert('nonsense is rejected', normalizeWeekStartDay('someday'), null);

console.log('\n-- next weekday --');
assert('tomorrow when tomorrow matches', nextWeekday('2026-07-05', 'MONDAY'), '2026-07-06');
assert('a week on when today already matches', nextWeekday('2026-07-05', 'SUNDAY'), '2026-07-05');
assert('wraps into the next week', nextWeekday('2026-07-05', 'SATURDAY'), '2026-07-11');

console.log('\n-- labels --');
assert('window label across months', describeWindow('2026-07-05', '2026-08-01'), 'Sun 05 Jul - Sat 01 Aug 2026');
assert('window label across a year', describeWindow('2026-11-29', '2026-12-26'), 'Sun 29 Nov - Sat 26 Dec 2026');

console.log('\n-- academic year spellings --');
assert('slash normalises to hyphen', normalizeAcademicYear('2026/2027'), '2026-2027');
assert('a bare year expands', expandAcademicYear('2026'), '2026-2027');
assert('reads match both stored spellings', academicYearMatchValues('2026/2027').sort(), ['2026-2027', '2026/2027']);
assert('reads of junk match nothing', academicYearMatchValues('whenever'), ['whenever']);
assert('the two spellings are the same year', sameAcademicYear('2026/2027', '2026-2027'), true);
assert('different years are not the same year', sameAcademicYear('2026/2027', '2027/2028'), false);
assert('the display form keeps the slash', formatAcademicYear('2026-2027'), '2026/2027');

console.log('\n-- the naive offset this replaces --');
assert('weeks*7 lands one day late', addDays('2026-07-05', 4 * 7), '2026-08-02');

/* ------------------------------------------------------------------ *
 * Parity with the backend implementation.
 *
 * `scripts/verify-block-dates.js` asserts the same fixture against
 * `src/utils/blockDates.js`. These are the cases where "correct" is not a matter
 * of taste — inclusive week arithmetic, month-end clamping, leap days — and where
 * the phone and the server disagreeing is a rejected write in production.
 * ------------------------------------------------------------------ */

console.log('\n-- parity with the backend implementation --');

const PARITY_FUNCTIONS: Record<string, (...args: never[]) => unknown> = {
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
    fn(...(testCase.args as never[])),
    testCase.expected,
  );
}

for (const testCase of BLOCK_WINDOW_VALIDATION_CASES) {
  const result = resolveBlockWindow(
    testCase.input as unknown as Parameters<typeof resolveBlockWindow>[0],
  );
  // Only assert the keys the case declares: `resolveBlockWindow` echoes the input
  // dates back even when it rejects them.
  const actual: Record<string, unknown> = { errorCount: result.errors.length };
  const expected: Record<string, unknown> = { errorCount: testCase.errorCount };
  for (const key of ['start', 'end'] as const) {
    if (key in testCase) {
      actual[key] = key === 'start' ? result.start_date : result.end_date;
      expected[key] = testCase[key];
    }
  }
  assert(`resolveBlockWindow: ${testCase.name}`, actual, expected);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nAll mobile date checks passed.');