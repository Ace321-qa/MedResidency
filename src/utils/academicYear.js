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

module.exports = { normalizeAcademicYear };