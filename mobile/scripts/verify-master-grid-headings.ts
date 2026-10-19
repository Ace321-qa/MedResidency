/**
 * Checks the Master Rotation Grid's column headings.
 *
 * The grid is a rota, so a heading names a **calendar slot** and the cells below
 * it name the rotations inside that slot. The reported bug was the opposite: the
 * first visible column showed a rotation ("Pediatrics") instead of its block
 * ("Block 5"), because the heading had been read from `rotation_blocks.block_name`
 * — coordinator-typed free text that held a rotation name.
 *
 * These checks pin the contract the fix restores:
 *
 *   - Tier 1 is always `Block N`; it is never a rotation or block name.
 *   - Tier 2 is the block's predetermined window, drawn from the grid calendar.
 *   - Both follow the Coordinator's chosen grid start (the same calendar the
 *     Weekly view and the exported report use).
 *
 * Run it with:
 *
 *     cd mobile
 *     npx tsc -p tsconfig.verify.json
 *     node .tmp/verify/mobile/scripts/verify-master-grid-headings.js
 */

import { describeWindow } from '../src/utils/dateCalc';
import { BLOCK_COUNT, blockWindow, MASTER_GRID_START } from '../src/utils/masterGridCalendar';
import { masterBlockHeading } from '../src/utils/masterGridHeadings';

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
 * The brief's example: the first visible column is Block 5, not a rotation.
 * ------------------------------------------------------------------ */

console.log('\n-- the first visible column --');
const blockFive = masterBlockHeading(5, MASTER_GRID_START);
assert('tier 1 is the block title', blockFive?.title, 'Block 5');
assert('the block title is not a rotation name', blockFive?.title === 'Pediatrics', false);
assert('tier 2 is the predetermined window', blockFive?.subtitle, 'Sun 18 Oct - Sat 14 Nov 2026');
assert('the window agrees with the grid calendar', blockFive?.subtitle, describeWindow(
  blockWindow(5, MASTER_GRID_START)!.start,
  blockWindow(5, MASTER_GRID_START)!.end,
));

/* ------------------------------------------------------------------ *
 * Every column, 1..13: the title is `Block N` and never a name.
 * ------------------------------------------------------------------ */

console.log('\n-- every block heading --');
{
  // A block name is "Block 5"; a rotation name is anything else. If a heading
  // ever came from the database, one of these would not hold.
  const rotationNames = ['Pediatrics', 'Internal Medicine', 'Emergency', 'Surgery'];
  let allTitledByNumber = true;
  let anyNameLeaked = false;
  const titles: string[] = [];

  for (let blockNumber = 1; blockNumber <= BLOCK_COUNT; blockNumber += 1) {
    const heading = masterBlockHeading(blockNumber, MASTER_GRID_START);
    titles.push(heading?.title ?? '(none)');
    if (heading?.title !== `Block ${blockNumber}`) allTitledByNumber = false;
    if (rotationNames.includes(heading?.title ?? '')) anyNameLeaked = true;
    // The subtitle must be a real window, not blank or a name.
    if (!heading || !/\d/.test(heading.subtitle) || !heading.subtitle.includes(' - ')) allTitledByNumber = false;
  }

  assert('there is a heading for each of the 13 blocks', titles.length, BLOCK_COUNT);
  assert('every tier 1 reads `Block N`', allTitledByNumber, true);
  assert('no rotation name reaches a heading', anyNameLeaked, false);
  assert('column 1 is Block 1 and column 13 is Block 13', [titles[0], titles[titles.length - 1]], [
    'Block 1',
    'Block 13',
  ]);
}

/* ------------------------------------------------------------------ *
 * The heading follows the Coordinator's grid start, like every other view.
 * ------------------------------------------------------------------ */

console.log('\n-- a chosen grid start redraws the window --');
const mondayGrid = '2026-06-29';
assert('Block 5 from a Monday start', masterBlockHeading(5, mondayGrid)?.subtitle, 'Mon 19 Oct - Sun 15 Nov 2026');
assert('the title is unchanged by the start day', masterBlockHeading(5, mondayGrid)?.title, 'Block 5');

console.log('\n-- out-of-range block numbers --');
assert('block 0 has no heading', masterBlockHeading(0, MASTER_GRID_START), null);
assert('block 14 has no heading', masterBlockHeading(BLOCK_COUNT + 1, MASTER_GRID_START), null);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nAll master-grid heading checks passed.');
