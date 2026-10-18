import type {
  PrimaryCareAbsence,
  PrimaryCareClinicSlot,
  PrimaryCareCycle,
  PrimaryCareCycleSchedule,
  PrimaryCareDailyHeader,
  PrimaryCareMatrixColumn,
} from '../../types/api';
import { formatShortDate } from '../format';
import {
  WEEKDAY_SHORT,
  dayOfWeekMatches,
  formatCycleMetadataBanner,
  formatShiftRange,
  weekdayIndex,
  weekdayName,
} from '../cccMatrix';
import { dayNameOf, formatWeekSpan, weekDayDate, weekDaySequence, type DayName } from '../dateCalc';
import { formatDmy, rotationWindowForMonths } from '../masterGridCalendar';
import { cell, type ReportCell, type ReportModel } from './model';

/**
 * The Continuity Care Clinics weekly matrix as a report.
 *
 * One row per day (in the cycle's own week order), one column per numbered
 * clinic, plus the Leaves column and the backup/catchup pools beneath the
 * grid. The layout is recomputed from the `PrimaryCareCycleSchedule` the API
 * returns, using the same row-ordering and day-matching helpers as the screen,
 * so an exported matrix matches what is on screen down to the day order.
 */

export interface CccMatrixReportInput {
  schedule: PrimaryCareCycleSchedule;
  programLabel: string;
  programCode?: string | null;
  /** 'City', 'Rural', … when the screen tracks more than one site. */
  siteLabel?: string | null;
}

const HEADER_FILL = '#0F2C45';
const HEADER_TEXT = '#FFFFFF';
const BACKUP_DAYS: DayName[] = ['Sunday', 'Monday', 'Wednesday'];

function headerCell(text: string, colSpan?: number): ReportCell {
  return cell(text, { fill: HEADER_FILL, textColor: HEADER_TEXT, bold: true, align: 'center', colSpan });
}

interface ClinicColumn {
  key: string;
  clinicNumber: number;
  title: string;
  isLeaves: boolean;
}

/** The numbered clinic columns plus the trailing Leaves column. */
function buildClinicColumns(raw: PrimaryCareMatrixColumn[] | undefined): ClinicColumn[] {
  const columns: ClinicColumn[] = (raw ?? [])
    .filter((entry) => entry.clinic_number >= 1)
    .slice()
    .sort((left, right) => left.clinic_number - right.clinic_number)
    .map((entry) => ({
      key: `clinic-${entry.clinic_number}`,
      clinicNumber: entry.clinic_number,
      title: entry.label?.trim() || `Clinic ${entry.clinic_number}`,
      isLeaves: false,
    }));
  columns.push({ key: 'leaves', clinicNumber: 0, title: 'Leaves', isLeaves: true });
  return columns;
}

/** The day rows actually saved for the cycle, in the week's own order. */
function activeDaysFor(cycle: PrimaryCareCycle | null, headers: PrimaryCareDailyHeader[]): DayName[] {
  const sequence = weekDaySequence(cycle?.start_date ?? null);
  const persisted = new Set<DayName>();
  for (const header of headers) {
    const name = weekdayName(header.day_of_week);
    if (name) persisted.add(name);
  }
  return persisted.size === 0 ? sequence : sequence.filter((day) => persisted.has(day));
}

function headerForDay(headers: PrimaryCareDailyHeader[], day: DayName): PrimaryCareDailyHeader | null {
  const weekday = weekdayIndex(day);
  return headers.find((header) => dayOfWeekMatches(header.day_of_week, weekday)) ?? null;
}

function slotFor(
  schedule: PrimaryCareCycleSchedule,
  headers: PrimaryCareDailyHeader[],
  day: DayName,
  clinicNumber: number,
): PrimaryCareClinicSlot | null {
  const header = headerForDay(headers, day);
  if (!header) return null;
  return (
    schedule.slots.find((slot) => slot.daily_header_id === header.id && slot.clinic_number === clinicNumber) ?? null
  );
}

function absencesForDay(schedule: PrimaryCareCycleSchedule, day: DayName): PrimaryCareAbsence[] {
  const weekday = weekdayIndex(day);
  return (schedule.absences ?? []).filter((row) => dayOfWeekMatches(row.day_of_week, weekday));
}

function dayCellText(day: DayName, dateIso: string | null, header: PrimaryCareDailyHeader | null): string {
  const short = WEEKDAY_SHORT[weekdayIndex(day)] ?? day;
  const date = formatShortDate(dateIso);
  const shift = header?.shift_time ? formatShiftRange(header.shift_time) : '—';
  const pgy = header?.pgy_level || '—';
  const inCharge = header?.in_charge_faculty_name?.trim() || 'Unassigned';
  return `${short} ${date}\n${shift}\n${pgy}\nFaculty In-charge: ${inCharge}`;
}

function clinicCellText(slot: PrimaryCareClinicSlot | null): string {
  const residents = [slot?.resident_1_name, slot?.resident_2_name].filter((name): name is string => Boolean(name));
  const faculty = slot?.faculty_name?.trim() || null;
  const primary = residents.length > 0 ? residents.join(' / ') : 'Unassigned';
  return faculty ? `${primary}\n${faculty}` : primary;
}

