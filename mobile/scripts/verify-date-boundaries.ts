/**
 * Checks the weekday-boundary formula engine the Master Rotation Grid is built
 * on: the inclusive end-date rule, the dynamic week-start arithmetic and the
 * calendar anchored to a Coordinator-chosen start day.
 *
 * The formula the whole feature rests on is:
 *
 *     End Date = Start Date + (N - 1) days
 *
 * so a 7-day week ends six days on, a 28-day block ends 27 days on, and the end
 * always falls on the day before the start's weekday — Sunday to Saturday,
 * Monday to Sunday, Wednesday to Tuesday, and so on.
 *
 * Run it with:
 *
 *     npx tsx mobile/scripts/verify-date-boundaries.ts
 */

import {
  DAY_NAMES,
  calculateBlockEndDate,
  calculateEndDate,
  calculateWeeklySubRanges,
  describeWindow,
} from '../src/utils/dateCalc';
import {
  allWeeks,
  blockWindow,
  formatShortRange,
  gridStartFrom,
  MASTER_GRID_START,
  weekNumberForDate,
  weekWindow,
} from '../src/utils/masterGridCalendar';

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

/** The weekday name of a `YYYY-MM-DD` string. */
function dayName(iso: string): string {
  return DAY_NAMES[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}

/* ------------------------------------------------------------------ *
 * The inclusive end-date formula, across every weekday boundary.
 * ------------------------------------------------------------------ */

console.log('\n-- the brief\'s boundary examples --');
// Sunday 28/06/2026 + 7 days -> Saturday 04/07/2026.
assert('Sunday start + 7 days ends Saturday', calculateEndDate('2026-06-28', 7), '2026-07-04');
assert('the week 1 end really is a Saturday', dayName(calculateEndDate('2026-06-28', 7) as string), 'Saturday');
// Sunday 28/06/2026 + 28 days -> Saturday 25/07/2026.
assert('Sunday start + 28 days ends Saturday', calculateEndDate('2026-06-28', 28), '2026-07-25');
assert('Block 1 from a Sunday ends Saturday', calculateBlockEndDate('2026-06-28', 4), '2026-07-25');

// Monday 29/06/2026 + 7 days -> Sunday 05/07/2026.
assert('Monday start + 7 days ends Sunday', calculateEndDate('2026-06-29', 7), '2026-07-05');
assert('the week 1 end really is a Sunday', dayName(calculateEndDate('2026-06-29', 7) as string), 'Sunday');
// Monday 29/06/2026 + 28 days -> Sunday 26/07/2026.
assert('Monday start + 28 days ends Sunday', calculateEndDate('2026-06-29', 28), '2026-07-26');
assert('Block 1 from a Monday ends Sunday', calculateBlockEndDate('2026-06-29', 4), '2026-07-26');

// Wednesday 01/07/2026 + 7 days -> Tuesday 07/07/2026.
assert('Wednesday start + 7 days ends Tuesday', calculateEndDate('2026-07-01', 7), '2026-07-07');
assert('the week 1 end really is a Tuesday', dayName(calculateEndDate('2026-07-01', 7) as string), 'Tuesday');

// `Date` inputs must produce the same answer as string inputs.
assert('a Date start gives the same end', calculateEndDate(new Date(2026, 5, 28, 12), 7), '2026-07-04');

console.log('\n-- 1..13 weeks end on the day before the start, any weekday --');
{
  let ok = true;
  const offenders: string[] = [];
  for (let month = 1; month <= 12; month += 1) {
    for (let day = 1; day <= 28; day += 1) {
      const start = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const wanted = DAY_NAMES[(new Date(`${start}T00:00:00Z`).getUTCDay() + 6) % 7];
      for (let weeks = 1; weeks <= 13; weeks += 1) {
        const end = calculateBlockEndDate(start, weeks);
        if (!end || dayName(end) !== wanted) {
          ok = false;
          offenders.push(`${weeks}w ${start}->${end}`);
        }
      }
    }
  }
  assert('every 1-13 week block ends the day before its start', ok, true);
  if (offenders.length > 0) console.log(`        ${offenders.slice(0, 5).join(', ')}`);
}

/* ------------------------------------------------------------------ *
 * The contiguous weekly sequence generation.
 * ------------------------------------------------------------------ */

console.log('\n-- calculateWeeklySubRanges --');
{
  const sunday = calculateWeeklySubRanges('2026-06-28', 52);
  assert('52 weekly windows from a Sunday', sunday.length, 52);
  assert('week 1 is the start day itself', [sunday[0].start, sunday[0].end], ['2026-06-28', '2026-07-04']);
  assert('week 2 starts the day after week 1 ends', sunday[1].start, '2026-07-05');
  assert('every Sunday-start week ends on Saturday', sunday.every((week) => dayName(week.end) === 'Saturday'), true);
  assert(
    'the weeks are contiguous',
    sunday.every((week, index) => index === 0 || Date.parse(`${week.start}T00:00:00Z`) === Date.parse(`${sunday[index - 1].end}T00:00:00Z`) + 86_400_000),
    true,
  );

  const monday = calculateWeeklySubRanges('2026-06-29', 52);
  assert('week 1 from a Monday runs Mon-Sun', [monday[0].start, monday[0].end], ['2026-06-29', '2026-07-05']);
  assert('every Monday-start week ends on Sunday', monday.every((week) => dayName(week.end) === 'Sunday'), true);

  const wednesday = calculateWeeklySubRanges('2026-07-01', 4);
  assert('a 4-week sequence from a Wednesday', wednesday.map((week) => `${week.start}..${week.end}`), [
    '2026-07-01..2026-07-07',
    '2026-07-08..2026-07-14',
    '2026-07-15..2026-07-21',
    '2026-07-22..2026-07-28',
  ]);

  assert('an unparseable start yields no weeks', calculateWeeklySubRanges('not-a-date', 4), []);
}

/* ------------------------------------------------------------------ *
 * The dynamic calendar: the grid follows the selected start day.
 * ------------------------------------------------------------------ */

console.log('\n-- dynamic grid start --');
assert('the institutional default is a Sunday', gridStartFrom(undefined), MASTER_GRID_START);

const mondayGrid = '2026-06-29';
assert('weekWindow(1) follows the Monday start', [weekWindow(1, mondayGrid)!.start, weekWindow(1, mondayGrid)!.end], [
  '2026-06-29',
  '2026-07-05',
]);
assert('Block 1 from a Monday is Mon 29 Jun - Sun 26 Jul', describeWindow(blockWindow(1, mondayGrid)!.start, blockWindow(1, mondayGrid)!.end), 'Mon 29 Jun - Sun 26 Jul 2026');
assert('Block 1 from a Monday ends on Sunday', dayName(blockWindow(1, mondayGrid)!.end), 'Sunday');
assert('the Monday grid still has 13 blocks × 4 weeks', allWeeks(mondayGrid).length, 52);
assert(
  'every Monday-grid week ends on Sunday',
  allWeeks(mondayGrid).every((week) => dayName(week.end) === 'Sunday'),
  true,
);

const sundayWindow = blockWindow(1, MASTER_GRID_START)!;
assert('Block 1 from the default Sunday is Sun 28 Jun - Sat 25 Jul', describeWindow(sundayWindow.start, sundayWindow.end), 'Sun 28 Jun - Sat 25 Jul 2026');
assert('week 1.1 short range matches the brief', formatShortRange(weekWindow(1, MASTER_GRID_START)!.start, weekWindow(1, MASTER_GRID_START)!.end), '28/06–04/07');
assert('week 1.1 from a Monday reads 29/06–05/07', formatShortRange(weekWindow(1, mondayGrid)!.start, weekWindow(1, mondayGrid)!.end), '29/06–05/07');

console.log('\n-- a date resolves to the right week under a custom start --');
assert('29/06 is week 1 of a Monday grid', weekNumberForDate('2026-06-29', mondayGrid), 1);
assert('05/07 is still week 1 of a Monday grid', weekNumberForDate('2026-07-05', mondayGrid), 1);
assert('06/07 is week 2 of a Monday grid', weekNumberForDate('2026-07-06', mondayGrid), 2);
assert('27/06 is before the Monday grid', weekNumberForDate('2026-06-27', mondayGrid), null);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nAll date-boundary checks passed.');
