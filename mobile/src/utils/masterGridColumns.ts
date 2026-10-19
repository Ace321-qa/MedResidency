import type { MatrixColumnDef, ColumnGroup } from '../components/MatrixTable';
import {
  allWeeks,
  BLOCK_COUNT,
  formatShortRange,
  MASTER_GRID_START,
  type GridStart,
} from './masterGridCalendar';
import { masterBlockHeading } from './masterGridHeadings';

export interface MasterGridBlockDefinition {
  blockNumber: number;
  title: string;
  columnCount: number;
  firstColumnIndex: number;
}

/**
 * The Weekly view's column set: 52 sub-weeks, grouped 4-up under Block 1..13.
 *
 * The column list is **week columns only** — the frozen resident pane lives
 * outside the horizontal scroller in `MatrixTable`, so the left-hand fields the
 * Excel template carries (Level, Name, Corp. ID, …) are not columns here. That
 * matters because `ColumnGroup.startColumnIndex` is an index into *this* list:
 * including the five frozen fields in it would push `Block 1` five columns to
 * the right of the sub-weeks it is meant to head.
 *
 * Each sub-column carries its `block.weekInBlock` label (`1.1`, `1.2`, …) and
 * its 7-day window as a compact `28/06–04/07` range. The range is drawn rotated
 * top-to-bottom (`verticalSubtitle`), because a full date window is wider than
 * the column and used to be clipped to `28/06/2026–0…`.
 *
 * Both tiers are computed from `gridStart` — the start date the Coordinator
 * picks in the grid's calendar — so selecting a Monday start redraws every
 * sub-header as Monday–Sunday without any other change.
 */
const WEEK_COLUMN_WIDTH = 110;
const WEEKS_PER_BLOCK = 4;

export function buildMasterGridColumns(gridStart: GridStart = MASTER_GRID_START): {
  columns: MatrixColumnDef[];
  groups: ColumnGroup[];
  blocks: MasterGridBlockDefinition[];
} {
  const blocks: MasterGridBlockDefinition[] = [];
  const groups: ColumnGroup[] = [];
  const columns: MatrixColumnDef[] = [];

  allWeeks(gridStart).forEach((week, index) => {
    if (week.weekInBlock === 1) {
      const heading = masterBlockHeading(week.blockNumber, gridStart);
      const label = heading ? `${heading.title} · ${heading.subtitle}` : `Block ${week.blockNumber}`;
      blocks.push({
        blockNumber: week.blockNumber,
        title: label,
        columnCount: WEEKS_PER_BLOCK,
        firstColumnIndex: index,
      });
      groups.push({
        key: `block_${week.blockNumber}`,
        label,
        startColumnIndex: index,
        columnCount: WEEKS_PER_BLOCK,
      });
    }

    columns.push({
      key: `week-${week.weekNumber}`,
      title: `${week.blockNumber}.${week.weekInBlock}`,
      subtitle: formatShortRange(week.start, week.end),
      verticalSubtitle: true,
      width: WEEK_COLUMN_WIDTH,
    });
  });

  return { columns, groups, blocks };
}

const BLOCK_COLUMN_WIDTH = 160;

/**
 * The key a block column and the cells under it share.
 *
 * The header and the cells must agree on a column's identity: a key that only
 * one side knows about paints a heading over blank cells, so both are minted
 * from this one function.
 */
export function blockColumnKey(blockNumber: number, blockId?: number | null): string {
  return blockId ? `block-${blockId}` : `block-missing-${blockNumber}`;
}

/**
 * The Block view's column set: 13 columns, one per block, no weekly sub-columns.
 *
 * Tier 1 is the block's *position* — `Block 5` — and tier 2 is its predetermined
 * window (`Sun 18 Oct - Sat 14 Nov 2026`). The title is deliberately built from
 * the block number and never from `rotation_blocks.block_name`: that column is
 * coordinator-typed free text and has held a rotation name ("Pediatrics"), which
 * is how a rotation ended up rendered as a column header. A rotation belongs to
 * a resident's cell; a header only names the calendar slot it sits in. This
 * mirrors the Weekly builder above and the exported report, which have always
 * derived their headings from the grid calendar alone.
 *
 * `blockIdsByNumber` is used for the column *key* only (so cells can be
 * addressed); no database name reaches either tier.
 */
export function buildMasterGridBlockColumns(
  blockIdsByNumber: ReadonlyMap<number, number | undefined>,
  gridStart: GridStart = MASTER_GRID_START,
): MatrixColumnDef[] {
  const columns: MatrixColumnDef[] = [];
  for (let blockNumber = 1; blockNumber <= BLOCK_COUNT; blockNumber += 1) {
    const heading = masterBlockHeading(blockNumber, gridStart);
    if (!heading) continue;
    columns.push({
      key: blockColumnKey(blockNumber, blockIdsByNumber.get(blockNumber)),
      title: heading.title,
      subtitle: heading.subtitle,
      width: BLOCK_COLUMN_WIDTH,
    });
  }
  return columns;
}