function leavesCellText(absences: PrimaryCareAbsence[]): string {
  if (absences.length === 0) return 'No leave';
  const names = absences.map((row) => row.person_name).join(', ');
  return `${absences.length} away\n${names}`;
}

function backupRows(
  schedule: PrimaryCareCycleSchedule,
  activeDays: DayName[],
  columnCount: number,
): ReportCell[][] {
  const rows: ReportCell[][] = [];
  for (const day of BACKUP_DAYS) {
    if (!activeDays.includes(day)) continue;
    const pool = schedule.backups?.[day] ?? [];
    const names = pool.map((entry) => entry.faculty_name).filter((name): name is string => Boolean(name));
    rows.push([
      cell(`${day} catchup`, { bold: true }),
      cell(names.length > 0 ? names.join('  |  ') : 'No backup faculty set yet.', {
        colSpan: Math.max(1, columnCount - 1),
      }),
    ]);
  }
  return rows;
}

function sanitizeFileBase(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'ccc-matrix';
}

/** Build the export model for the CCC weekly clinic matrix. */
export function buildCccMatrixReport(input: CccMatrixReportInput): ReportModel {
  const { schedule } = input;
  const cycle = schedule.cycle;
  const headers = schedule.dailyHeaders ?? [];
  const columns = buildClinicColumns(schedule.columns);
  const activeDays = activeDaysFor(cycle, headers);

  const banner = formatCycleMetadataBanner({
    cycleNumber: cycle?.cycle_number,
    weekNumber: cycle?.week_number,
    startsOn: dayNameOf(cycle?.start_date ?? null),
    startDate: cycle?.start_date,
    shiftTime: headerForDay(headers, activeDays[0])?.shift_time,
    pgyLevel: headerForDay(headers, activeDays[0])?.pgy_level,
  });

  const headerRow: ReportCell[] = [headerCell('Day'), ...columns.map((column) => headerCell(column.title))];

  const rotation = rotationWindowForMonths(cycle?.start_date ?? null, Number(cycle?.rotation_window_months ?? 0));
  const startDate = cycle?.start_date ?? null;
  const endDate = cycle?.end_date ?? rotation?.endDate ?? null;
  const totalWeeks = cycle?.total_weeks ?? rotation?.totalWeeks ?? null;
  const period = startDate && endDate ? `${formatDmy(startDate)} – ${formatDmy(endDate)}` : startDate ?? '—';
  const duration = totalWeeks && startDate && endDate ? formatWeekSpan(totalWeeks, startDate, endDate) : null;

  const meta = [
    { label: 'Programme', value: input.programCode ? `${input.programLabel} (${input.programCode})` : input.programLabel },
    { label: 'Cycle', value: numeric(cycle?.cycle_number) },
    { label: 'Week', value: numeric(cycle?.week_number) },
    { label: 'Period', value: period },
  ];
  if (duration) meta.push({ label: 'Duration', value: duration });
  if (input.siteLabel) meta.push({ label: 'Site', value: input.siteLabel });
  meta.push({ label: 'Generated', value: formatDmy(new Date().toISOString().slice(0, 10)) });

  const cycleLabel = `Cycle ${numeric(cycle?.cycle_number)} · Week ${numeric(cycle?.week_number)}`;
  const rows: ReportCell[][] = [
    headerRow,
    ...activeDays.map((day, index) => buildDayRow(schedule, headers, columns, day, index, cycle)),
    ...backupRows(schedule, activeDays, columns.length),
  ];

  return {
    fileName: sanitizeFileBase(`CCC Matrix ${cycleLabel}`),
    sheetName: `CCC ${cycleLabel}`.slice(0, 31),
    title: 'Continuity Care Clinics',
    subtitle: `${banner} · ${activeDays.length} day${activeDays.length === 1 ? '' : 's'}`,
    meta,
    columns: [
      { header: 'Day', width: 200 },
      ...columns.map((column) => ({ header: column.title, width: column.isLeaves ? 150 : 130 })),
    ],
    rows,
    headerRows: 1,
    orientation: 'landscape',
  };
}

function numeric(value: string | null | undefined): string {
  const match = String(value ?? '').match(/\d+/);
  return match ? match[0] : value ? String(value) : '1';
}

function buildDayRow(
  schedule: PrimaryCareCycleSchedule,
  headers: PrimaryCareDailyHeader[],
  columns: ClinicColumn[],
  day: DayName,
  index: number,
  cycle: PrimaryCareCycle | null,
): ReportCell[] {
  const header = headerForDay(headers, day);
  const seq = weekDaySequence(cycle?.start_date ?? null);
  const offset = seq.indexOf(day);
  const dateIso = offset >= 0 ? weekDayDate(cycle?.start_date ?? null, offset) ?? null : null;
  const row: ReportCell[] = [cell(dayCellText(day, dateIso, header), { bold: true })];
  for (const column of columns) {
    if (column.isLeaves) {
      row.push(cell(leavesCellText(absencesForDay(schedule, day))));
    } else {
      row.push(cell(clinicCellText(slotFor(schedule, headers, day, column.clinicNumber))));
    }
  }
  return row;
}
