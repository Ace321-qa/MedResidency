/**
 * Academic year helpers.
 *
 * The app has always built years in the slash form ("2026/2027") because that is
 * how they are displayed, but the column stores the hyphenated form
 * ("2026-2027") and older rows were written before that was settled — both spellings
 * exist in `rotation_blocks.academic_year` today.
 *
 * Two rules follow, and they are the reason this file exists at all:
 *
 *  1. **Reads are tolerant.** Compare years through `normalizeAcademicYear`, or
 *     let the API do it: `GET /rotations/assignments/cohort?academic_year=...`
 *     matches both spellings. A client must never do a raw `===` on a year.
 *  2. **Writes are not.** Send the display form and the server stores what it is
 *     given, because the unique index on
 *     `(program_id, academic_year, block_number)` treats "2026/2027" and
 *     "2026-2027" as two different years. Rewriting stored rows to "fix" them
 *     would instead collide with the rows already there.
 */

const FULL_RANGE = /^(\d{4})\s*[-/–—]\s*(\d{2,4})$/;

/**
 * The canonical stored form: `2026-2027`.
 *
 * Accepts every spelling that reaches the client — `"2026/2027"`,
 * `"2026 - 2027"`, `"2026–2027"` (en dash), `"2026—2027"` (em dash) — because
 * these arrive from typed input, pasted spreadsheets and older call sites, and a
 * cosmetic mismatch on a read filter silently returns zero rows. Unparseable
 * input is returned trimmed and unchanged so the database rejects it rather than
 * the client widening the filter to a year nobody asked for.
 */
export function normalizeAcademicYear(year: string | null | undefined): string {
  const trimmed = (year ?? '').trim();
  if (!trimmed) return '';

  const range = trimmed.match(FULL_RANGE);
  if (range) {
    const startYear = range[1];
    const rawEnd = range[2];
    const endYear = rawEnd.length === 2 ? `${startYear.slice(0, 2)}${rawEnd}` : rawEnd;
    return `${startYear}-${endYear}`;
  }

  return trimmed;
}

/** The canonical stored form with a trailing year appended: `2026` -> `2026-2027`. */
export function expandAcademicYear(year: string | null | undefined): string {
  const normalized = normalizeAcademicYear(year);
  if (/^\d{4}$/.test(normalized)) return `${normalized}-${Number(normalized) + 1}`;
  return normalized;
}

/**
 * Every spelling a read should match for a given year.
 *
 * Sent by the client only for its own filtering; the API expands the same set
 * server-side, which is the check that actually decides what a row matches.
 */
export function academicYearMatchValues(year: string | null | undefined): string[] {
  const expanded = expandAcademicYear(year);
  if (!expanded) return [];
  if (!expanded.includes('-')) return [expanded];
  return [expanded, expanded.replace('-', '/')];
}

/** True when two years denote the same academic year, whatever their spelling. */
export function sameAcademicYear(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = expandAcademicYear(a);
  return left.length > 0 && left === expandAcademicYear(b);
}

/**
 * The start and end years as numbers, for arithmetic on a block number.
 *
 * @returns `[2026, 2027]`, or `null` when the year cannot be read.
 */
export function academicYearBounds(year: string | null | undefined): [number, number] | null {
  const match = /^(\d{4})-(\d{4})$/.exec(expandAcademicYear(year));
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** The display form: `2026/2027`. */
export function formatAcademicYear(year: string | null | undefined): string {
  const expanded = expandAcademicYear(year);
  return expanded.includes('-') ? expanded.replace('-', '/') : expanded;
}

/**
 * The academic days a resident rotates through, in week order.
 *
 * `weekday` is a `Date.getDay()` index (Sunday = 0), which is also the column
 * order for the master grid's "academic day" badges. `FMC` appears twice because
 * Foundation of Molecular Medicine runs on two days; `code` identifies the day
 * *type* and `weekday` the specific session.
 */
export type AcademicDayCode = 'PGY1' | 'PGY2' | 'PGY3' | 'FMC';

export const ACADEMIC_DAYS: readonly {
  code: AcademicDayCode;
  label: string;
  /** Display order within a week, Sunday first. */
  weekday: number;
}[] = [
  { code: 'PGY3', label: 'PGY-3', weekday: 0 },
  { code: 'PGY2', label: 'PGY-2', weekday: 1 },
  { code: 'FMC', label: 'FMC (AM)', weekday: 2 },
  { code: 'PGY1', label: 'PGY-1', weekday: 3 },
  { code: 'FMC', label: 'FMC (PM)', weekday: 4 },
] as const;

/** The academic day a PGY level or a weekday maps to, or `null` when unassigned. */
export function academicDayForPgy(pgyLevel: number | null | undefined): AcademicDayCode | null {
  switch (Number(pgyLevel)) {
    case 1:
      return 'PGY1';
    case 2:
      return 'PGY2';
    case 3:
      return 'PGY3';
    default:
      return null;
  }
}

export function getCurrentAcademicYear(monthStart: number = 7): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  if (month >= monthStart) {
    return `${year}/${year + 1}`;
  }
  return `${year - 1}/${year}`;
}

export function getAcademicYears(monthStart: number = 7, count: number = 3): string[] {
  const current = getCurrentAcademicYear(monthStart);
  const [start] = current.split('/');
  const startYear = parseInt(start, 10);
  const years: string[] = [];
  for (let i = 0; i < count; i++) {
    const y = startYear + i;
    years.push(`${y}/${y + 1}`);
  }
  return years;
}