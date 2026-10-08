import type { MatrixColumnDef, ColumnGroup } from '../components/MatrixTable';

export interface MasterGridBlockDefinition {
  blockNumber: number;
  title: string;
  columnCount: number;
  firstColumnIndex: number;
}

const BLOCK_COUNT = 13;
const WEEKS_PER_BLOCK = 4;
const LEFT_COLUMNS = [
  { key: 'level', label: 'Level', width: 80 },
  { key: 'name', label: 'Resident', width: 180 },
  { key: 'corpId', label: 'Corp. ID', width: 110 },
  { key: 'mobile', label: 'Mobile', width: 120 },
  { key: 'email', label: 'Email', width: 220 },
];

export function buildMasterGridColumns(): {
  columns: MatrixColumnDef[];
  groups: ColumnGroup[];
  blocks: MasterGridBlockDefinition[];
} {
  const blocks: MasterGridBlockDefinition[] = [];
  const groups: ColumnGroup[] = [];
  const columns: MatrixColumnDef[] = [];

  LEFT_COLUMNS.forEach((column) => {
    columns.push({
      key: column.key,
      label: column.label,
      width: column.width,
      pinned: true,
      title: column.label,
    } as any);
  });

  for (let block = 1; block <= BLOCK_COUNT; block += 1) {
    const firstIndex = columns.length;
    for (let week = 1; week <= WEEKS_PER_BLOCK; week += 1) {
      columns.push({
        key: `week_${block}_${week}`,
        label: `${block}.${week}`,
        width: 110,
        title: `${block}.${week}`,
      } as any);
    }
    blocks.push({
      blockNumber: block,
      title: `Block ${block}`,
      columnCount: WEEKS_PER_BLOCK,
      firstColumnIndex: firstIndex,
    });
    groups.push({
      key: `block_${block}`,
      label: `Block ${block}`,
      startColumnIndex: firstIndex,
      columnCount: WEEKS_PER_BLOCK,
    });
  }

  return { columns, groups, blocks };
}
