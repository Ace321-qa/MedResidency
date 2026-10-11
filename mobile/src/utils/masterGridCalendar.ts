import { addDays, diffDays, parseCalendarDate, resolveCalendarDate } from './dateCalc';

/**
 * The Master Rotation Grid calendar: 13 blocks × 4 weeks = 52 weekly columns.
 *
 * The grid used to be pinned to Sunday 28/06/2026, but the academic year now
 * starts on whatever day the Coordinator picks in the grid's calendar picker.
 * Every function therefore takes an optional `gridStart` (a `YYYY-MM-DD` string
 * or a `Date`); omit it and the institutional default applies.
 *
 *     week W start = gridStart + (W - 1) × 7 days
 *     week W end   = week W start + 6 days
 *     block B      = weeks (B-1)×4 + 1 … B×4
 *
 * The day of the week `gridStart` falls on is preserved throughout: a Sunday
 * start yields Sunday–Saturday weeks, a Monday start Monday–Sunday ones.
 */

/** Sunday 28 June 2026 — the institutional default; week 1, block 1. */
export const MASTER_GRID_START = '2026-06-28';

export const BLOCK_COUNT = 13;
export const WEEKS_PER_BLOCK = 4;
export const WEEK_COUNT = BLOCK_COUNT * WEEKS_PER_BLOCK;

/** Either a `YYYY-MM-DD` string or a `Date`; both resolve to the same calendar day. */
export type GridStart = string | Date | null | undefined;

/** Coerce whatever a caller supplies into the `YYYY-MM-DD` grid start. */
export function gridStartFrom(value?: GridStart): string {
  return resolveCalendarDate(value ?? null) ?? MASTER_GRID_START;
}

/** One weekly subcolumn: its place in the block and its inclusive 7-day window. */
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

/** One block's four weekly windows plus the block's own inclusive window. */
export interface MasterBlockWindow {
  /** 1..13. */
  blockNumber: number;
  start: string;
  end: string;
  weeks: MasterWeekWindow[];
}

/** One block's four weekly windows, or `[]` outside 1..13. */
export function blockWeeks(blockNumber: number, gridStart: GridStart = MASTER_GRID_START): MasterWeekWindow[] {
  if (!Number.isInteger(blockNumber) || blockNumber < 1 || blockNumber > BLOCK_COUNT) return [];
  const first = (blockNumber - 1) * WEEKS_PER_BLOCK + 1;
  return [first, first + 1, first + 2, first + 3].map((week) => weekWindow(week, gridStart)!);
}

/** All 52 weeks, in column order. */
export function allWeeks(gridStart: GridStart = MASTER_GRID_START): MasterWeekWindow[] {
  const weeks: MasterWeekWindow[] = [];
  for (let week = 1; week <= WEEK_COUNT; week += 1) weeks.push(weekWindow(week, gridStart)!);
  return weeks;
}

/**
 * The whole block a `blockNumber` covers — its first week's start through its
 * last week's end — or `null` outside 1..13.
 */
export function blockWindow(blockNumber: number, gridStart: GridStart = MASTER_GRID_START): MasterBlockWindow | null {
  const weeks = blockWeeks(blockNumber, gridStart);
  if (weeks.length === 0) return null;
  return {
    blockNumber,
    start: weeks[0].start,
    end: weeks[weeks.length - 1].end,
    weeks,
  };
}

/** Every block window, 1..13, in order. */
export function blockWindows(gridStart: GridStart = MASTER_GRID_START): MasterBlockWindow[] {
  const windows: MasterBlockWindow[] = [];
  for (let block = 1; block <= BLOCK_COUNT; block += 1) windows.push(blockWindow(block, gridStart)!);
  return windows;
}

/**
 * One weekly window, or `null` outside 1..52.
 *
 * Returned with non-null weeks only by the helpers above, which is why they
 * assert the range first; callers that hold an arbitrary number use the nullable
 * form directly.
 */
export function weekWindow(weekNumber: number, gridStart: GridStart = MASTER_GRID_START): MasterWeekWindow | null {
  if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > WEEK_COUNT) return null;

  const start = addDays(gridStartFrom(gridStart), (weekNumber - 1) * 7);
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
 * A non-week-start date still resolves, to the week whose window contains it.
 */
export function weekNumberForDate(
  value: string | null | undefined,
  gridStart: GridStart = MASTER_GRID_START,
): number | null {
  const days = diffDays(gridStartFrom(gridStart), value ?? '');
  if (days === null || days < 0) return null;

  const week = Math.floor(days / 7) + 1;
  return week <= WEEK_COUNT ? week : null;
}

/** True when `[startDate, endDate]` shares at least one day with the week. */
export function overlapsWeek(
  weekNumber: number,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  gridStart: GridStart = MASTER_GRID_START,
): boolean {
  const week = weekWindow(weekNumber, gridStart);
  if (!week || !startDate || !endDate) return false;
  if (endDate < week.start || startDate > week.end) return false;
  return true;
}

/**
 * The 1..4 sub-week slot a date falls in inside a 28-day block.
 *
 * Week 1 is days 1-7 of the block, week 2 days 8-14, week 3 days 15-21 and
 * week 4 days 22-28, matching the `B.1`..`B.4` column labels. Offsets are taken
 * against the block's *own* start date rather than the fixed grid start, so an
 * assignment whose window is expressed relative to a real rotation block always
 * lands on the correct sub-week.
 *
 * Returns `null` when either date is unknown or the assignment starts before
 * the block or spills past its fourth week.
 */
export function weekInBlockForDate(
  blockStartIso: string | null | undefined,
  dateIso: string | null | undefined,
): number | null {
  if (!blockStartIso || !dateIso) return null;
  const days = diffDays(blockStartIso, dateIso);
  if (days === null || days < 0) return null;
  const slot = Math.floor(days / 7) + 1;
  return slot >= 1 && slot <= WEEKS_PER_BLOCK ? slot : null;
}

/** Every week `[startDate, endDate]` touches, ascending. */
export function weeksForRange(
  startDate: string,
  endDate: string,
  gridStart: GridStart = MASTER_GRID_START,
): number[] {
  const weeks: number[] = [];
  for (let week = 1; week <= WEEK_COUNT; week += 1) {
    if (overlapsWeek(week, startDate, endDate, gridStart)) weeks.push(week);
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
