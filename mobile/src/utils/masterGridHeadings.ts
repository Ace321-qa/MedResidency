import { describeWindow } from './dateCalc';
import { blockWindow, MASTER_GRID_START, type GridStart } from './masterGridCalendar';

/**
 * A block column's two heading tiers, for the Master Rotation Grid.
 *
 * `title` is the block's **position** — `Block 5` — and `subtitle` is the
 * calendar window that position covers (`Sun 18 Oct - Sat 14 Nov 2026`). Both
 * are derived from the grid's own calendar, never from the database.
 *
 * A block's `rotation_blocks.block_name` is deliberately absent from this shape.
 * That column is coordinator-typed free text and has held a rotation name
 * ("Pediatrics"), and reading it as a heading is how a rotation once rendered as
 * a column header: the first visible column showed "Pediatrics" where it should
 * have shown "Block 5". A rotation belongs inside a resident's cell; a heading
 * only names the calendar slot above it. Keeping the name out of the heading
 * type makes that invariant structural rather than a convention.
 *
 * This module is intentionally free of component imports so it can be checked
 * under `tsconfig.verify.json` without pulling React Native in.
 */
export interface MasterBlockHeading {
  /** 1..13. */
  blockNumber: number;
  /** `Block 5` — never a rotation or block name. */
  title: string;
  /** `Sun 18 Oct - Sat 14 Nov 2026`. */
  subtitle: string;
}

/** The heading for block `blockNumber`, or `null` when it has no calendar window. */
export function masterBlockHeading(
  blockNumber: number,
  gridStart: GridStart = MASTER_GRID_START,
): MasterBlockHeading | null {
  const window = blockWindow(blockNumber, gridStart);
  if (!window) return null;

  return {
    blockNumber,
    title: `Block ${blockNumber}`,
    subtitle: describeWindow(window.start, window.end),
  };
}
