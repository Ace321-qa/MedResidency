// Step 1: Import our Hostinger MySQL connection pool
const db = require('../config/db');
const { normalizeAcademicYear } = require('../utils/academicYear');

/**
 * Scalar subquery yielding one display identifier per resident.
 *
 * `resident_identifiers.is_primary` is set on every identifier row in this
 * schema, so it cannot pick a single row per resident. Joining that table
 * multiplies each resident by how many identifiers they hold, which silently
 * inflates any row-per-resident grid. A correlated subquery with an explicit
 * preference order keeps the row count exact; FIELD() returns 0 for an
 * unlisted type, so anything unexpected sorts last as a fallback.
 */
const PRIMARY_IDENTIFIER_SQL = `
  (
    SELECT ri.identifier_value
    FROM resident_identifiers ri
    WHERE ri.resident_id = r.id
    ORDER BY FIELD(ri.identifier_type, 'CORPORATE_ID', 'NATIONAL_ID', 'PASSPORT', 'LICENSE_NUMBER'), ri.id ASC
    LIMIT 1
  )`;

class RotationService {
  /**
   * Fetch all academic blocks for a specific residency program
   * @param {number} programId - e.g., 1 for Family Medicine
   */
  static async getBlocksByProgram(programId, academicYear = null) {
    let query = `
      SELECT 
        b.id AS block_id,
        b.program_id,
        p.program_code,
        p.week_start_day,
        b.academic_year,
        b.block_number,
        b.block_name,
        b.start_date,
        b.end_date,
        DAYNAME(b.start_date) AS actual_start_day
      FROM rotation_blocks b
      JOIN programs p ON p.id = b.program_id
      WHERE b.program_id = ?
    `;
    const params = [programId];
    if (academicYear) {
      query += ' AND b.academic_year = ?';
      params.push(academicYear);
    }
    query += ' ORDER BY b.academic_year DESC, b.block_number ASC;';
    const [rows] = await db.query(query, params);
    return rows;
  }

  static async createBlock(blockData) {
    const { program_id, academic_year, block_number, block_name, start_date, end_date } = blockData;
    const query = `
      INSERT INTO rotation_blocks 
        (program_id, academic_year, block_number, block_name, start_date, end_date)
      VALUES (?, ?, ?, ?, ?, ?);
    `;
    const [result] = await db.query(query, [program_id, academic_year, block_number, block_name, start_date, end_date]);
    return { block_id: result.insertId, ...blockData };
  }

  static async getRotationsByProgram(programId) {
    const query = `
      SELECT
        r.id AS rotation_id,
        r.program_id,
        r.rotation_code,
        r.rotation_name,
        r.department_name,
        r.department_id,
        r.default_duration_weeks,
        r.is_active
      FROM rotations r
      WHERE r.program_id = ? AND r.is_active = TRUE
      ORDER BY r.rotation_name ASC;
    `;
    const [rows] = await db.query(query, [programId]);
    return rows;
  }

  static async assignResidentToRotation(assignmentData) {
    const { resident_id, rotation_id, rotation_block_id, start_date, end_date, assigned_weeks, assignment_type, notes } = assignmentData;
    const query = `
      INSERT INTO resident_rotation_assignments
        (resident_id, rotation_id, rotation_block_id, start_date, end_date, assigned_weeks, assignment_type, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `;
    const [result] = await db.query(query, [
      resident_id, rotation_id, rotation_block_id, start_date, end_date,
      assigned_weeks || 4.0, assignment_type || 'FULL_BLOCK', notes || null
    ]);
    return { assignment_id: result.insertId, ...assignmentData };
  }

  static async getScheduleByResident(residentId) {
    const query = `
      SELECT
        rra.id AS assignment_id,
        CONCAT(r.first_name, ' ', r.last_name) AS resident_name,
        rb.block_name,
        rot.rotation_name,
        rot.department_name,
        rra.start_date,
        rra.end_date,
        rra.assigned_weeks,
        rra.assignment_type,
        rra.notes
      FROM resident_rotation_assignments rra
      JOIN residents r ON r.id = rra.resident_id
      JOIN rotation_blocks rb ON rb.id = rra.rotation_block_id
      JOIN rotations rot ON rot.id = rra.rotation_id
      WHERE rra.resident_id = ?
      ORDER BY rra.start_date ASC;
    `;
    const [rows] = await db.query(query, [residentId]);
    return rows;
  }

