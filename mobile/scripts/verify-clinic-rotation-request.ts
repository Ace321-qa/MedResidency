/**
 * Checks the clinic-rotation request rules.
 *
 *     npx tsc -p tsconfig.verify.json && node .tmp/verify/mobile/scripts/verify-clinic-rotation-request.js
 *
 * Two things about a clinic request are easy to get subtly wrong, and neither is
 * visible in a screenshot until a resident is standing in the wrong place:
 *
 *  1. **the end date** — a release of *n* weeks ends the day before the *n*th
 *     week would start: `start + (n × 7 − 1)`. The off-by-one lands the resident
 *     one day into the next week, so a Sunday start of four weeks must end on a
 *     Saturday, and a Monday start on a Sunday. The first cases below pin both.
 *  2. **the clinic days** — one to three weekdays, always drawn from the
 *     institutional set (Sunday through Thursday) and always returned in the
 *     same order, so the same request reads the same way on the phone, in the
 *     queue and on the grid.
 *
 * The module under test is pure, which is the point: the arithmetic and the rule
 * live in one place both the form and the server can share, rather than being
 * re-derived (and re-broken) inside a screen.
 */

import {
  CLINIC_DAY_OPTIONS,
  CUSTOM_PERIOD,
  MAX_CLINIC_DAYS,
  MIN_CLINIC_DAYS,
  PERIOD_WEEK_PRESETS,
  clinicDaysAreValid,
  clinicEndDate,
  clinicRequestBadge,
  formatClinicDays,
  parsePeriodWeeks,
  shortClinicDay,
  sortClinicDays,
  toggleClinicDay,
} from '../src/utils/clinicRotationRequest';
import type { DayName } from '../src/utils/dateCalc';

let failed = 0;
let passed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
  }
}

console.log('-- the window: end = start + (weeks × 7 − 1) --');
check('Sunday 18 Oct 2026 + 4 weeks ends Sat 14 Nov', clinicEndDate('2026-10-18', 4), '2026-11-14');
check('Monday 19 Oct 2026 + 4 weeks ends Sun 15 Nov', clinicEndDate('2026-10-19', 4), '2026-11-15');
check('Sunday 18 Oct 2026 + 1 week ends Sat 24 Oct', clinicEndDate('2026-10-18', 1), '2026-10-24');
check('Sunday 18 Oct 2026 + 2 weeks ends Sat 31 Oct', clinicEndDate('2026-10-18', 2), '2026-10-31');
check('Sunday 18 Oct 2026 + 3 weeks ends Sat 07 Nov', clinicEndDate('2026-10-18', 3), '2026-11-07');
check('a bad start date yields nothing', clinicEndDate('not-a-date', 4), null);
check('a zero period yields nothing', clinicEndDate('2026-10-18', 0), null);

console.log('\n-- the end date always lands the day before the week-start weekday --');
{
  let ok = true;
  const offenders: string[] = [];
  for (let month = 1; month <= 12; month += 1) {
    for (let day = 1; day <= 28; day += 1) {
      const start = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      for (let weeks = 1; weeks <= 13; weeks += 1) {
        const end = clinicEndDate(start, weeks);
        if (!end) {
          ok = false;
          offenders.push(`${start}+${weeks}w -> null`);
          continue;
        }
        const startDay = new Date(`${start}T00:00:00Z`).getUTCDay();
        const endDay = new Date(`${end}T00:00:00Z`).getUTCDay();
        // The end is the day before the start's weekday, i.e. six days on.
        if (endDay !== (startDay + 6) % 7) {
          ok = false;
          offenders.push(`${start}+${weeks}w -> ${end} (wrong weekday)`);
        }
      }
    }
  }
  check('every 4-week window keeps the weekday, all year', ok, true);
  if (!ok) console.error(offenders.slice(0, 5).join('\n'));
}

console.log('\n-- parsePeriodWeeks: only whole weeks in range --');
for (const preset of PERIOD_WEEK_PRESETS) {
  check(`preset ${preset} parses`, parsePeriodWeeks(String(preset)), preset);
}
check('a preset given as a number parses', parsePeriodWeeks(4), 4);
check('a custom 6 parses', parsePeriodWeeks('6'), 6);
check('the custom sentinel does not parse', parsePeriodWeeks(CUSTOM_PERIOD), null);
check('zero is refused', parsePeriodWeeks('0'), null);
check('a negative is refused', parsePeriodWeeks('-2'), null);
check('a fractional week is refused', parsePeriodWeeks('2.5'), null);
check('an empty string is refused', parsePeriodWeeks(''), null);
check('text is refused', parsePeriodWeeks('four'), null);
check('fifty-three weeks is refused', parsePeriodWeeks('53'), null);
check('fifty-two weeks is allowed', parsePeriodWeeks('52'), 52);

console.log('\n-- the clinic-day set: one to three, institutional order --');
check('the options are Sunday through Thursday', CLINIC_DAY_OPTIONS, [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
]);
check('the bounds are one and three', [MIN_CLINIC_DAYS, MAX_CLINIC_DAYS], [1, 3]);

check('sorting is always institution order', sortClinicDays(['Thursday', 'Sunday', 'Wednesday']), [
  'Sunday',
  'Wednesday',
  'Thursday',
]);
check('sorting de-duplicates', sortClinicDays(['Wednesday', 'Wednesday']), ['Wednesday']);
check('sorting accepts the enum spelling', sortClinicDays(['WEDNESDAY'] as unknown as DayName[]), [
  'Wednesday',
]);
check('sorting accepts abbreviations', sortClinicDays(['Wed', 'Fri'] as unknown as DayName[]), [
  'Wednesday',
]);
check('Friday is not an offered clinic day', sortClinicDays(['Friday'] as unknown as DayName[]), []);

check('an empty set is invalid', clinicDaysAreValid([]), false);
check('one day is valid', clinicDaysAreValid(['Wednesday']), true);
check('three days are valid', clinicDaysAreValid(['Sunday', 'Tuesday', 'Thursday']), true);
check('four days are invalid', clinicDaysAreValid(['Sunday', 'Monday', 'Tuesday', 'Wednesday']), false);

console.log('\n-- toggling a day --');
check('adding a day sorts it in', toggleClinicDay(['Wednesday'], 'Sunday'), ['Sunday', 'Wednesday']);
check('removing a chosen day drops it', toggleClinicDay(['Sunday', 'Wednesday'], 'Sunday'), ['Wednesday']);
check('a fourth day is refused', toggleClinicDay(['Sunday', 'Monday', 'Tuesday'], 'Wednesday'), [
  'Sunday',
  'Monday',
  'Tuesday',
]);
check('an unoffered day is ignored', toggleClinicDay(['Sunday'], 'Friday' as unknown as DayName), [
  'Sunday',
]);
check('removing is always possible at the limit', toggleClinicDay(['Sunday', 'Monday', 'Tuesday'], 'Monday'), [
  'Sunday',
  'Tuesday',
]);

console.log('\n-- display forms --');
check('a single day reads short', shortClinicDay('Wednesday'), 'Wed');
check(
  'a two-day list reads in order',
  formatClinicDays(['Thursday', 'Sunday']),
  'Sun, Thu',
);
check('the badge reads like the grid cell', clinicRequestBadge('ANC', ['Wednesday']), '+ ANC (Wed)');
check(
  'a two-day badge lists both days',
  clinicRequestBadge('ANC', ['Wednesday', 'Thursday']),
  '+ ANC (Wed, Thu)',
);
check('a nameless badge still shows its days', clinicRequestBadge('', ['Thursday']), '+ (Thu)');

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${passed} clinic-rotation request checks passed.`);
