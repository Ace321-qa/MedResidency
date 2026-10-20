import { capacityLabel, capacityOptionLabel, isAtCapacity } from '../src/utils/capacityRules';
import type { OccupancyStatus } from '../src/types/api';

/*
 * Checks the capacity wording the app shows for an overcapacity verdict.
 *
 *     npx tsc -p tsconfig.verify.json && node .tmp/verify/mobile/scripts/verify-capacity.js
 *
 * The tier *table* is the server's (`scripts/verify-occupancy.js` pins it with 82
 * checks). What this file guards is the small, easy-to-get-wrong half on the
 * client: the words for each tier, and the "no seat limit" case, which must read
 * as unlimited rather than as zero seats. `null`, `0` and `undefined` all mean
 * "no limit" here, and showing them as "0 seats" would tell a coordinator a
 * rotation nobody may join is actually one anybody may.
 *
 * Pure, so it runs under plain `node` with no React Native runtime.
 */

const failures: string[] = [];
let passed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL ${name}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
  }
}

console.log('-- capacityOptionLabel: the rotation picker line --');
// Without a live count only the limit can be shown. Inventing `0/3` would claim
// a rotation is empty when it may be full, so the honest fallback is the limit.
check('a limited rotation shows its limit', capacityOptionLabel('Internal Medicine', 3), 'Internal Medicine (limit 3)');
check('an unlimited rotation says so', capacityOptionLabel('Emergency', null), 'Emergency — No seat limit');
check('a zero capacity says no limit', capacityOptionLabel('Emergency', 0), 'Emergency — No seat limit');
check('a one-seat rotation reads as a limit', capacityOptionLabel('EEG', 1), 'EEG (limit 1)');

console.log('\n-- capacityOptionLabel: live occupancy, once a block is known --');
// With the block's occupancy the label becomes a seat counter, and a full
// rotation says so before it is tapped.
check(
  'a partly-filled rotation shows the count',
  capacityOptionLabel('Internal Medicine Inpatient Wards', 3, 2),
  'Internal Medicine Inpatient Wards (2/3)',
);
check(
  'a full rotation is marked FULL',
  capacityOptionLabel('Internal Medicine Inpatient Wards', 3, 3),
  'Internal Medicine Inpatient Wards (3/3 - FULL)',
);
check(
  'an over-capacity rotation is still marked FULL',
  capacityOptionLabel('Internal Medicine Inpatient Wards', 3, 5),
  'Internal Medicine Inpatient Wards (5/3 - FULL)',
);
check(
  'an empty rotation shows zero used',
  capacityOptionLabel('Internal Medicine', 3, 0),
  'Internal Medicine (0/3)',
);
check(
  'live occupancy is ignored for an unlimited rotation',
  capacityOptionLabel('Emergency', null, 9),
  'Emergency — No seat limit',
);

console.log('\n-- isAtCapacity: the chip tint --');
check('a full rotation is at capacity', isAtCapacity(3, 3), true);
check('an over-capacity rotation is at capacity', isAtCapacity(3, 4), true);
check('a partly-filled rotation is not at capacity', isAtCapacity(3, 2), false);
check('an unlimited rotation is never at capacity', isAtCapacity(null, 99), false);
check('an unknown occupancy is not at capacity', isAtCapacity(3, null), false);

console.log('\n-- capacityLabel: every status is described --');
for (const status of ['GREEN', 'AMBER', 'REVIEW', 'RED', 'BLOCKED'] as OccupancyStatus[]) {
  const entry = capacityLabel(status);
  check(`${status} has a label`, typeof entry.label === 'string' && entry.label.length > 0, true);
  check(`${status} has a summary`, typeof entry.summary === 'string' && entry.summary.length > 0, true);
}
check('the four non-green tiers are named differently', new Set(
  (['AMBER', 'REVIEW', 'RED', 'BLOCKED'] as OccupancyStatus[]).map((s) => capacityLabel(s).label),
).size, 4);
check('a missing status defaults to within capacity', capacityLabel(null).label, capacityLabel('GREEN').label);
check('an unknown status defaults to within capacity', capacityLabel('NOPE' as OccupancyStatus).label, capacityLabel('GREEN').label);

console.log('\n-- the tier wording names what the coordinator must do --');
check('amber asks for a rationale', /rationale/i.test(capacityLabel('AMBER').summary), true);
check('review asks for review', /review/i.test(capacityLabel('REVIEW').summary), true);
check('red asks for an override', /override/i.test(capacityLabel('RED').summary), true);
check('blocked says it cannot be made', /cannot be made/i.test(capacityLabel('BLOCKED').summary), true);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`\nAll ${passed} capacity checks passed.`);