  static async getBlockById(blockId) {
    const query = `
      SELECT 
        b.id AS block_id,
        b.program_id,
        p.program_code,
        p.week_start_day,
        b.academic_year,
        b.block_number,
        b.block_name,
        b.start_date,
        b.end_date,
        b.is_active,
        DAYNAME(b.start_date) AS actual_start_day
      FROM rotation_blocks b
      JOIN programs p ON p.id = b.program_id
      WHERE b.id = ?
    `;
    const [rows] = await db.query(query, [blockId]);
    return rows[0] || null;
  }

  static async hasDependentAssignments(blockId) {
    const query = `
      SELECT COUNT(*) AS count
      FROM resident_rotation_assignments
      WHERE rotation_block_id = ?
    `;
    const [rows] = await db.query(query, [blockId]);
    return rows[0].count > 0;
  }

  static async updateBlock(blockId, blockData) {
    const { block_name, start_date, end_date, block_number, academic_year } = blockData;
    const query = `
      UPDATE rotation_blocks
      SET block_name = ?, start_date = ?, end_date = ?, block_number = ?, academic_year = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;
    const [result] = await db.query(query, [block_name, start_date, end_date, block_number, academic_year, blockId]);
    return { affectedRows: result.affectedRows };
  }

  static async deleteBlock(blockId) {
    const query = `DELETE FROM rotation_blocks WHERE id = ?`;
    const [result] = await db.query(query, [blockId]);
    return { affectedRows: result.affectedRows };
  }

  static async getAssignments(filters = {}) {
    const { program_id, academic_year, block_id, pgy_level } = filters;
    let query = `
      SELECT
        rra.id AS assignment_id,
        rra.resident_id,
        CONCAT(r.first_name, ' ', COALESCE(r.middle_initial, ''), ' ', r.last_name) AS resident_name,
        r.first_name, r.last_name, r.middle_initial,
        ri.identifier_value AS employee_id,
        '' AS phone_mobile,
        re.year_in_program AS pgy_level,
        rb.id AS block_id,
        rb.block_name,
        rb.block_number,
        rb.academic_year,
        rb.start_date AS block_start_date,
        rb.end_date AS block_end_date,
        rot.id AS rotation_id,
        rot.rotation_name,
        rot.department_name,
        rot.rotation_code,
        rra.start_date,
        rra.end_date,
        rra.assigned_weeks,
        rra.assignment_type,
        rra.notes
      FROM resident_rotation_assignments rra
      JOIN residents r ON r.id = rra.resident_id
      JOIN rotation_blocks rb ON rb.id = rra.rotation_block_id
      JOIN rotations rot ON rot.id = rra.rotation_id
      LEFT JOIN residency_enrollments re ON re.resident_id = r.id
      LEFT JOIN resident_identifiers ri ON ri.resident_id = r.id AND ri.is_primary = 1
      WHERE 1=1
    `;
    const params = [];
    if (program_id) { query += ' AND rb.program_id = ?'; params.push(program_id); }
    if (academic_year) { query += ' AND rb.academic_year = ?'; params.push(academic_year); }
    if (block_id) { query += ' AND rb.id = ?'; params.push(block_id); }
    if (pgy_level) { query += ' AND re.year_in_program = ?'; params.push(pgy_level); }
    query += ' ORDER BY rb.academic_year DESC, rb.block_number ASC, re.year_in_program ASC, r.last_name ASC';
    const [rows] = await db.query(query, params);
    return rows;
  }

  /**
   * Cohort Master Grid: one row per resident per academic block, so a
   * coordinator sees the whole cohort mapped onto the block calendar in a
   * single response.
   *
   * The grid is driven from `rotation_blocks` and LEFT JOINed to assignments so
   * every resident/block cell is present even when nothing is assigned yet --
   * that missing assignment is the signal the grid exists to surface. Residents
   * are reached through `residency_enrollments` rather than a flat residents
   * scan so PGY level and enrolment status stay per-program.
   *
   * A block may legitimately hold more than one assignment for the same
   * resident (a partial block split across two rotations), so the row grain is
   * one resident/block/assignment rather than one resident/block.
   * `assignment_count` reports how many assignments share the cell so a client
   * pivoting residents-by-blocks can tell a split block from a duplicate row.
   *
   * The employee id comes from a correlated scalar subquery rather than a join:
   * `resident_identifiers.is_primary` is set on every identifier row in this
   * schema, so joining it multiplies each resident by their number of
   * identifiers and silently inflates the grid.
   *
   * @param {object} filters
   * @param {string} filters.academic_year - Required. Accepts "2026/2027" or "2026-2027".
   * @param {number} [filters.program_id]  - Restrict to one program.
   * @param {number} [filters.pgy_level]   - Restrict to one year in program.
   * @param {string} [filters.resident_status] - Restrict to an enrolment status.
   */
  static async getCohortGrid(filters = {}) {
    const { program_id, pgy_level, resident_status } = filters;
    const academicYear = normalizeAcademicYear(filters.academic_year);

    let query = `
      SELECT
        re.resident_id,
        CONCAT(r.first_name, ' ', COALESCE(r.middle_initial, ''), ' ', r.last_name) AS resident_name,
        ${PRIMARY_IDENTIFIER_SQL} AS employee_id,
        re.year_in_program AS pgy_level,
        re.resident_status,
        rb.program_id,
        p.program_code,
        rb.id AS block_id,
        rb.block_number,
        rb.block_name,
        rb.academic_year,
        rb.start_date AS block_start_date,
        rb.end_date AS block_end_date,
        rra.id AS assignment_id,
        rra.rotation_id,
        rot.rotation_code,
        rot.rotation_name,
        rot.department_name,
        rra.start_date,
        rra.end_date,
        rra.assigned_weeks,
        rra.assignment_type,
        rra.notes,
        (rra.id IS NOT NULL) AS is_assigned,
        (
          SELECT COUNT(*)
          FROM resident_rotation_assignments cell_rra
          WHERE cell_rra.resident_id = re.resident_id
            AND cell_rra.rotation_block_id = rb.id
        ) AS assignment_count
      FROM rotation_blocks rb
      JOIN programs p ON p.id = rb.program_id
      JOIN residency_enrollments re ON re.program_id = rb.program_id
      JOIN residents r ON r.id = re.resident_id
      LEFT JOIN resident_rotation_assignments rra
        ON rra.resident_id = re.resident_id AND rra.rotation_block_id = rb.id
      LEFT JOIN rotations rot ON rot.id = rra.rotation_id
      WHERE rb.academic_year = ?
    `;
    const params = [academicYear];

    if (program_id) { query += ' AND rb.program_id = ?'; params.push(program_id); }
    if (pgy_level) { query += ' AND re.year_in_program = ?'; params.push(pgy_level); }
    if (resident_status) { query += ' AND re.resident_status = ?'; params.push(resident_status); }
    query += ' ORDER BY rb.block_number ASC, re.year_in_program ASC, r.last_name ASC, r.first_name ASC';

    const [rows] = await db.query(query, params);
    return rows;
  }

  /**
   * Resolve an academic year to the programs and calendar window that define it.
   *
   * `resident_longitudinal_assignments` carries no academic-year column, so the
   * longitudinal matrix reaches the year indirectly: rotation_blocks are the
   * only table that maps a year onto a program and a date span.
   *
   * @param {string} academicYear - Already normalised, e.g. "2026-2027".
   * @returns {Promise<Array<{program_id:number, window_start:string, window_end:string}>>}
   */
  static async getAcademicYearScopes(academicYear, programId = null) {
    let query = `
      SELECT
        program_id,
        MIN(start_date) AS window_start,
        MAX(end_date) AS window_end
      FROM rotation_blocks
      WHERE academic_year = ?
    `;
    const params = [academicYear];
    if (programId) { query += ' AND program_id = ?'; params.push(programId); }
    query += ' GROUP BY program_id ORDER BY program_id ASC';

    const [rows] = await db.query(query, params);
    return rows;
  }
}

module.exports = RotationService;
module.exports.PRIMARY_IDENTIFIER_SQL = PRIMARY_IDENTIFIER_SQL;
