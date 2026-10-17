import type { CohortGridCell } from '../../types/api';
import {
  blockWindow,
  formatDmy,
  formatShortRange,
  gridStartFrom,
  weekInBlockForDate,
  weeksForRange,
  weekNumberForDate,
  weekWindow,
  type GridStart,
} from '../masterGridCalendar';
import { rotationBadgeLabel, rotationPalette } from '../rotationBadges';
import { compareResidentsByPgy, type ResidentOrderFields } from '../residentOrder';
import { cell, coloredCell, type ReportCell, type ReportModel } from './model';

/**
 * The Master Rotation Grid as a report.
 *
 * The screen paints this same rota as a React matrix; a coordinator then needs
 * it as a file. Rather than lift state out of the screen, the builder takes the
 * raw `CohortGridCell[]` the API returns and recomputes the layout from the
 * chosen start date — the same calendar helpers the screen uses, so the file and
 * the screen cannot disagree about where block 7 begins.
 *
 * Two shapes are produced:
 *   - `block`: 13 block columns; each cell lists the sub-week slots it holds
 *     (`7.2: CARD`).
 *   - `weekly`: 52 week columns grouped under the 13 block banners, one badge
 *     per week.
 */

export type MasterGridViewMode = 'block' | 'weekly';

export interface MasterGridReportInput {
  /** Raw rows from `fetchCohortGrid`. */
  rows: CohortGridCell[];
  /** The academic year start the grid is currently aligned to. */
  startDate: GridStart;
  viewMode: MasterGridViewMode;
  academicYear: string;
  /** 'All' or 'PGY-1'… — what the cohort filter is currently showing. */
  cohortLabel: string;
  programLabel: string;
  programCode?: string | null;
}

const HEADER_FILL = '#0F2C45';
const HEADER_TEXT = '#FFFFFF';
const SUBHEADER_FILL = '#E2E8F0';
const SUBHEADER_TEXT = '#0F172A';

interface GridBlockMeta {
  blockId: number;
  blockNumber: number;
  blockName: string;
  startIso: string | null;
}

interface GridResidentMeta {
  residentId: number;
  name: string;
  pgyLevel: number | null;
  firstName: string;
  lastName: string;
  employeeId: string | null;
}

/** Adapt the report's camelCase resident to the shared cohort order fields. */
function residentOrder(resident: GridResidentMeta): ResidentOrderFields {
  return {
    resident_id: resident.residentId,
    first_name: resident.firstName,
    last_name: resident.lastName,
    employee_id: resident.employeeId,
    pgy_level: resident.pgyLevel,
  };
}

function isAssigned(row: CohortGridCell): boolean {
  return row.is_assigned === 1 && Boolean(row.rotation_name);
}

function assignmentStart(row: CohortGridCell): string | null {
  return row.assignment_start_date_iso ?? row.start_date ?? null;
}

function assignmentEnd(row: CohortGridCell): string | null {
  return row.assignment_end_date_iso ?? row.end_date ?? null;
}

/** Every 1..52 week an assignment touches, or `[]` when it cannot be placed. */
function weeksForAssignment(row: CohortGridCell, gridStart: string): number[] {
  const start = assignmentStart(row);
  const end = assignmentEnd(row);
  if (start && end) return weeksForRange(start, end, gridStart);
  for (const candidate of [start, end]) {
    const week = weekNumberForDate(candidate, gridStart);
    if (week) return [week];
  }
  return [];
}

/** The 1..4 sub-week slots an assignment occupies inside its block. */
function slotsForAssignment(row: CohortGridCell, block: GridBlockMeta | undefined, gridStart: string): number[] {
  const slots = new Set<number>();
  const startSlot = weekInBlockForDate(block?.startIso ?? null, assignmentStart(row));
  if (startSlot !== null) slots.add(startSlot);
  for (const week of weeksForAssignment(row, gridStart)) {
    const slot = ((week - 1) % 4) + 1;
    if (slot >= 1 && slot <= 4) slots.add(slot);
  }
  return [...slots].sort((left, right) => left - right);
}

