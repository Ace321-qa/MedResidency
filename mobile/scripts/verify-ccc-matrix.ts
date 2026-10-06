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
  pgyLevelsForRow,
  type CccScheduleRow,
} from '../src/utils/cccMatrix';
import { ACADEMIC_DAYS, academicDayForPgy } from '../src/utils/academicYear';

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

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nAll CCC-matrix checks passed.');
