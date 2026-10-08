import { addDays, diffDays, parseCalendarDate } from './dateCalc';

/**
 * The Master Rotation Grid calendar: 13 blocks × 4 weeks = 52 weekly columns,
 * starting Sunday 28/06/2026.
 *
 * The rules, from the institutional spreadsheet the platform mirrors:
 *
 *     week W start = 28/06/2026 + (W - 1) × 7 days   (always a Sunday)
 *     week W end   = start + 6 days                   (always a Saturday)
 *     block B      = weeks (B-1)×4 + 1 … B×4
 *
 *     Block 1 W1  28/06/2026 – 04/07/2026
 *     Block 1 W4  19/07/2026 – 25/07/2026
 *     Block 2 W1  26/07/2026 – 01/08/2026
 *     Block 13 W4 20/06/2027 – 26/06/2027
 *
 * `src/utils/masterGridCalendar.js` on the server is the mirror of this file:
 * the workbook the API generates, the columns this app draws and the weeks the
 * importer writes all describe the same 52 windows, and a one-week drift
 * between them puts a rotation in the wrong column of the grid.
 * `scripts/verify-master-grid-52w.js` checks both halves against the same
 * literal dates.
 *
 * All arithmetic is done on `YYYY-MM-DD` strings in UTC, through `dateCalc.ts`,
 * so a week never lands on a Monday because of a timezone round-trip.
 */

/** Sunday 28 June 2026 — week 1, block 1. */
export const MASTER_GRID_START = '2026-06-28';

export const BLOCK_COUNT = 13;
export const WEEKS_PER_BLOCK = 4;
export const WEEK_COUNT = BLOCK_COUNT * WEEKS_PER_BLOCK;

/** One weekly subcolumn: its place in the block and its Sunday-Saturday window. */
export interface MasterWeekWindow {
  /** 1..52, the column's index across the whole year. */
  weekNumber: number;
  /** 1..13. */
  blockNumber: number;
  /** 1..4, the position inside the block. */
  weekInBlock: number;
  start: string;
  end: string;
}

/** One block's four weekly windows, or `[]` outside 1..13. */
export function blockWeeks(blockNumber: number): MasterWeekWindow[] {
  if (!Number.isInteger(blockNumber) || blockNumber < 1 || blockNumber > BLOCK_COUNT) return [];
  const first = (blockNumber - 1) * WEEKS_PER_BLOCK + 1;
  return [first, first + 1, first + 2, first + 3].map((week) => weekWindow(week)!);
}

/** All 52 weeks, in column order. */
export function allWeeks(): MasterWeekWindow[] {
  const weeks: MasterWeekWindow[] = [];
  for (let week = 1; week <= WEEK_COUNT; week += 1) weeks.push(weekWindow(week)!);
  return weeks;
}

/**
 * One weekly window, or `null` outside 1..52.
 *
 * Returned with non-null weeks only by the helpers above, which is why they
 * assert the range first; callers that hold an arbitrary number use the nullable
 * form directly.
 */
export function weekWindow(weekNumber: number): MasterWeekWindow | null {
  if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > WEEK_COUNT) return null;

  const start = addDays(MASTER_GRID_START, (weekNumber - 1) * 7);
  if (!start) return null;

  return {
    weekNumber,
    blockNumber: Math.ceil(weekNumber / WEEKS_PER_BLOCK),
    weekInBlock: ((weekNumber - 1) % WEEKS_PER_BLOCK) + 1,
    start,
    end: addDays(start, 6) ?? start,
  };
}

/**
 * The 1..52 week a date falls in, or `null` when it lies outside the grid.
 *
 * A non-Sunday date still resolves, to the week whose window contains it.
 */
export function weekNumberForDate(value: string | null | undefined): number | null {
  const days = diffDays(MASTER_GRID_START, value ?? '');
  if (days === null || days < 0) return null;

  const week = Math.floor(days / 7) + 1;
  return week <= WEEK_COUNT ? week : null;
}

/** True when `[startDate, endDate]` shares at least one day with the week. */
export function overlapsWeek(weekNumber: number, startDate: string | null | undefined, endDate: string | null | undefined): boolean {
  const week = weekWindow(weekNumber);
  if (!week || !startDate || !endDate) return false;
  if (endDate < week.start || startDate > week.end) return false;
  return true;
}

/** Every week `[startDate, endDate]` touches, ascending. */
export function weeksForRange(startDate: string, endDate: string): number[] {
  const weeks: number[] = [];
  for (let week = 1; week <= WEEK_COUNT; week += 1) {
    if (overlapsWeek(week, startDate, endDate)) weeks.push(week);
  }
  return weeks;
}

/** `28/06/2026`, the `DD/MM/YYYY` form the workbook's date rows use. */
export function formatDmy(value: string | null | undefined): string {
  const parts = parseCalendarDate(value);
  if (!parts) return '';
  return `${pad(parts.day)}/${pad(parts.month)}/${parts.year}`;
}

/** `28/06–04/07`, the compact pair a narrow column heading can hold. */
export function formatShortRange(startDate: string | null | undefined, endDate: string | null | undefined): string {
  const from = parseCalendarDate(startDate);
  const to = parseCalendarDate(endDate);
  if (!from || !to) return '';
  return `${pad(from.day)}/${pad(from.month)}–${pad(to.day)}/${pad(to.month)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
