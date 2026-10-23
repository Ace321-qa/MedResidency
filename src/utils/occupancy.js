/**
 * Weekly occupancy validation for rotation assignments.
 *
 * ## Why a rotation does not simply "have a capacity"
 *
 * A departmental seat limit is a statement about *weeks*, not about postings. If
 * Internal Medicine can supervise three residents at a time, that is three
 * residents in any one week — and a multi-week posting is a run of weeks, each of
 * which has to be counted on its own.
 *
 * The naive implementation rejects any two assignments whose date ranges overlap,
 * which is wrong twice over. It rejects two residents on *adjacent* four-week
 * blocks whose ranges abut but share no week, and it rejects a resident placed on
 * weeks 1–2 of a block while another occupies weeks 3–4 — a perfectly ordinary
 * hand-over. Both are the same mistake: treating the posting as the unit of
 * capacity instead of the week.
 *
 * So the engine reduces every assignment to the set of *programme weeks* it
 * touches, counts how many residents sit in each, and reports the worst week.
 *
 * ## The tiers
 *
 * Against a capacity of 3, with `over` meaning "how many residents above the
 * limit in the worst week" and `sustained` meaning "for how many consecutive
 * weeks":
 *
 * | Status    | Condition                                        |
 * |-----------|--------------------------------------------------|
 * | `GREEN`   | never above capacity                             |
 * | `AMBER`   | 1 over, for a single week                        |
 * | `REVIEW`  | 1 over, sustained for two weeks                  |
 * | `RED`     | 1 over for three or more weeks, or 2+ over in any week |
 * | `BLOCKED` | the limit is locked and would be exceeded        |
 *
 * `REVIEW` is deliberately its own tier rather than a shade of amber: one week
 * over is a scheduling accident, two weeks over is a pattern that needs someone
 * to look at it, and collapsing them would make the difference invisible.
 *
 * ## Locked limits
 *
 * A locked limit is a departmental hard stop — a ward with three funded posts
 * does not become a four-post ward because a coordinator typed a reason. Locking
 * therefore bypasses the exception path entirely and returns `BLOCKED`, which no
 * amount of rationale can clear.
 *
 * ## Purity
 *
 * Everything here is a pure function over plain data. The server calls it to
 * decide whether a write may proceed; the app calls it to render the same banner
 * before the write is attempted. Two implementations would eventually disagree,
 * and the one the user sees would be the one that is wrong.
 */

/**
 * A week of the programme calendar, identified by the date its week begins.
 *
 * Weeks are keyed by their start date rather than by an index: an index depends
 * on where the grid happens to start, whereas `2026-10-18` means the same week
 * to the server, to the app, and to two screens looking at different years.
 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Parse `YYYY-MM-DD` as a UTC midnight instant, or `null`. */
function parseDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(`${value.trim()}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `YYYY-MM-DD` for a UTC-midnight instant. */
function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`, or `null` if either is unreadable. */
function diffDays(a, b) {
  const from = parseDate(a);
  const to = parseDate(b);
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * The start date of the week containing `date`, aligned to `weekStartDay`.
 *
 * A week is a whole number of days from the programme's own week-start weekday,
 * not from Sunday: a Monday-starting programme that anchors weeks on Sunday
 * would split every week in two and double-count the occupancy.
 *
 * @param {string} date - `YYYY-MM-DD`
 * @param {string|number} [weekStartDay] - 0=Sunday … 6=Saturday, or a day name.
 * @returns {string|null} `YYYY-MM-DD` of the week's first day.
 */
function weekStartOf(date, weekStartDay = 0) {
  const parsed = parseDate(date);
  if (!parsed) return null;
  const target = normalizeWeekday(weekStartDay);
  const current = parsed.getUTCDay();
  // How many days back the week's first day sits. Adding 7 before the modulo
  // keeps the arithmetic positive for a week that started earlier in the week.
  const back = (current - target + 7) % 7;
  return isoDate(new Date(parsed.getTime() - back * 24 * 60 * 60 * 1000));
}

/**
 * Every week a window touches, as week-start dates, ascending.
 *
 * The window is inclusive at both ends, so a single-day window still yields one
 * week. Two adjacent four-week blocks therefore share no week — the second
 * begins the day after the first ends, which is a different week — while an
 * overlapping pair shares exactly the weeks they overlap.
 *
 * @returns {string[]} week-start dates; empty when the window is unreadable or
 *   inverted.
 */
function weeksForWindow(startDate, endDate, weekStartDay = 0) {
  const start = weekStartOf(startDate, weekStartDay);
  const end = weekStartOf(endDate, weekStartDay);
  if (!start || !end) return [];
  const from = parseDate(start).getTime();
  const to = parseDate(end).getTime();
  if (to < from) return [];

  const weeks = [];
  for (let at = from; at <= to; at += WEEK_MS) weeks.push(isoDate(new Date(at)));
  return weeks;
}

/** Day-name and numeric weekdays, reduced to 0=Sunday … 6=Saturday. */
const WEEKDAY_NAMES = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
];

function normalizeWeekday(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number' && value >= 0 && value <= 6) return Math.floor(value);
  const text = String(value).trim().toUpperCase();
  if (text === '') return 0;
  const exact = WEEKDAY_NAMES.indexOf(text);
  if (exact >= 0) return exact;
  const short = WEEKDAY_NAMES.findIndex((day) => day.startsWith(text));
  return short >= 0 ? short : 0;
}

/** The tier names, ordered from least to most severe. */
const OCCUPANCY_STATUSES = ['GREEN', 'AMBER', 'REVIEW', 'RED', 'BLOCKED'];

/** How much worse `a` is than `b`. */
function statusRank(status) {
  return OCCUPANCY_STATUSES.indexOf(status);
}

/** The worse of two statuses. */
function worstStatus(a, b) {
  return statusRank(b) > statusRank(a) ? b : a;
}

/**
 * Classify a worst-week occupancy against a capacity.
 *
 * Pulled out of `evaluateOccupancy` so the tier table is readable in one place
 * and directly testable, rather than buried in the loop that finds the peak.
 *
 * @param {number} peak - residents in the busiest week (including the proposal).
 * @param {number} capacity - the seat limit, `null`/`0` meaning unlimited.
 * @param {number} sustainedWeeks - how many weeks sit at `peak`.
 * @param {boolean} locked - true when the limit is a hard departmental stop.
 * @returns {'GREEN'|'AMBER'|'REVIEW'|'RED'|'BLOCKED'}
 */
function classifyOccupancy(peak, capacity, sustainedWeeks, locked = false) {
  if (!isFiniteCapacity(capacity)) return 'GREEN';
  const over = peak - capacity;
  if (over <= 0) return 'GREEN';

  // A locked limit is the one condition no rationale clears, so it is decided
  // before the over/amber/red arithmetic rather than as another branch of it.
  if (locked) return 'BLOCKED';

  // Two or more above the limit is never "a little over" — a capacity of three
  // does not become five by accident — so it escalates immediately whatever the
  // duration.
  if (over >= 2) return 'RED';
  if (sustainedWeeks <= 1) return 'AMBER';
  if (sustainedWeeks === 2) return 'REVIEW';
  return 'RED';
}

/** A capacity of `null`, `undefined`, `0` or a non-number means unlimited. */
function isFiniteCapacity(capacity) {
  const value = Number(capacity);
  return Number.isFinite(value) && value > 0;
}

/**
 * True when `[rowStart, rowEnd]` shares at least one day with `window`.
 *
 * Both sides must be readable `YYYY-MM-DD` dates: an unreadable pair is treated
 * as *not* overlapping, which is the same thing the week loop below does with
 * it (an unreadable window contributes no weeks, and so no residents). Keeping
 * the two decisions in one place stops a row being counted by the window test
 * while contributing nothing to the weeks — or the reverse.
 */
function overlapsWindow(rowStart, rowEnd, window) {
  const from = parseDate(rowStart);
  const to = parseDate(rowEnd);
  const start = parseDate(window?.start_date);
  const end = parseDate(window?.end_date);
  if (!from || !to || !start || !end) return false;
  return from.getTime() <= end.getTime() && to.getTime() >= start.getTime();
}

/**
 * Read an optional block window, or `null`.
 *
 * Accepts `{start_date, end_date}` (the shape the service and the API speak) or
 * `{start, end}`; anything unreadable becomes `null`, which means "no block
 * known" and leaves the engine exactly as it behaved before blocks were part of
 * the contract. A caller that cannot name a block must not be punished for it —
 * the proposal's own window still bounds the decision.
 */
function normalizeBlockWindow(block) {
  if (!block || typeof block !== 'object') return null;
  const start = block.start_date ?? block.start ?? null;
  const end = block.end_date ?? block.end ?? null;
  if (!parseDate(start) || !parseDate(end)) return null;
  if (parseDate(end).getTime() < parseDate(start).getTime()) return null;
  return { start_date: isoDate(parseDate(start)), end_date: isoDate(parseDate(end)) };
}

/**
 * Evaluate a proposed assignment's weekly occupancy against a rotation's limit.
 *
 * @param {object} input
 * @param {Array<{start_date:string, end_date:string}>} [input.existing] - every
 *   assignment already standing in the same rotation, across the whole
 *   programme. Windows outside the proposal's range are harmless: they only
 *   contribute to weeks the proposal touches.
 * @param {{start_date:string, end_date:string}} input.proposal - the window being
 *   placed.
 * @param {number|null} [input.capacity] - the rotation's `max_capacity`.
 * @param {boolean} [input.locked] - the department has locked the limit.
 * @param {string|number} [input.week_start_day] - programme week start.
 * @param {number} [input.excludeAssignmentId] - an assignment being moved or
 *   re-saved, so it is not counted against itself.
 * @param {number|string} [input.residentId] - the resident being placed. Used
 *   instead of `proposal.resident_id` when both are present.
 * @param {{start_date:string, end_date:string}} [input.block_window] - the block
 *   being placed into, when the caller knows it. Supplying it tightens the count
 *   in two ways: an existing assignment whose window does not overlap the block
 *   at all is dropped before counting (a Block 5 posting cannot make a Block 6
 *   week look full), and only the block's own weeks are evaluated rather than
 *   every week the proposal happens to touch. Omitting it — or passing anything
 *   unreadable — leaves the engine exactly as it was: the proposal's own window
 *   bounds the decision.
 * @param {Map<string, number>} [input.existingById] - id → count, for the above.
 * @returns {{
 *   status: string,
 *   capacity: number|null,
 *   locked: boolean,
 *   allowed: boolean,
 *   requires_exception: boolean,
 *   peak: number,
 *   peak_weeks: string[],
 *   over_by: number,
 *   sustained_weeks: number,
 *   weeks: Array<{week_start:string, week_end:string, count:number, over_by:number}>,
 *   worst_week: {week_start:string, week_end:string, count:number}|null,
 *   message: string,
 * }}
 */
function evaluateOccupancy(input = {}) {
  const {
    existing = [],
    proposal,
    capacity = null,
    locked = false,
    week_start_day = 0,
    excludeAssignmentId = null,
    // The person being placed. A caller that knows who the proposal belongs to
    // passes it here; otherwise it is read off the proposal. Naming the resident
    // matters when they already hold a row in this rotation — without it their
    // own existing row would be counted as a second, different person.
    residentId = null,
    // The block being placed into, when the caller knows it. See the doc above:
    // an unreadable block falls back to "no block known" and the engine counts
    // exactly what it counted before blocks were part of the contract.
    block_window = null,
  } = input;
  const blockWindow = normalizeBlockWindow(block_window);

  const proposalWeeks = weeksForWindow(
    proposal?.start_date,
    proposal?.end_date,
    week_start_day,
  ).filter((weekStart) => {
    // With a block in hand, only the block's own weeks are judged. A proposal
    // drawn a few days long on either side of the block — the picker's window
    // is derived from grid columns and can run past the stored dates by a day
    // or two — must not turn a neighbouring block's week into the deciding one.
    if (!blockWindow) return true;
    return overlapsWindow(weekStart, weekStart, blockWindow);
  });

  if (proposalWeeks.length === 0) {
    return {
      status: 'GREEN',
      capacity: isFiniteCapacity(capacity) ? Number(capacity) : null,
      locked: locked === true,
      allowed: true,
      requires_exception: false,
      peak: 0,
      peak_weeks: [],
      over_by: 0,
      sustained_weeks: 0,
      weeks: [],
      worst_week: null,
      message: 'The dates could not be read, so no occupancy could be worked out.',
    };
  }

  // Count residents per week. Each week holds a *set* of resident ids rather
  // than a running total, because the unit of capacity is the person, not the
  // row. A resident can legitimately hold more than one assignment row in the
  // same rotation and window — a split block saved twice, a re-save, imported
  // data — and counting rows would report a department of two as a department
  // of five, producing an overcapacity warning against people who do not
  // exist. The set makes duplicates free and keeps the count a headcount.
  //
  // The proposal is seeded with its own resident (or a placeholder when no id
  // is supplied, which is the case for a pure "what would happen if" preview)
  // so a proposal into an empty rotation is occupancy 1, not 0.
  const proposalResidentId =
    (residentId ?? proposal?.resident_id) !== undefined &&
    (residentId ?? proposal?.resident_id) !== null
      ? `r:${residentId ?? proposal.resident_id}`
      : null;
  const counts = new Map();
  for (const week of proposalWeeks) {
    counts.set(week, new Set([proposalResidentId ?? `__proposal__`]));
  }

  for (const assignment of existing) {
    if (
      excludeAssignmentId !== null &&
      assignment?.assignment_id !== undefined &&
      Number(assignment.assignment_id) === Number(excludeAssignmentId)
    ) {
      continue;
    }
    // With a block in hand, a row that does not overlap the block at all belongs
    // to a different block and cannot fill this one's weeks. This is what stops
    // a resident sitting in Block 5 from making Block 6 look full — the week
    // sets below would not overlap anyway when the dates are clean, but grid
    // windows and stored blocks can be a few days out of step, so the test is
    // made explicit rather than left to the arithmetic.
    if (blockWindow && !overlapsWindow(assignment?.start_date, assignment?.end_date, blockWindow)) {
      continue;
    }
    const weeks = weeksForWindow(
      assignment?.start_date,
      assignment?.end_date,
      week_start_day,
    );
    // Identify the person this row belongs to. When the caller supplies no
    // resident id the row's own assignment id is used, so an older caller that
    // has not been taught about residents still counts each row once instead of
    // silently collapsing every row into a single anonymous one.
    const key =
      assignment?.resident_id !== undefined && assignment?.resident_id !== null
        ? `r:${assignment.resident_id}`
        : `a:${assignment?.assignment_id ?? weeks[0] ?? 'unknown'}`;
    for (const week of weeks) {
      // Only weeks the proposal touches can affect the decision, and limiting
      // the map to those keeps a whole-programme scan proportional to the
      // proposal's own length rather than the roster's.
      const set = counts.get(week);
      if (set) set.add(key);
    }
  }

  // When the caller named the resident being placed, their membership is what
  // makes the proposal count: the set already holds them, so a proposal into an
  // empty rotation reads 1 and a re-save of an existing posting does not add a
  // second. When no resident was named the seed was a bare placeholder, which is
  // not a person, so it is subtracted here rather than counted.
  const weeks = proposalWeeks.map((weekStart) => {
    const set = counts.get(weekStart) ?? new Set();
    const count = Math.max(0, proposalResidentId === null ? set.size - 1 : set.size);
    return {
      week_start: weekStart,
      week_end: isoDate(new Date(parseDate(weekStart).getTime() + 6 * 24 * 60 * 60 * 1000)),
      count,
      over_by: isFiniteCapacity(capacity) ? Math.max(0, count - Number(capacity)) : 0,
    };
  });

  const peak = weeks.reduce((highest, week) => Math.max(highest, week.count), 0);
  const peakWeeks = weeks.filter((week) => week.count === peak);
  const sustainedWeeks = peakWeeks.length;
  const status = classifyOccupancy(peak, capacity, sustainedWeeks, locked);

  return {
    status,
    capacity: isFiniteCapacity(capacity) ? Number(capacity) : null,
    locked: locked === true,
    // A locked limit is not excusable, so `BLOCKED` is the one non-green status
    // that does *not* open the exception path — deriving this as
    // `status !== 'GREEN'` would offer the coordinator a rationale field that
    // the server then refuses.
    allowed: status !== 'BLOCKED',
    requires_exception: status === 'AMBER' || status === 'REVIEW' || status === 'RED',
    peak,
    peak_weeks: peakWeeks.map((week) => week.week_start),
    over_by: isFiniteCapacity(capacity) ? Math.max(0, peak - Number(capacity)) : 0,
    sustained_weeks: sustainedWeeks,
    weeks,
    worst_week: peakWeeks[0] ?? null,
    message: describeOccupancy(status, peak, capacity, sustainedWeeks, peakWeeks),
  };
}

/** Plain-language summary of a result, shared by the banner and the audit row. */
function describeOccupancy(status, peak, capacity, sustainedWeeks, peakWeeks = []) {
  if (!isFiniteCapacity(capacity)) {
    return `${peak} resident${peak === 1 ? '' : 's'} in the busiest week — this rotation has no seat limit.`;
  }
  const cap = Number(capacity);
  if (status === 'GREEN') {
    return `Within capacity: ${peak} of ${cap} seats in the busiest week.`;
  }
  const over = peak - cap;
  const span = sustainedWeeks === 1 ? '1 week' : `${sustainedWeeks} weeks`;
  const where = peakWeeks
    .slice(0, 2)
    .map((week) => `from ${week.week_start}`)
    .join(', ');
  const base = `Exceeds capacity by ${over} resident${over === 1 ? '' : 's'} for ${span}${where ? ` (${where})` : ''} — ${peak} residents against a limit of ${cap}.`;

  switch (status) {
    case 'AMBER':
      return `${base} Temporary overcapacity: allowed with a logged rationale.`;
    case 'REVIEW':
      return `${base} Sustained overcapacity: this needs review before it becomes routine.`;
    case 'RED':
      return `${base} Significant overcapacity: requires an explicit programme-lead override.`;
    case 'BLOCKED':
      return `${base} This department has locked its seat limit, so the placement cannot be made.`;
    default:
      return base;
  }
}

module.exports = {
  OCCUPANCY_STATUSES,
  WEEKDAY_NAMES,
  classifyOccupancy,
  describeOccupancy,
  diffDays,
  evaluateOccupancy,
  isFiniteCapacity,
  normalizeWeekday,
  statusRank,
  weekStartOf,
  weeksForWindow,
  worstStatus,
};
