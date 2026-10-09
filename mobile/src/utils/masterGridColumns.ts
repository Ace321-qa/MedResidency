import type { MatrixColumnDef, ColumnGroup } from '../components/MatrixTable';
import { allWeeks, formatShortRange } from './masterGridCalendar';

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
 * its Sunday–Saturday window as a compact `28/06–04/07` range. The range is
 * drawn rotated top-to-bottom (`verticalSubtitle`), because a full date window
 * is wider than the column and used to be clipped to `28/06/2026–0…`.
 */
const WEEK_COLUMN_WIDTH = 110;
const WEEKS_PER_BLOCK = 4;

export function buildMasterGridColumns(): {
  columns: MatrixColumnDef[];
  groups: ColumnGroup[];
  blocks: MasterGridBlockDefinition[];
} {
  const blocks: MasterGridBlockDefinition[] = [];
  const groups: ColumnGroup[] = [];
  const columns: MatrixColumnDef[] = [];

  allWeeks().forEach((week, index) => {
    if (week.weekInBlock === 1) {
      blocks.push({
        blockNumber: week.blockNumber,
        title: `Block ${week.blockNumber}`,
        columnCount: WEEKS_PER_BLOCK,
        firstColumnIndex: index,
      });
      groups.push({
        key: `block_${week.blockNumber}`,
        label: `Block ${week.blockNumber}`,
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
