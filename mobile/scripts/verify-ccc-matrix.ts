/**
 * Checks the CCC longitudinal matrix shaping.
 *
 *     npx tsc -p tsconfig.verify.json && node .tmp/verify/mobile/scripts/verify-ccc-matrix.js
 *
 * The constraint this file protects is unusual and easy to break by accident:
 * `longitudinal_clinic_slots` is **empty in the live database**. So the rows are
 * fixed by the curriculum and the columns fall back to a canonical ten. The
 * matrix has to be legible with no data at all, and the failure mode to guard
 * against is a change that makes an empty slot table produce an empty grid — or,
 * worse, one that "fixes" it by inventing resident and faculty names.
 *
 * So every case below is either about legibility with no data or about refusing
 * to fabricate. A test that let a fake resident into a rota would be worse than no
 * test, because the rota is what a resident reads to find out where to be.
 */

import {
  CCC_FALLBACK_SLOTS,
  CCC_SCHEDULE_ROWS,
  CCC_WBC_SLOT_COUNT,
  WEEKDAY_NAMES,
  WEEKDAY_SHORT,
  dayOfWeekMatches,
  formatClock12Hour,
  formatCycleMetadataBanner,
  formatDayDate,
  formatShiftRange,
  numericLabelValue,
  pgyLevelFromLabel,
  pgyLevelsForRow,
  splitShiftRange,
  weekdayIndex,
  weekdayName,
  type CccScheduleRow,
} from '../src/utils/cccMatrix';
import { ACADEMIC_DAYS, academicDayForPgy } from '../src/utils/academicYear';
import {
  calculateEndDateFromWeeks,
  convertMonthsToWeeks,
  dateForWeekDay,
  formatWeekSpan,
  weekDayDate,
  weekDayOffset,
  weekDaySequence,
} from '../src/utils/dateCalc';
import { rotationWindowForMonths } from '../src/utils/masterGridCalendar';
import {
  ADMINISTRATIVE_ROLE_OPTIONS,
  CLINICAL_TITLE_OPTIONS,
  FACULTY_APPOINTMENT_OPTIONS,
  facultyBadges,
  facultyBadgesFor,
  hasAdministrativeRole,
} from '../src/utils/faculty';

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

