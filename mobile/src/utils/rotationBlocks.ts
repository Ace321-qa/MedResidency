import type { RotationBlock } from '../types/api';
import { toComparableDate } from './format';

/**
 * Where an academic block sits relative to a calendar day.
 *
 * The Rotations landing screen uses this to decide which blocks to show by
 * default: the running block is always visible, past blocks are hidden behind a
 * toggle, and the remaining future blocks are collapsible.
 *
 * - `PAST`    the block has finished (`end_date < today`).
 * - `CURRENT` today falls inside the block (`start_date <= today <= end_date`).
 * - `FUTURE`  the block has not started yet (`start_date > today`).
 * - `UNKNOWN` the block carries no usable start/end date.
 */
export type BlockPhase = 'PAST' | 'CURRENT' | 'FUTURE' | 'UNKNOWN';

/**
 * A block's start day as `YYYY-MM-DD`, safe to compare lexically.
 *
 * `start_date_iso` is DATE_FORMATted in SQL and is timezone-proof; the raw
 * `start_date` (a MySQL DATE that mysql2 materialises as a UTC instant) is only
 * a fallback for rows that predate the `_iso` projection.
 */
export function blockStartDay(block: RotationBlock): string | null {
  return toComparableDate(block.start_date_iso ?? block.start_date ?? null);
}

/** A block's end day as `YYYY-MM-DD`, safe to compare lexically. */
export function blockEndDay(block: RotationBlock): string | null {
  return toComparableDate(block.end_date_iso ?? block.end_date ?? null);
}

/** Classify one block against `today` (`YYYY-MM-DD`). */
export function blockPhase(block: RotationBlock, today: string): BlockPhase {
  const start = blockStartDay(block);
  const end = blockEndDay(block);
  if (!start || !end) return 'UNKNOWN';
  if (end < today) return 'PAST';
  if (start <= today && end >= today) return 'CURRENT';
  if (start > today) return 'FUTURE';
  // `end >= today` but `start > today` cannot happen when start <= end; a block
  // with inverted dates is treated as not-yet-started rather than mislabelled.
  return 'UNKNOWN';
}

export interface PartitionedBlocks {
  /** Finished blocks, oldest first. */
  past: RotationBlock[];
  /** The block running today, if any. */
  current: RotationBlock | null;
  /** Every block that starts after today, soonest first. */
  future: RotationBlock[];
}

/** Split a block list into past / current / future, each in date order. */
export function partitionBlocksByDate(
  blocks: readonly RotationBlock[],
  today: string,
): PartitionedBlocks {
  const sorted = [...blocks].sort((a, b) =>
    (blockStartDay(a) ?? '').localeCompare(blockStartDay(b) ?? ''),
  );

  const past: RotationBlock[] = [];
  const future: RotationBlock[] = [];
  let current: RotationBlock | null = null;

  for (const block of sorted) {
    const phase = blockPhase(block, today);
    if (phase === 'PAST') past.push(block);
    else if (phase === 'CURRENT') current = block;
    else future.push(block);
  }

  return { past, current, future };
}
