/**
 * Cases both date implementations must agree on.
 *
 * `src/utils/blockDates.js` and `mobile/src/utils/dateCalc.ts` are written
 * separately — one CommonJS, one TypeScript — because the mobile app cannot import
 * from the API's tree. That duplication is unavoidable, and it is also the reason
 * two *independent* unit suites are not enough: each one can pass while the two
 * implementations disagree, and the disagreement only shows up as a rejected
 * write in production.
 *
 * So this file is the shared fixture. `scripts/verify-block-dates.js` and
 * `mobile/scripts/verify-date-calc.ts` both load it and assert the same expected
 * outputs. A change to one side that alters an answer here fails the other side's
 * suite, which is the point.
 *
 * Only pure functions belong here, and only cases whose expected value is not in
 * dispute — inclusive week arithmetic, month-end clamping, leap days, weekday
 * derivation. Anything whose "correct" answer depends on a policy choice belongs in
 * one suite only, where the reasoning can be written out.
 */

/** @typedef {{ fn: string, args: unknown[], expected: unknown }} Case */

/** @type {Case[]} */
const BLOCK_WINDOW_CASES = [
  // The rule the whole app is built on: a block ends the day *before* it restarts.
  { fn: 'endDateForDuration', args: ['2026-07-05', 4], expected: '2026-08-01' },
  { fn: 'endDateForDuration', args: ['2026-07-05', 1], expected: '2026-07-11' },
  { fn: 'endDateForDuration', args: ['2026-07-05', 13], expected: '2026-10-03' },
  // Sunday-start programmes end Saturday; the arithmetic is what makes the two
  // agree, not the label.
  { fn: 'endDateForDuration', args: ['2026-07-05', 2], expected: '2026-07-18' },
  { fn: 'endDateForDuration', args: ['2026-07-06', 2], expected: '2026-07-19' },

  // Leaps. 29 Feb + 1 year must clamp to 28 Feb, and the leap day must not shift
  // the weekday of the derived end date.
  { fn: 'endDateForDuration', args: ['2024-02-25', 4], expected: '2024-03-23' },
  { fn: 'addMonths', args: ['2024-02-29', 12], expected: '2025-02-28' },
  { fn: 'addMonths', args: ['2024-02-29', 1], expected: '2024-03-29' },
  { fn: 'addMonths', args: ['2024-01-31', 1], expected: '2024-02-29' },

  // Month-end clamping, in both directions.
  { fn: 'addMonths', args: ['2026-08-31', 3], expected: '2026-11-30' },
  { fn: 'addMonths', args: ['2026-01-31', 3], expected: '2026-04-30' },
  { fn: 'addMonths', args: ['2026-11-15', 3], expected: '2027-02-15' },
  { fn: 'addMonths', args: ['2026-08-01', 3], expected: '2026-11-01' },
  { fn: 'addMonths', args: ['2026-12-15', 3], expected: '2027-03-15' },
  // A 3-month posting crossing new year, the common case for a July start.
  { fn: 'addMonths', args: ['2026-07-01', 6], expected: '2027-01-01' },

  // Week-start normalisation: both spellings and both index conventions.
  { fn: 'normalizeWeekStartDay', args: ['sunday'], expected: 'Sunday' },
  { fn: 'normalizeWeekStartDay', args: ['MONDAY'], expected: 'Monday' },
  { fn: 'normalizeWeekStartDay', args: ['sun'], expected: 'Sunday' },
  { fn: 'normalizeWeekStartDay', args: [0], expected: 'Sunday' },
  { fn: 'normalizeWeekStartDay', args: [1], expected: 'Monday' },

  // The naive `weeks * 7` offset this replaced, one day late.
  { fn: 'addDays', args: ['2026-07-05', 28], expected: '2026-08-02' },
  { fn: 'diffDays', args: ['2026-07-05', '2026-08-01'], expected: 27 },
  { fn: 'diffDays', args: ['2026-08-01', '2026-07-05'], expected: -27 },
  { fn: 'diffDays', args: ['2026-07-05', '2026-07-05'], expected: 0 },

  // Weekday derivation for the week-end label. Both programmes, both boundaries.
  { fn: 'weekEndDay', args: ['SUNDAY'], expected: 'Saturday' },
  { fn: 'weekEndDay', args: ['MONDAY'], expected: 'Sunday' },

  // Academic-year spellings, which the database stores inconsistently.
  { fn: 'normalizeAcademicYear', args: ['2026/2027'], expected: '2026-2027' },
  { fn: 'expandAcademicYear', args: ['2026'], expected: '2026-2027' },
  { fn: 'normalizeAcademicYear', args: ['2026-2027'], expected: '2026-2027' },
  { fn: 'normalizeAcademicYear', args: ['2026 - 2027'], expected: '2026-2027' },
  // Two-digit trailing years are ambiguous by hand and must stay consistent.
  { fn: 'normalizeAcademicYear', args: ['2026/27'], expected: '2026-2027' },
  // Junk passes through so the database rejects it, rather than the client
  // silently widening the filter to a year nobody asked for.
  { fn: 'normalizeAcademicYear', args: ['whenever'], expected: 'whenever' },
];

/**
 * `resolveBlockWindow` cases, kept separate because they assert on the whole
 * result object rather than one value.
 *
 * Each entry names a case and the errors it must produce. `errors` is the contract
 * the forms surface verbatim, so a change to the message text is a change to what
 * a coordinator reads and has to be made in both files deliberately.
 *
 * @type {{ name: string, input: Record<string, unknown>, errorCount: number, start?: string, end?: string }[]}
 */
const BLOCK_WINDOW_VALIDATION_CASES = [
  {
    name: 'a four-week Sunday-start window is valid',
    input: { start_date: '2026-07-05', duration_weeks: 4, week_start_day: 'SUNDAY' },
    errorCount: 0,
    start: '2026-07-05',
    end: '2026-08-01',
  },
  {
    name: 'a four-week Monday-start window is valid',
    input: { start_date: '2026-07-06', duration_weeks: 4, week_start_day: 'MONDAY' },
    errorCount: 0,
    start: '2026-07-06',
    end: '2026-08-02',
  },
  {
    name: 'a Sunday start is rejected by a Monday-start programme',
    input: { start_date: '2026-07-05', duration_weeks: 4, week_start_day: 'MONDAY' },
    errorCount: 1,
  },
  {
    name: 'an end date one day past the duration is rejected',
    // 2026-07-05 + 4 weeks is 2026-08-01; 08-02 is the naive `weeks * 7` answer.
    input: { start_date: '2026-07-05', end_date: '2026-08-02', week_start_day: 'SUNDAY' },
    errorCount: 1,
  },
  {
    name: 'an end date before the start is rejected',
    input: { start_date: '2026-07-05', end_date: '2026-07-01' },
    errorCount: 1,
  },
  {
    name: 'a fractional week count is rejected',
    input: { start_date: '2026-07-05', duration_weeks: 2.5 },
    errorCount: 1,
  },
];

module.exports = {
  BLOCK_WINDOW_CASES,
  BLOCK_WINDOW_VALIDATION_CASES,
};
