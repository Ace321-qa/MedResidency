const db = require('../config/db');

/**
 * `rotations.target_program_id` — the registered programme account a rotation
 * is *hosted by*, added so a rotation is no longer pinned to a free-text
 * department name with no identity behind it.
 *
 * The two programme columns on a rotation answer different questions:
 *
 * - `program_id` (existing) — who *created* the rotation and can assign to it.
 *   A Family Medicine catalogue owns "Internal Medicine Inpatient Wards"
 *   because Family Medicine schedules its residents onto it.
 * - `target_program_id` (this column) — whose department actually *hosts* it.
 *   The same ward rotation targeted at Internal Medicine is what makes the
 *   Internal Medicine coordinator's grid, letters inbox and visiting roster
 *   recognise the rotation as theirs.
 *
 * There is no migration runner in this project, so the column is added the
 * same idempotent way every other late column is: ask `information_schema`,
 * and only then `ALTER`. Callers span three services (catalogue, cohort grid,
 * notice dispatch), which is why the check lives in one shared module rather
 * than being triplicated — a duplicate-column race between two boots is
 * swallowed as success, since the losing boot's goal is the same schema.
 *
 * No foreign key to `programs` on purpose: a programme row is soft-deleted
 * (`is_active = 0`) or hard-removed on a schedule this table must not block,
 * and a dangling target id simply resolves to "no named host" everywhere it
 * is read.
 */
let ready = false;

async function ensureTargetProgramColumn() {
  if (ready) return;

  const [rows] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rotations' AND COLUMN_NAME = 'target_program_id'`,
  );

  if (rows.length === 0) {
    try {
      await db.query('ALTER TABLE rotations ADD COLUMN target_program_id BIGINT UNSIGNED NULL AFTER program_id');
    } catch (error) {
      // Another boot added it first: duplicate-column errno 1060 / 42S21.
      if (error.errno !== 1060 && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_DUP_FIELD') {
        throw error;
      }
    }
    try {
      await db.query('ALTER TABLE rotations ADD INDEX idx_rotations_target_program (target_program_id)');
    } catch (error) {
      if (error.code !== 'ER_DUP_KEYNAME') throw error;
    }
  }

  ready = true;
}

module.exports = { ensureTargetProgramColumn };