/** Collapse duplicate rows that name the same rotation. */
function dedupeByRotation(rows: CohortGridCell[]): CohortGridCell[] {
  const seen = new Set<string>();
  const unique: CohortGridCell[] = [];
  for (const row of rows) {
    const identity =
      row.rotation_id === null || row.rotation_id === undefined
        ? `c:${row.rotation_code ?? row.rotation_name}`
        : `id:${row.rotation_id}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(row);
  }
  return unique;
}

function headerCell(text: string, colSpan?: number): ReportCell {
  return cell(text, { fill: HEADER_FILL, textColor: HEADER_TEXT, bold: true, align: 'center', colSpan });
}

function subHeaderCell(text: string): ReportCell {
  return cell(text, { fill: SUBHEADER_FILL, textColor: SUBHEADER_TEXT, bold: false, align: 'center' });
}

function rotationCell(text: string, rotation: CohortGridCell): ReportCell {
  const palette = rotationPalette(rotation.rotation_code, rotation.rotation_id);
  return coloredCell(text, palette.surface, palette.foreground, { align: 'left' });
}

function pgyLabel(value: number | null): string {
  return value ? `PGY-${value}` : 'PGY —';
}

function blockWindowLabel(blockNumber: number, gridStart: string): string {
  const window = blockWindow(blockNumber, gridStart);
  return window ? formatShortRange(window.start, window.end) : '';
}

function buildIndex(rows: CohortGridCell[]): {
  residents: GridResidentMeta[];
  blocks: Map<number, GridBlockMeta>;
  byResidentBlock: Map<string, CohortGridCell[]>;
} {
  const blocks = new Map<number, GridBlockMeta>();
  const residents = new Map<number, GridResidentMeta>();
  const byResidentBlock = new Map<string, CohortGridCell[]>();

  for (const row of rows) {
    if (!blocks.has(row.block_number)) {
      blocks.set(row.block_number, {
        blockId: row.block_id,
        blockNumber: row.block_number,
        blockName: row.block_name,
        startIso: row.block_start_date_iso ?? null,
      });
    }
    if (!residents.has(row.resident_id)) {
      residents.set(row.resident_id, {
        residentId: row.resident_id,
        name: row.resident_name,
        pgyLevel: row.pgy_level,
        firstName: row.first_name,
        lastName: row.last_name,
        employeeId: row.employee_id ?? null,
      });
    }
    const key = `${row.resident_id}:${row.block_number}`;
    const bucket = byResidentBlock.get(key);
    if (bucket) bucket.push(row);
    else byResidentBlock.set(key, [row]);
  }

  return {
    // Senior cohorts lead the exported grid, matching the on-screen matrix row
    // order (PGY-5 first, then alphabetical within a level).
    residents: [...residents.values()].sort((a, b) =>
      compareResidentsByPgy(residentOrder(a), residentOrder(b)),
    ),
    blocks,
    byResidentBlock,
  };
}

/** One resident's block-mode cell: the sub-week slots they are assigned to. */
function blockCellValue(
  block: GridBlockMeta | undefined,
  residentBlockRows: CohortGridCell[],
  gridStart: string,
): ReportCell {
  const assignments = dedupeByRotation(residentBlockRows.filter(isAssigned));
  if (assignments.length === 0) return cell('');

  const slots = new Map<number, CohortGridCell>();
  const unplaced: CohortGridCell[] = [];
  for (const row of assignments) {
    const covered = slotsForAssignment(row, block, gridStart);
    if (covered.length === 0) {
      unplaced.push(row);
      continue;
    }
    for (const slot of covered) if (!slots.has(slot)) slots.set(slot, row);
  }

  const blockNumber = block?.blockNumber ?? 0;
  const labels: string[] = [];
  for (let slot = 1; slot <= 4; slot += 1) {
    const row = slots.get(slot);
    if (row) labels.push(`${blockNumber}.${slot}: ${rotationBadgeLabel(row.rotation_code, row.rotation_name)}`);
  }
  for (const row of unplaced) labels.push(rotationBadgeLabel(row.rotation_code, row.rotation_name));

  return rotationCell(labels.join('\n'), assignments[0]);
}

/** Every week a resident is assigned, mapped to the assignment covering it. */
function weeksByResident(
  index: ReturnType<typeof buildIndex>,
  residentId: number,
  gridStart: string,
): Map<number, CohortGridCell> {
  const byWeek = new Map<number, CohortGridCell>();
  for (let blockNumber = 1; blockNumber <= 13; blockNumber += 1) {
    const rows = index.byResidentBlock.get(`${residentId}:${blockNumber}`) ?? [];
    for (const assignment of dedupeByRotation(rows.filter(isAssigned))) {
      for (const week of weeksForAssignment(assignment, gridStart)) {
        if (!byWeek.has(week)) byWeek.set(week, assignment);
      }
    }
  }
  return byWeek;
}

function buildBlockRows(
  index: ReturnType<typeof buildIndex>,
  gridStart: string,
): ReportCell[][] {
  return index.residents.map((resident) => {
    const row: ReportCell[] = [cell(resident.name), cell(pgyLabel(resident.pgyLevel), { align: 'center' })];
    for (let blockNumber = 1; blockNumber <= 13; blockNumber += 1) {
      const rows = index.byResidentBlock.get(`${resident.residentId}:${blockNumber}`) ?? [];
      row.push(blockCellValue(index.blocks.get(blockNumber), rows, gridStart));
    }
    return row;
  });
}

function buildWeeklyRows(
  index: ReturnType<typeof buildIndex>,
  gridStart: string,
): ReportCell[][] {
  return index.residents.map((resident) => {
    const row: ReportCell[] = [cell(resident.name), cell(pgyLabel(resident.pgyLevel), { align: 'center' })];
    const byWeek = weeksByResident(index, resident.residentId, gridStart);
    for (let week = 1; week <= 52; week += 1) {
      const assignment = byWeek.get(week);
      if (!assignment) {
        row.push(cell(''));
        continue;
      }
      const window = weekWindow(week, gridStart);
      const prefix = window ? `${window.blockNumber}.${window.weekInBlock}: ` : '';
      row.push(rotationCell(`${prefix}${rotationBadgeLabel(assignment.rotation_code, assignment.rotation_name)}`, assignment));
    }
    return row;
  });
}

function buildWeeklyHeader(gridStart: string): ReportCell[][] {
  const blockRow: ReportCell[] = [headerCell('Resident'), headerCell('PGY')];
  const weekRow: ReportCell[] = [subHeaderCell(''), subHeaderCell('')];
  for (let blockNumber = 1; blockNumber <= 13; blockNumber += 1) {
    blockRow.push(headerCell(`Block ${blockNumber}`, 4));
  }
  for (let week = 1; week <= 52; week += 1) {
    const window = weekWindow(week, gridStart);
    weekRow.push(subHeaderCell(window ? `${window.blockNumber}.${window.weekInBlock}` : String(week)));
  }
  return [blockRow, weekRow];
}

function collectLegend(rows: CohortGridCell[]): { label: string; color: string }[] {
  const seen = new Map<string, { label: string; color: string }>();
  for (const row of rows) {
    if (!isAssigned(row)) continue;
    const key = row.rotation_code ?? `id:${row.rotation_id ?? row.rotation_name}`;
    if (seen.has(key)) continue;
    const palette = rotationPalette(row.rotation_code, row.rotation_id);
    const label = rotationBadgeLabel(row.rotation_code, row.rotation_name);
    const name = (row.rotation_name ?? '').trim();
    seen.set(key, { label: name && name !== label ? `${label} — ${name}` : label, color: palette.surface });
  }
  return [...seen.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function sanitizeFileBase(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'master-grid';
}

/**
 * Excel forbids `: \ / ? * [ ]` in a worksheet name and caps it at 31
 * characters. The academic year is held in its display form (`2026/2027`), so a
 * raw interpolation would name the sheet `Master Grid 2026/2027` and make the
 * server's ExcelJS renderer throw. Normalise it to a legal name here as well as
 * server-side, so the model is valid whichever renderer consumes it.
 */
function sanitizeSheetName(value: string): string {
  return value.replace(/[\\/*?:[\]]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Master Grid';
}

/** Build the export model for the Master Rotation Grid. */
export function buildMasterGridReport(input: MasterGridReportInput): ReportModel {
  const gridStart = gridStartFrom(input.startDate);
  const index = buildIndex(input.rows);
  const weekly = input.viewMode === 'weekly';

  const headerRows = weekly
    ? buildWeeklyHeader(gridStart)
    : [
        [headerCell('Resident'), headerCell('PGY'), ...Array.from({ length: 13 }, (_, i) => headerCell(`Block ${i + 1}`))],
        [subHeaderCell(''), subHeaderCell(''), ...Array.from({ length: 13 }, (_, i) => subHeaderCell(blockWindowLabel(i + 1, gridStart)))],
      ];
  const body = weekly ? buildWeeklyRows(index, gridStart) : buildBlockRows(index, gridStart);

  const firstBlock = blockWindow(1, gridStart);
  const lastBlock = blockWindow(13, gridStart);
  const period =
    firstBlock && lastBlock ? `${formatDmy(firstBlock.start)} – ${formatDmy(lastBlock.end)}` : gridStart;

  const meta = [
    { label: 'Academic year', value: input.academicYear },
    { label: 'Programme', value: input.programCode ? `${input.programLabel} (${input.programCode})` : input.programLabel },
    { label: 'Cohort', value: input.cohortLabel },
    { label: 'Period', value: period },
    { label: 'View', value: weekly ? 'Weekly' : 'Block' },
    { label: 'Generated', value: formatDmy(new Date().toISOString().slice(0, 10)) },
  ];

  const columns = [
    { header: 'Resident', width: 160 },
    { header: 'PGY', width: 56 },
    ...(weekly
      ? Array.from({ length: 52 }, () => ({ width: 64 }))
      : Array.from({ length: 13 }, () => ({ width: 150 }))),
  ];

  return {
    fileName: sanitizeFileBase(`Master Rotation Grid ${input.academicYear} ${weekly ? 'Weekly' : 'Block'}`),
    sheetName: sanitizeSheetName(`Master Grid ${input.academicYear}`),
    title: 'Master Rotation Grid',
    subtitle: `${input.academicYear} · ${weekly ? 'Weekly view' : 'Block view'} · ${index.residents.length} resident${index.residents.length === 1 ? '' : 's'}`,
    meta,
    columns,
    rows: [...headerRows, ...body],
    headerRows: headerRows.length,
    legend: collectLegend(input.rows),
    orientation: 'landscape',
  };
}
