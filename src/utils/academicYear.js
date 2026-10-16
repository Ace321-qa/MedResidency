/**
 * Academic year helpers.
 *
 * `rotation_blocks.academic_year` is stored hyphenated ("2026-2027"), but the
 * same year reaches the API in several shapes from clients and mobile call
 * sites: "2026/2027", "2026 - 2027", "2026–2027" or a bare "2026". Grid
 * endpoints that filter on the raw string return zero rows on what is only a
 * cosmetic mismatch, so every academic-year filter is normalised at the
 * boundary before it reaches SQL.
 */

const FULL_RANGE = /^(\d{4})\s*[-/–—]\s*(\d{2,4})$/;

/**
 * Normalise an academic year to the canonical hyphenated form used in the
 * database. A bare four-digit year ("2026") expands to the matching
 * "2026-2027" span so callers may omit the end year. Anything that cannot be
 * parsed is returned trimmed and unchanged, letting the database reject it
 * rather than silently widening the filter.
 *
 * @param {string|number|null|undefined} value
 * @returns {string|null}
 */
function normalizeAcademicYear(value) {
  if (value === undefined || value === null) return null;

  const trimmed = String(value).trim();
  if (!trimmed) return null;

  const range = trimmed.match(FULL_RANGE);
  if (range) {
    const startYear = range[1];
    const rawEnd = range[2];
    const endYear = rawEnd.length === 2 ? `${startYear.slice(0, 2)}${rawEnd}` : rawEnd;
    return `${startYear}-${endYear}`;
  }

  if (/^\d{4}$/.test(trimmed)) {
    return `${trimmed}-${Number(trimmed) + 1}`;
  }

  return trimmed;
}

/**
 * The set of literal strings a stored `academic_year` column may hold for one
 * year.
 *
 * `rotation_blocks.academic_year` is a plain `varchar`, and this database
 * contains both "2026-2027" and "2026/2027" for the *same* year — rows written
 * before the year was normalised. An equality filter therefore matches only half
 * the year depending on which half the caller happened to send, and a block can
 * appear to be missing from the grid and simultaneously be creatable again under
 * the same number.
 *
 * Read paths must match every spelling. Writes are deliberately *not*
 * rewritten: rewriting "2026/2027" to "2026-2027" on insert would bypass the
 * `(program_id, academic_year, block_number)` unique key for the slash rows and
 * let a duplicate block number through. Normalise on read, store what was asked
 * for.
 *
 * @param {string|number|null|undefined} value
 * @returns {string[]} Bind values for `column IN (?, ?, ...)`.
 */
function academicYearMatchValues(value) {
  const normalized = normalizeAcademicYear(value);
  if (!normalized) return [];

  const variants = new Set([normalized, normalized.replace('-', '/')]);
  return [...variants];
}

/**
 * Alias for `normalizeAcademicYear`, which already expands a bare year.
 *
 * The mobile mirror splits this into `normalizeAcademicYear` (spacing and
 * separators only) and `expandAcademicYear` (adding the trailing year). The
 * split exists there because the app builds years in the slash display form and
 * needed the narrower operation for display; the server never needed the
 * distinction, so `normalizeAcademicYear` does both jobs.
 *
 * The alias exists so `scripts/date-parity-cases.js` can assert one set of
 * expectations against the same function name on both sides. Without it the
 * shared fixture would have to know that two differently named functions on two
 * platforms are the same rule, which is precisely the coupling the fixture is
 * meant to remove.
 */
const expandAcademicYear = normalizeAcademicYear;

/**
 * The academic year a calendar date belongs to, e.g. `2026-07-01` -> "2026-2027".
 *
 * The programme year opens on 28 June (the mobile client's default Block 1
 * start), so a date on or after 28 June belongs to the year that begins then,
 * and anything before it belongs to the year that began the previous June. This
 * is what lets `primary_care_cycles`, which has no `academic_year` column, be
 * grouped by year without a schema change — a cycle's year falls out of its
 * `start_date`.
 *
 * @param {string|Date|null|undefined} value - A `YYYY-MM-DD` string or a Date.
 * @returns {string|null} Canonical "YYYY-YYYY", or null when unreadable.
 */
function academicYearForDate(value) {
  if (value === undefined || value === null) return null;

  let year;
  let month; // 1-12
  let day;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    year = value.getFullYear();
    month = value.getMonth() + 1;
    day = value.getDate();
  } else {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
    if (!match) return null;
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  }

  const startYear = month > 6 || (month === 6 && day >= 28) ? year : year - 1;
  return `${startYear}-${startYear + 1}`;
}

module.exports = {
  normalizeAcademicYear,
  expandAcademicYear,
  academicYearMatchValues,
  academicYearForDate,
};