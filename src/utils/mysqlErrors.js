/**
 * MySQL error classification helpers.
 *
 * MySQL reports a failed CHECK constraint through a different code depending on
 * the server build: 8.0.x normally raises ER_CHECK_CONSTRAINT_VIOLATED (3819),
 * but some hosted builds surface it as ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE
 * (4025) with the real cause only in `sqlMessage`
 * ("CONSTRAINT `<name>` failed for ...").
 */

/**
 * Detect a CHECK constraint violation regardless of the driver/server code mapping
 */
function isCheckConstraintViolation(error) {
  if (!error) return false;
  if (error.code === 'ER_CHECK_CONSTRAINT_VIOLATED' || error.errno === 3819) return true;
  if (error.errno === 4025 || error.code === 'ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE') return true;
  return (
    error.sqlState === '23000' &&
    typeof error.sqlMessage === 'string' &&
    /CONSTRAINT .* failed/i.test(error.sqlMessage)
  );
}

/**
 * Detect a foreign key reference failure (missing parent row)
 */
function isForeignKeyViolation(error) {
  if (!error) return false;
  return error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_NO_REFERENCED_ROW';
}

/**
 * Detect an invalid value for an ENUM column
 */
function isEnumViolation(error) {
  if (!error) return false;
  return error.code === 'ER_TRUNCATED_WRONG_VALUE' || error.errno === 1265;
}

module.exports = {
  isCheckConstraintViolation,
  isForeignKeyViolation,
  isEnumViolation,
};