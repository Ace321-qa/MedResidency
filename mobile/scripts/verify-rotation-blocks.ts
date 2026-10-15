/**
 * Checks the Rotations landing screen's block classification.
 *
 *     npx tsx scripts/verify-rotation-blocks.ts
 *
 * The screen decides what to show from the calendar day alone, so the failure
 * mode worth guarding against is a block on the wrong side of "today" — a
 * finished block shown as Current, or the running block hidden behind the past
 * toggle because its dates were read in the wrong timezone. Every case below
 * pins a boundary: the last day of a block is still Current, the day after is
 * Past, and a gap between blocks promotes the next one to Upcoming.
 */

import type { RotationBlock } from '../src/types/api';
import { blockEndDay, blockPhase, blockStartDay, partitionBlocksByDate } from '../src/utils/rotationBlocks';

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

/** A block with sane defaults; override only the fields a case cares about. */
function makeBlock(overrides: Partial<RotationBlock>): RotationBlock {
  return {
    block_id: 1,
    program_id: 1,
    program_code: '1207800001',
    week_start_day: 'Sunday',
    academic_year: '2026-2027',
    block_number: 1,
    block_name: 'Block 1',
    start_date: '2026-10-11T00:00:00.000Z',
    end_date: '2026-11-07T00:00:00.000Z',
    start_date_iso: '2026-10-11',
    end_date_iso: '2026-11-07',
    actual_start_day: 'Sunday',
    actual_end_day: 'Saturday',
    block_days: 28,
    block_weeks: 4,
    ...overrides,
  };
}

console.log('\n-- a block day is read from the timezone-proof ISO projection --');
{
  const block = makeBlock({
    start_date: '2026-10-10T18:00:00.000Z',
    start_date_iso: '2026-10-11',
    end_date: '2026-11-07T18:00:00.000Z',
    end_date_iso: '2026-11-07',
  });
  assert('the start day is the ISO date', blockStartDay(block), '2026-10-11');
  assert('the end day is the ISO projection', blockEndDay(block), '2026-11-07');
}

console.log('\n-- a block with no ISO projection falls back to the raw date --');
{
  const block = makeBlock({ start_date_iso: null, end_date_iso: null });
  assert('the raw start day is normalised', blockStartDay(block), '2026-10-11');
  assert('a missing date is null', blockStartDay(makeBlock({ start_date: null as any, start_date_iso: null })), null);
}

console.log('\n-- the phase boundaries are inclusive of today --');
{
  const block = makeBlock({ start_date_iso: '2026-10-11', end_date_iso: '2026-11-07' });
  assert('today before the block is future', blockPhase(block, '2026-10-10'), 'FUTURE');
  assert('the first day is current', blockPhase(block, '2026-10-11'), 'CURRENT');
  assert('a day inside is current', blockPhase(block, '2026-10-25'), 'CURRENT');
  assert('the last day is still current', blockPhase(block, '2026-11-07'), 'CURRENT');
  assert('the day after is past', blockPhase(block, '2026-11-08'), 'PAST');
}

console.log('\n-- a block without usable dates is never claimed as running --');
{
  const block = makeBlock({ start_date_iso: null, start_date: '', end_date_iso: null, end_date: '' });
  assert('missing dates classify as unknown', blockPhase(block, '2026-10-25'), 'UNKNOWN');
}

console.log('\n-- the partition splits a year into past, current and future --');
{
  const blocks = [
    makeBlock({ block_id: 3, block_name: 'Block 3', start_date_iso: '2026-12-06', end_date_iso: '2027-01-02' }),
    makeBlock({ block_id: 1, block_name: 'Block 1', start_date_iso: '2026-10-11', end_date_iso: '2026-11-07' }),
    makeBlock({ block_id: 2, block_name: 'Block 2', start_date_iso: '2026-11-08', end_date_iso: '2026-12-05' }),
    makeBlock({ block_id: 4, block_name: 'Block 4', start_date_iso: '2027-01-03', end_date_iso: '2027-01-30' }),
  ];
  const split = partitionBlocksByDate(blocks, '2026-11-20');

  assert('the finished blocks are past, oldest first', split.past.map((b) => b.block_id), [1]);
  assert('the running block is current', split.current?.block_id, 2);
  assert('the blocks still to come are future, soonest first', split.future.map((b) => b.block_id), [3, 4]);
  assert('every block is accounted for', split.past.length + (split.current ? 1 : 0) + split.future.length, 4);
}

console.log('\n-- an off-cycle gap leaves no current block but still anchors --');
{
  const blocks = [
    makeBlock({ block_id: 1, start_date_iso: '2026-10-11', end_date_iso: '2026-11-07' }),
    makeBlock({ block_id: 2, start_date_iso: '2026-11-15', end_date_iso: '2026-12-12' }),
  ];
  // 2026-11-10 sits between the two blocks.
  const split = partitionBlocksByDate(blocks, '2026-11-10');

  assert('nothing runs today', split.current, null);
  assert('the finished block is past', split.past.map((b) => b.block_id), [1]);
  assert('the next block leads the future list', split.future[0]?.block_id, 2);
}

console.log('\n-- an empty roster partitions to nothing, not a phantom block --');
{
  const split = partitionBlocksByDate([], '2026-11-20');
  assert('no past blocks', split.past.length, 0);
  assert('no current block', split.current, null);
  assert('no future blocks', split.future.length, 0);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nAll rotation-block checks passed.');