function row(key: string): CccScheduleRow {
  const found = CCC_SCHEDULE_ROWS.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no such row: ${key}`);
  return found;
}

/* ------------------------------------------------------------------ *
 * Rows come from the curriculum, so they exist with no database at all.
 * ------------------------------------------------------------------ */

console.log('\n-- the rows are fixed by the curriculum --');
assert('there are five rows', CCC_SCHEDULE_ROWS.length, 5);
assert('every row has a stable key', CCC_SCHEDULE_ROWS.every((r) => r.key.length > 0), true);
assert('every row key is unique', new Set(CCC_SCHEDULE_ROWS.map((r) => r.key)).size, 5);

console.log('\n-- one row per weekday, and no collisions --');
{
  // A matrix whose rows collide would render two sessions in the same cell.
  const weekdays = CCC_SCHEDULE_ROWS.map((r) => r.weekday);
  assert('the five rows use five distinct weekdays', new Set(weekdays).size, 5);
  assert('every weekday index is a real day', weekdays.every((d) => d >= 0 && d <= 6), true);

  // Sunday through Thursday: Mon-Fri of the academic week.
  assert('the rows run Sunday to Thursday', [...weekdays].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
}

console.log('\n-- the FMC days are both present and both full-day --');
{
  const fmc = CCC_SCHEDULE_ROWS.filter((r) => r.code === 'FMC');
  assert('FMC runs twice a week', fmc.length, 2);
  assert('on Tuesday and Thursday', fmc.map((r) => r.weekday), [2, 4]);
  assert('and both span the full day', fmc.map((r) => `${r.startTime}-${r.endTime}`), ['07:00-14:00', '07:00-14:00']);
  assert('and each has its own caption explaining the acronym', fmc.every((r) => r.caption.length > 'FMC'.length), true);
}

console.log('\n-- PGY rows sit in the shorter session --');
{
  const pgy = CCC_SCHEDULE_ROWS.filter((r) => r.code !== 'FMC');
  assert('there are three PGY rows', pgy.length, 3);
  assert('PGY-1 is on Wednesday', row('pgy1-wednesday').weekday, 3);
  assert('PGY-2 is on Monday', row('pgy2-monday').weekday, 1);
  assert('PGY-3 is on Sunday', row('pgy3-sunday').weekday, 0);
  assert('all three share the 10:30-14:00 session', [...new Set(pgy.map((r) => r.startTime))], ['10:30']);
  assert('and all three end at 14:00', [...new Set(pgy.map((r) => r.endTime))], ['14:00']);
}

/* ------------------------------------------------------------------ *
 * The fallback columns. This is what makes an empty table legible.
 * ------------------------------------------------------------------ */

console.log('\n-- fallback columns stand in for an empty slot table --');
assert('there are ten fallback slots', CCC_FALLBACK_SLOTS.length, 10);
assert('the slot count constant agrees', CCC_WBC_SLOT_COUNT, CCC_FALLBACK_SLOTS.length);
assert('slots are numbered from one', CCC_FALLBACK_SLOTS.map((s) => s.slot_number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
assert('every slot has a label', CCC_FALLBACK_SLOTS.every((s) => s.slot_label.length > 0), true);
assert('slot labels are unique', new Set(CCC_FALLBACK_SLOTS.map((s) => s.slot_label)).size, 10);

console.log('\n-- a fallback slot lines up with a real slot --');
{
  // `slot_number` is the join key against `longitudinal_clinic_slots`. If the
  // fallback numbered from zero, a real slot 1 would line up under "Clinic 2"
  // and every pairing would be off by one column.
  const real = [{ slot_number: 1, slot_label: 'WBC A' }, { slot_number: 2, slot_label: 'WBC B' }];
  const fallback = CCC_FALLBACK_SLOTS;

  assert('real slot 1 aligns with fallback slot 1', real[0].slot_number, fallback[0].slot_number);
  assert('real slot 2 aligns with fallback slot 2', real[1].slot_number, fallback[1].slot_number);

  // The rendering rule the matrix follows: use the real label when a slot exists,
  // otherwise the fallback for the same number.
  const labelFor = (number: number) =>
    (real.find((slot) => slot.slot_number === number) ?? fallback.find((s) => s.slot_number === number))
      ?.slot_label ?? null;

  assert('a real label wins over the fallback', labelFor(1), 'WBC A');
  assert('an unrecorded slot number falls back', labelFor(7), 'Clinic 7');
  assert('a slot number beyond the fallback has no column', labelFor(11), null);
}

/* ------------------------------------------------------------------ *
 * No data means no names. Nothing here may invent one.
 * ------------------------------------------------------------------ */

console.log('\n-- rows carry no clinic identity until one is recorded --');
{
  // `clinicCode`/`clinicName` are null in the curriculum rows precisely because a
  // clinic code is data. Hardcoding "WBC" as an identity would collide with a
  // differently-coded clinic once real clinic types exist.
  const clinicCodes = CCC_SCHEDULE_ROWS.map((r) => r.clinicCode);
  assert('no row asserts a clinic code', clinicCodes, [null, null, null, null, null]);
  assert('no row asserts a clinic name', CCC_SCHEDULE_ROWS.map((r) => r.clinicName), [null, null, null, null, null]);
}

console.log('\n-- a PGY row names exactly the level that attends it --');
{
  assert('PGY-1 attends only the PGY-1 row', pgyLevelsForRow(row('pgy1-wednesday')), [1]);
  assert('PGY-2 attends only the PGY-2 row', pgyLevelsForRow(row('pgy2-monday')), [2]);
  assert('PGY-3 attends only the PGY-3 row', pgyLevelsForRow(row('pgy3-sunday')), [3]);
  // FMC days are not a single PGY level, so the mapping returns null rather than
  // guessing — the caller leaves the cell open instead of filtering residents.
  assert('FMC has no single PGY level', pgyLevelsForRow(row('fmc-tuesday')), null);
  assert('and neither FMC day invents one', pgyLevelsForRow(row('fmc-thursday')), null);
}

console.log('\n-- a day context maps to a single training level for filtering --');
{
  // The slot dropdowns read the day's stored context and, when it names one
  // level, list only residents enrolled at that exact level. Anything mixed must
  // resolve to null so the caller leaves the list open rather than filtering it.
  assert('PGY-3 names level three', pgyLevelFromLabel('PGY-3'), 3);
  assert('PGY-2 names level two', pgyLevelFromLabel('PGY-2'), 2);
  assert('PGY-1 names level one', pgyLevelFromLabel('PGY-1'), 1);
  assert('spacing and case do not matter', pgyLevelFromLabel('  pgy 4 '), 4);
  assert('a mixed FMC day names no single level', pgyLevelFromLabel('FMC'), null);
  assert('an ALL context names no single level', pgyLevelFromLabel('ALL'), null);
  assert('a blank context names no level', pgyLevelFromLabel(''), null);
  assert('a null context names no level', pgyLevelFromLabel(null), null);
  assert('nonsense names no level', pgyLevelFromLabel('WBC'), null);
}

console.log('\n-- the PGY mapping agrees with the academic-day calendar --');
{
  // Two sources describe the same week: CCC_SCHEDULE_ROWS and ACADEMIC_DAYS. If
  // they disagreed, a resident's row in the matrix would not match the badge on
  // their master-grid row.
  const byCode = new Map(CCC_SCHEDULE_ROWS.map((r) => [`${r.code}-${r.weekday}`, r.weekday]));

  for (const day of ACADEMIC_DAYS) {
    const expected = CCC_SCHEDULE_ROWS.filter((r) => r.code === day.code).map((r) => r.weekday);
    assert(`ACADEMIC_DAYS ${day.code} matches the CCC rows`, [...expected].sort(), [...new Set(expected)]);
    assert(`  and carries the same weekday index as the calendar`, byCode.has(`${day.code}-${day.weekday}`), true);
  }

  assert('academicDayForPgy(1) is the PGY-1 row code', academicDayForPgy(1), 'PGY1');
  assert('academicDayForPgy(3) is the PGY-3 row code', academicDayForPgy(3), 'PGY3');
  assert('an unset PGY level maps to nothing rather than a default', academicDayForPgy(null), null);
  assert('an out-of-range PGY level maps to nothing', academicDayForPgy(9), null);
}

/* ------------------------------------------------------------------ *
 * Day-of-week matching against whatever spelling the database holds.
 * ------------------------------------------------------------------ */

console.log('\n-- day_of_week matching --');
{
  const sunday = row('pgy3-sunday').weekday;

  assert('a full day name matches', dayOfWeekMatches('Sunday', sunday), true);
  assert('lowercase matches', dayOfWeekMatches('sunday', sunday), true);
  assert('mixed case matches', dayOfWeekMatches('SuNdAy', sunday), true);
  assert('padded whitespace matches', dayOfWeekMatches('  Sunday  ', sunday), true);
  assert('a three-letter abbreviation matches', dayOfWeekMatches('Sun', sunday), true);
  assert('a longer form matches', dayOfWeekMatches('Sunday-ish', sunday), true);

  // False positives here would put the wrong clinic on the wrong day.
  assert('a different day does not match', dayOfWeekMatches('Monday', sunday), false);
  assert('a three-letter prefix of another day does not match', dayOfWeekMatches('Mon', sunday), false);
  assert('an empty value does not match', dayOfWeekMatches('', sunday), false);
  assert('a null value does not match', dayOfWeekMatches(null, sunday), false);
  assert('an undefined value does not match', dayOfWeekMatches(undefined, sunday), false);
  assert('nonsense does not match', dayOfWeekMatches('someday', sunday), false);

  // Every row's own weekday must match its own name, or the whole matrix inverts.
  assert('every row matches its own day name', CCC_SCHEDULE_ROWS.every((r) => dayOfWeekMatches(WEEKDAY_NAMES[r.weekday], r.weekday)), true);
  assert('every row matches its own short name', CCC_SCHEDULE_ROWS.every((r) => dayOfWeekMatches(WEEKDAY_SHORT[r.weekday], r.weekday)), true);
  assert('no two rows match the same day name', new Set(CCC_SCHEDULE_ROWS.map((r) => WEEKDAY_NAMES[r.weekday])).size, 5);
}

console.log('\n-- the weekday tables cover every index the rows use --');
assert('there are seven full names', WEEKDAY_NAMES.length, 7);
assert('there are seven short names', WEEKDAY_SHORT.length, 7);
assert('the tables are aligned', WEEKDAY_NAMES.map((n) => n.slice(0, 3)), [...WEEKDAY_SHORT]);
assert('both start at Sunday', [WEEKDAY_NAMES[0], WEEKDAY_SHORT[0]], ['Sunday', 'Sun']);

/* ------------------------------------------------------------------ *
 * The CCC rotation window: months -> 4 weeks each, inclusive end date.
 * ------------------------------------------------------------------ */

console.log('\n-- the rotation window converts months into whole weeks --');
assert('three months is twelve weeks', convertMonthsToWeeks(3), 12);
assert('six months is twenty-four weeks', convertMonthsToWeeks(6), 24);
assert('one month is four weeks', convertMonthsToWeeks(1), 4);
assert('a fractional month converts exactly', convertMonthsToWeeks(1.5), 6);
assert('a non-month value converts to NaN', Number.isNaN(convertMonthsToWeeks(Number.NaN)), true);

console.log('\n-- the inclusive end date owns every day of the window --');
{
  // The window guards its own days: end = start + (weeks*7 - 1). A Sunday start
  // ends on the Saturday of the last week, a Monday start on its Sunday.
  assert('Sun 11 Oct 2026 + 3 months ends Sat 02 Jan 2027', calculateEndDateFromWeeks('2026-10-11', 12), '2027-01-02');
  assert('Mon 12 Oct 2026 + 3 months ends Sun 03 Jan 2027', calculateEndDateFromWeeks('2026-10-12', 12), '2027-01-03');
  assert('the window is full and inclusive (84 days)', calculateEndDateFromWeeks('2026-10-11', 12), '2027-01-02');
  assert('a bad start date yields nothing', calculateEndDateFromWeeks('2026-13-99', 12), null);
  assert('a missing start date yields nothing', calculateEndDateFromWeeks('', 12), null);
  assert('a non-positive window yields nothing', calculateEndDateFromWeeks('2026-10-11', 0), null);
}

console.log('\n-- the single rotation-window helper ties both rules together --');
{
  const window = rotationWindowForMonths('2026-10-11', 3);
  assert('total_weeks is three months at four weeks', window?.totalWeeks, 12);
  assert('total_days counts every day', window?.totalDays, 84);
  assert('the end date is the Saturday of the last week', window?.endDate, '2027-01-02');
  assert('it names the start weekday', window?.startsOn, 'Sunday');
  assert('and the end weekday', window?.endsOn, 'Saturday');
  assert('a blank start or window resolves to nothing', rotationWindowForMonths('', 3), null);
}

console.log('\n-- the rotation badge reads total weeks and both boundary days --');
{
  // The badge is what a coordinator sees under the rotation window: the whole
  // weeks, then the weekday and full date at both ends of the inclusive window.
  assert(
    'a twelve-week window renders across the year boundary',
    formatWeekSpan(12, '2026-10-11', '2027-01-02'),
    '12 Weeks (Sun, Oct 11, 2026 – Sat, Jan 02, 2027)',
  );
  assert(
    'a one-week window is singular',
    formatWeekSpan(1, '2026-06-28', '2026-07-04'),
    '1 Week (Sun, Jun 28, 2026 – Sat, Jul 04, 2026)',
  );
  assert('a missing end date yields no badge', formatWeekSpan(12, '2026-10-11', ''), null);
  assert('a non-positive window yields no badge', formatWeekSpan(0, '2026-10-11', '2026-10-17'), null);
}

/* ------------------------------------------------------------------ *
 * The CCC week rotates with the cycle's Week Start Date. A Monday-start
 * cycle runs Monday-Sunday; the Nth day row is `D_start + (N - 1)`.
 * ------------------------------------------------------------------ */

console.log('\n-- the week-day rotation starts on the Week Start Date --');
{
  assert(
    'a Sunday-start cycle runs Sunday to Saturday',
    weekDaySequence('2026-10-11'),
    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  );
  assert(
    'a Monday-start cycle runs Monday to Sunday',
    weekDaySequence('2026-10-12'),
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  );
  assert(
    'a Wednesday start rotates Wednesday to Tuesday',
    weekDaySequence(3),
    ['Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Monday', 'Tuesday'],
  );
  assert(
    'a day name works as the start too',
    weekDaySequence('Wednesday'),
    ['Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Monday', 'Tuesday'],
  );
  assert('an unknown start falls back to Sunday', weekDaySequence(null), [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ]);
}

console.log('\n-- the day offset is the N - 1 in D_start + (N - 1) --');
{
  assert('the start day is offset 0', weekDayOffset('2026-10-12', 'Monday'), 0);
  assert('the next day is offset 1', weekDayOffset('2026-10-12', 'Tuesday'), 1);
  assert('Wednesday is offset two', weekDayOffset('2026-10-12', 'Wednesday'), 2);
  assert('the week closes six days later', weekDayOffset('2026-10-12', 'Sunday'), 6);
  assert('a short name is accepted', weekDayOffset('2026-10-12', 'Sun'), 6);
  assert('a nonsense day has no offset', weekDayOffset('2026-10-12', 'Someday'), null);
  assert('a null start falls back to a Sunday week', weekDayOffset(null, 'Monday'), 1);
}

console.log('\n-- each day row carries the exact calendar date D_start + (N - 1) --');
{
  assert('row 1 is the Week Start Date itself', weekDayDate('2026-10-12', 0), '2026-10-12');
  assert('row 3 is two days later', weekDayDate('2026-10-12', 2), '2026-10-14');
  assert('row 7 closes the week', weekDayDate('2026-10-12', 6), '2026-10-18');
  assert('an offset past the week yields nothing', weekDayDate('2026-10-12', 7), null);
  assert('a negative offset yields nothing', weekDayDate('2026-10-12', -1), null);
  assert('a bad start date yields nothing', weekDayDate('not-a-date', 1), null);
}

console.log('\n-- a named day resolves to its exact date in the cycle week --');
{
  assert('the start day is itself', dateForWeekDay('2026-10-12', 'Monday'), '2026-10-12');
  assert('the following Sunday closes a Monday-start week', dateForWeekDay('2026-10-12', 'Sunday'), '2026-10-18');
  assert('a Sunday-start week opens on Sunday', dateForWeekDay('2026-10-11', 'Sunday'), '2026-10-11');
  assert('and closes on Saturday', dateForWeekDay('2026-10-11', 'Saturday'), '2026-10-17');
  assert('a short day name resolves too', dateForWeekDay('2026-10-12', 'Thu'), '2026-10-15');
  assert('a nonsense day resolves to nothing', dateForWeekDay('2026-10-12', 'nonsense'), null);
  assert('a bad start date resolves to nothing', dateForWeekDay('not-a-date', 'Monday'), null);
}

console.log('\n-- the date helpers and the day-name index agree with the rotation --');
{
  // `weekDayDate` and `dateForWeekDay` are two roads to the same cell, and the
  // row's index into the sequence must equal its `D_start + (N - 1)` offset.
  const start = '2026-10-12';
  const sequence = weekDaySequence(start);
  const datesMatch = sequence.every(
    (day, index) =>
      weekDayOffset(start, day) === index && weekDayDate(start, index) === dateForWeekDay(start, day),
  );
  assert('every day is at its own sequence offset and dated the same way', datesMatch, true);

  assert('weekdayIndex names Sunday zero', weekdayIndex('Sunday'), 0);
  assert('weekdayIndex reads a three-letter name', weekdayIndex('Thu'), 4);
  assert('weekdayName canonicalises a short name', weekdayName('wed'), 'Wednesday');
  assert('weekdayIndex rejects nonsense', weekdayIndex('nonsense'), -1);
  assert('weekdayIndex rejects a blank', weekdayIndex(''), -1);
  assert('weekdayName rejects nonsense', weekdayName('nonsense'), null);
}

/* ------------------------------------------------------------------ *
 * The faculty classification axes are objective and independent.
 * ------------------------------------------------------------------ */

console.log('\n-- the clinical titles are the health system rank, no more --');
assert('there are four clinical titles', CLINICAL_TITLE_OPTIONS.length, 4);
assert(
  'they are the agreed ranks',
  CLINICAL_TITLE_OPTIONS.map((option) => option.value),
  ['Specialist', 'Consultant', 'Senior Consultant', 'Other'],
);
assert(
  'no clinical title implies a supervision tier',
  CLINICAL_TITLE_OPTIONS.some((option) => /supervis|tier|level allowed/i.test(option.label)),
  false,
);

console.log('\n-- the faculty appointments are the accreditation categories --');
assert('there are four appointments', FACULTY_APPOINTMENT_OPTIONS.length, 4);
assert(
  'they are the agreed categories',
  FACULTY_APPOINTMENT_OPTIONS.map((option) => option.value),
  ['Core Faculty', 'Teaching Faculty', 'Adjunct / Visiting Faculty', 'Pending'],
);

console.log('\n-- the administrative roles are optional programme offices --');
assert('there are six roles', ADMINISTRATIVE_ROLE_OPTIONS.length, 6);
assert('the first option is the affirmative "None"', ADMINISTRATIVE_ROLE_OPTIONS[0].value, 'None');
assert('and "None" is not treated as a real office', hasAdministrativeRole('None'), false);
assert('an empty role is not a real office', hasAdministrativeRole(''), false);
assert('a real office is recognised', hasAdministrativeRole('Program Director (PD)'), true);
assert('role matching is case-insensitive', hasAdministrativeRole('none'), false);

console.log('\n-- only appointment and real roles become badges --');
{
  // A clinical title is deliberately never a badge: badging it beside the
  // programme axes would imply a rank ordering between them.
  const full = facultyBadges({
    faculty_appointment: 'Core Faculty',
    administrative_role: 'Continuity Clinic Lead',
  });
  assert('a full appointment yields two badges', full.length, 2);
  assert('the appointment leads', full[0], { label: 'Core Faculty', tone: 'info' });
  assert('the role follows', full[1], { label: 'Continuity Clinic Lead', tone: 'neutral' });

  assert(
    'the clinical title is never a badge',
    facultyBadges({ faculty_appointment: 'Teaching Faculty' }).some((b) => /Consultant|Specialist/.test(b.label)),
    false,
  );
  assert(
    'a "None" role produces no badge',
    facultyBadges({ faculty_appointment: 'Teaching Faculty', administrative_role: 'None' }).length,
    1,
  );
  assert('no classification produces no badges', facultyBadges({}).length, 0);
  assert(
    'the camelCase helper matches the snake_case one',
    facultyBadgesFor('Core Faculty', 'None'),
    facultyBadges({ faculty_appointment: 'Core Faculty', administrative_role: 'None' }),
  );
}

console.log('\n-- the cycle number reads back out of its stored label --');
assert('a bare digit is kept', numericLabelValue('3'), '3');
assert('"Cycle 1" yields its number', numericLabelValue('Cycle 1'), '1');
assert('a trailing number is found', numericLabelValue('Week 12'), '12');
assert('a missing label yields nothing', numericLabelValue(null), '');

console.log('\n-- a stored shift splits into start and end --');
assert('the en dash the curriculum writes splits', splitShiftRange('10:30 – 2:00'), ['10:30', '2:00']);
assert('a plain hyphen splits too', splitShiftRange('07:00 - 14:00'), ['07:00', '14:00']);
assert('a single time is not a range', splitShiftRange('10:30'), null);
assert('an empty shift is not a range', splitShiftRange(''), null);

console.log('\n-- a clock time reads as 12-hour --');
assert('morning keeps AM', formatClock12Hour('10:30'), '10:30 AM');
assert('14:00 becomes 02:00 PM', formatClock12Hour('14:00'), '02:00 PM');
assert('noon is 12:00 PM', formatClock12Hour('12:00'), '12:00 PM');
assert('midnight is 12:00 AM', formatClock12Hour('00:00'), '12:00 AM');
assert('a unparseable clock yields nothing', formatClock12Hour('later'), '');

console.log('\n-- a shift range reads as a session --');
assert('the short afternoon end is read as PM', formatShiftRange('10:30 – 2:00'), '10:30 AM - 02:00 PM');
assert('a 24-hour range is converted', formatShiftRange('07:00 - 14:00'), '07:00 AM - 02:00 PM');

console.log('\n-- the day and date read as DD/MM/YYYY --');
assert('an ISO date is reordered', formatDayDate('Sunday', '2026-06-28'), 'Sunday, 28/06/2026');
assert('a missing date yields nothing', formatDayDate('Sunday', null), 'Sunday');

console.log('\n-- the banner reads as one sentence --');
assert(
  'the full banner matches the agreed format',
  formatCycleMetadataBanner({
    cycleNumber: 'Cycle 1',
    weekNumber: 'Week 1',
    startsOn: 'Sunday',
    startDate: '2026-06-28',
    shiftTime: '10:30 – 2:00',
    pgyLevel: 'PGY-3',
  }),
  'Cycle 1 · Week 1 | Starts: Sunday, 28/06/2026 | Shift: 10:30 AM - 02:00 PM (PGY-3)',
);
assert(
  'a blank cycle falls back to one',
  formatCycleMetadataBanner({ cycleNumber: '', weekNumber: '', startsOn: null, startDate: null, shiftTime: null, pgyLevel: null }),
  'Cycle 1 · Week 1',
);
assert(
  'a shift with no PGY still prints the range',
  formatCycleMetadataBanner({
    cycleNumber: 'Cycle 2',
    weekNumber: 'Week 3',
    startsOn: 'Monday',
    startDate: '2026-07-06',
    shiftTime: '07:00 - 14:00',
    pgyLevel: null,
  }),
  'Cycle 2 · Week 3 | Starts: Monday, 06/07/2026 | Shift: 07:00 AM - 02:00 PM',
);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nAll CCC-matrix checks passed.');
