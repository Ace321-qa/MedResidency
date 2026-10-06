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

module.exports = { normalizeAcademicYear, expandAcademicYear, academicYearMatchValues };