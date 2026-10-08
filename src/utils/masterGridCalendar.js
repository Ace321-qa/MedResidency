/**
 * The Master Rotation Grid calendar: 13 blocks × 4 weeks = 52 weekly columns,
 * starting Sunday 28/06/2026.
 *
 * This is the institutional spreadsheet format the whole feature mirrors, so the
 * rules are fixed here rather than derived from `programs.week_start_day` or
 * from whichever dates happen to be in `rotation_blocks`:
 *
 *     week W start = 28/06/2026 + (W - 1) × 7 days   (always a Sunday)
 *     week W end   = start + 6 days                   (always a Saturday)
 *     block B      = weeks (B-1)×4 + 1 … B×4
 *
 * Worked examples, stated as literals in `scripts/verify-master-grid-52w.js`
 * rather than recomputed here, which is what makes that script a test:
 *
 *     Block 1 W1  28/06/2026 – 04/07/2026
 *     Block 1 W4  19/07/2026 – 25/07/2026
 *     Block 2 W1  26/07/2026 – 01/08/2026
 *     Block 13 W4 20/06/2027 – 26/06/2027
 *
 * `mobile/src/utils/masterGridCalendar.ts` is the client mirror of this file
 * and must stay in step with it: the template the server hands out, the columns
 * the app draws and the weeks the importer writes all describe the same 52
 * windows, and a one-week drift between them puts a rotation in the wrong
 * column of the grid.
 *
 * Every function works on plain `YYYY-MM-DD` strings and does its arithmetic in
 * UTC, through `blockDates.js` — the same helpers the block editor uses, so a
 * week can never land on a Tuesday because of a timezone round-trip.
 */

const { addDays, diffDays, dayNameOf, parseCalendarDate } = require('./blockDates');

/** Sunday 28 June 2026 — week 1, block 1. */
const MASTER_GRID_START = '2026-06-28';

const BLOCK_COUNT = 13;
const WEEKS_PER_BLOCK = 4;
const WEEK_COUNT = BLOCK_COUNT * WEEKS_PER_BLOCK;

/** `28/06/2026`, the `DD/MM/YYYY` form every date cell in the workbook uses. */
function formatDmy(value) {
  const parts = parseCalendarDate(value);
  if (!parts) return '';
  const day = String(parts.day).padStart(2, '0');
  const month = String(parts.month).padStart(2, '0');
  return `${day}/${month}/${parts.year}`;
}

/** `28/06–04/07`, the compact pair a narrow column heading can hold. */
function formatShortRange(startDate, endDate) {
  const from = parseCalendarDate(startDate);
  const to = parseCalendarDate(endDate);
  if (!from || !to) return '';
  const day = (parts) => String(parts.day).padStart(2, '0');
  const month = (parts) => String(parts.month).padStart(2, '0');
  return `${day(from)}/${month(from)}–${day(to)}/${month(to)}`;
}

/**
 * One weekly subcolumn: which block it belongs to, its position inside that
 * block and its inclusive Sunday-to-Saturday window.
 *
 * @param {number} weekNumber 1..52.
 * @returns {{weekNumber:number, blockNumber:number, weekInBlock:number,
 *            start:string, end:string}|null} null outside 1..52.
 */
function weekWindow(weekNumber) {
  const week = Number(weekNumber);
  if (!Number.isInteger(week) || week < 1 || week > WEEK_COUNT) return null;

  const start = addDays(MASTER_GRID_START, (week - 1) * 7);
  if (!start) return null;

  return {
    weekNumber: week,
    blockNumber: Math.ceil(week / WEEKS_PER_BLOCK),
    weekInBlock: ((week - 1) % WEEKS_PER_BLOCK) + 1,
    start,
    end: addDays(start, 6),
  };
}

/** All 52 weeks, in column order. */
function allWeeks() {
  const weeks = [];
  for (let week = 1; week <= WEEK_COUNT; week += 1) weeks.push(weekWindow(week));
  return weeks;
}

/**
 * One block's four weekly windows.
 *
 * @param {number} blockNumber 1..13.
 * @returns {{weekNumber:number, blockNumber:number, weekInBlock:number,
 *            start:string, end:string}[]}
 */
function blockWeeks(blockNumber) {
  const block = Number(blockNumber);
  if (!Number.isInteger(block) || block < 1 || block > BLOCK_COUNT) return [];
  const first = (block - 1) * WEEKS_PER_BLOCK + 1;
  return [first, first + 1, first + 2, first + 3].map((week) => weekWindow(week));
}

/**
 * The 13 block windows: `Block 1 = 28/06/2026 – 25/07/2026`, …,
 * `Block 13 = 30/05/2027 – 26/06/2027`.
 */
function blockWindows() {
  const blocks = [];
  for (let block = 1; block <= BLOCK_COUNT; block += 1) {
    const weeks = blockWeeks(block);
    blocks.push({
      blockNumber: block,
      start: weeks[0].start,
      end: weeks[weeks.length - 1].end,
      weeks,
    });
  }
  return blocks;
}

/**
 * The 1..52 week a date falls in, or null when it lies outside the grid.
 *
 * A date that is not a Sunday still resolves — to the week whose window
 * contains it — because a coordinator may hand-edit a header to any day of the
 * week and the import should follow the column rather than refuse it.
 *
 * @param {string} value `YYYY-MM-DD`.
 * @returns {number|null}
 */
function weekNumberForDate(value) {
  const days = diffDays(MASTER_GRID_START, value);
  if (days === null || days < 0) return null;

  const week = Math.floor(days / 7) + 1;
  return week <= WEEK_COUNT ? week : null;
}

/** True when `[startDate, endDate]` shares at least one day with the week. */
function overlapsWeek(weekNumber, startDate, endDate) {
  const week = weekWindow(weekNumber);
  if (!week || !startDate || !endDate) return false;
  if (endDate < week.start || startDate > week.end) return false;
  return true;
}

/**
 * The week window clamped to `[lower, upper]`, so an assignment never records
 * dates outside the block row it hangs off.
 *
 * @returns {{start:string, end:string}|null} null when the window falls entirely
 *   outside the clamp.
 */
function clampWindow(weekWindowStart, weekWindowEnd, lower, upper) {
  const start = lower && lower > weekWindowStart ? lower : weekWindowStart;
  const end = upper && upper < weekWindowEnd ? upper : weekWindowEnd;
  if (!start || !end || start > end) return null;
  return { start, end };
}

/** Whole weeks covered by an inclusive window, to two decimals. */
function weeksSpanned(startDate, endDate) {
  const days = diffDays(startDate, endDate);
  if (days === null || days < 0) return 0;
  return Math.round(((days + 1) / 7) * 100) / 100;
}

module.exports = {
  MASTER_GRID_START,
  BLOCK_COUNT,
  WEEKS_PER_BLOCK,
  WEEK_COUNT,
  allWeeks,
  blockWeeks,
  blockWindows,
  clampWindow,
  dayNameOf,
  formatDmy,
  formatShortRange,
  overlapsWeek,
  weekNumberForDate,
  weekWindow,
  weeksSpanned,
};
