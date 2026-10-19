/**
 * How a free-text rotation name or abbreviation is turned into a match key.
 *
 * Two callers turn the same human text into the same rotation — the Master Grid
 * import (`rotationImportController`) and the approval of a resident's rotation
 * request — so the rule lives here once. If the two drifted, a workbook that
 * says "Internal Medicine" and a request typed the same way could resolve to two
 * different `rotations` rows, and the grid would show two columns of one thing.
 */

/**
 * The exact key: lower-cased, with punctuation collapsed to single spaces, so
 * `Medicine Inpatient`, `medicine  inpatient` and `MEDICINE-INPATIENT` are all
 * one rotation.
 *
 * @param {unknown} value
 * @returns {string}
 */
function rotationMatchKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The looser key behind the contains-fallback: no spaces either, so
 * `PHC Clinic` and `PHCCLINIC` line up. Only used after the exact key has
 * missed.
 *
 * @param {unknown} value
 * @returns {string}
 */
function rotationLooseKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

module.exports = { rotationMatchKey, rotationLooseKey };
