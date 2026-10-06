// Step 1: Import our Hostinger MySQL connection pool
const db = require('../config/db');
const { academicYearMatchValues } = require('../utils/academicYear');
const {
  describeWindow,
  diffDays,
  resolveBlockWindow,
  weekEndDay,
} = require('../utils/blockDates');

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

/**
 * Scalar subquery yielding one contact number per resident, or NULL.
 *
 * The cohort master grid has a Mobile / Contact row for every resident, but
 * `residents` carries no phone column and `resident_identifiers` is typed for
 * identity documents. Rather than hardcode an empty string the way
 * `getAssignments` does, the grid reads whichever identifier is actually a
 * contact and renders "not recorded" when none is — a false blank is
 * indistinguishable from a missing one, whereas NULL says the schema has nothing
 * to show.
 */
const CONTACT_IDENTIFIER_SQL = `
  (
    SELECT ri.identifier_value
    FROM resident_identifiers ri
    WHERE ri.resident_id = r.id
      AND UPPER(ri.identifier_type) IN ('MOBILE', 'MOBILE_NUMBER', 'PHONE', 'CONTACT', 'CONTACT_NUMBER')
    ORDER BY ri.is_primary DESC, ri.id ASC
    LIMIT 1
  )`;

class RotationService {
  /**
   * Fetch all academic blocks for a specific residency program
   *
   * `academicYear` arrives in whichever shape a client used, so it is normalised
   * before it reaches SQL: the column holds "2026-2027" but callers also send
   * "2026/2027", and a literal comparison against the un-normalised value returns
   * zero rows for a year that plainly has blocks.
   *
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
        DATE_FORMAT(b.start_date, '%Y-%m-%d') AS start_date_iso,
        DATE_FORMAT(b.end_date, '%Y-%m-%d') AS end_date_iso,
        DAYNAME(b.start_date) AS actual_start_day,
        DAYNAME(b.end_date) AS actual_end_day,
        DATEDIFF(b.end_date, b.start_date) + 1 AS block_days,
        (DATEDIFF(b.end_date, b.start_date) + 1) DIV 7 AS block_weeks
      FROM rotation_blocks b
      JOIN programs p ON p.id = b.program_id
      WHERE b.program_id = ?
    `;
    const params = [programId];
    const yearValues = academicYearMatchValues(academicYear);
    if (yearValues.length > 0) {
      query += ` AND b.academic_year IN (${yearValues.map(() => '?').join(', ')})`;
      params.push(...yearValues);
    }
    query += ' ORDER BY b.academic_year DESC, b.block_number ASC;';
    const [rows] = await db.query(query, params);
    return rows;
  }

  /**
   * The week-start day and default block length a programme runs on.
   *
   * `programs.week_start_day` is what makes a block end on a Saturday (or a
   * Sunday) rather than on the same weekday it started, so every block write
   * reads it before deriving a date.
   *
   * @returns {Promise<{program_id:number, week_start_day:string|null,
   *   default_block_duration_weeks:number|null}|null>}
   */
  static async getBlockCalendarRules(programId) {
    const query = `
      SELECT id AS program_id, week_start_day, default_block_duration_weeks
      FROM programs
      WHERE id = ?
    `;
    const [rows] = await db.query(query, [programId]);
    return rows[0] || null;
  }

  /**
   * Derive a block window from a start date and a duration, using the programme's
   * week-start day.
   *
   * Exposed as its own endpoint so a client never has to re-implement the
   * `weeks * 7 - 1` arithmetic: the forms call this and the API calls it again
   * on write, so what a coordinator sees in the calendar is exactly what gets
   * stored.
   *
   * @param {object} input
   * @param {number} input.programId
   * @param {string} input.startDate - `YYYY-MM-DD`.
   * @param {number} [input.durationWeeks] - Defaults to the programme's own
   *   `default_block_duration_weeks` (4 in practice).
   * @param {string} [input.endDate] - Cross-checked against the derived window.
   */
  static async resolveBlockDates({ programId, startDate, durationWeeks, endDate }) {
    const rules = await this.getBlockCalendarRules(programId);
    const hasDuration = durationWeeks !== undefined && durationWeeks !== null && durationWeeks !== '';
    const hasEnd = Boolean(endDate);

    // The programme default is only a *default*. An explicit end date means the
    // caller has already decided the length, so it must not then be rejected for
    // disagreeing with a four-week default — that is what made a legitimate
    // one-, two- or three-week block impossible to create.
    const weeks = hasDuration ? Number(durationWeeks) : hasEnd ? null : Number(rules?.default_block_duration_weeks) || 4;

    const window = resolveBlockWindow({
      start_date: startDate,
      end_date: endDate,
      duration_weeks: weeks,
      week_start_day: rules?.week_start_day,
    });

    return {
      ...window,
      week_start_day: rules?.week_start_day ?? null,
      default_block_duration_weeks: Number(rules?.default_block_duration_weeks) || null,
      window_label: window.start_date && window.end_date ? describeWindow(window.start_date, window.end_date) : null,
    };
  }

  /** The calendar rules alone, for a form that needs them before choosing a date. */
  static async getBlockCalendar(programId) {
    const rules = await this.getBlockCalendarRules(programId);
    if (!rules) return null;
    return {
      program_id: rules.program_id,
      week_start_day: rules.week_start_day ?? null,
      week_end_day: rules.week_start_day ? weekEndDay(rules.week_start_day) : null,
      default_block_duration_weeks: Number(rules.default_block_duration_weeks) || null,
    };
  }

  static async createBlock(blockData) {
    const { program_id, academic_year, block_number, block_name } = blockData;

    // Re-derive the window server-side. The client computes the same arithmetic,
    // but the stored dates are whatever this function decides, so a hand-edited
    // request cannot slip a block across a week boundary.
    const window = await this.resolveBlockDates({
      programId: program_id,
      startDate: blockData.start_date,
      durationWeeks: blockData.duration_weeks,
      endDate: blockData.end_date,
    });

    if (window.errors.length > 0) {
      const error = new Error(window.errors.join(' '));
      error.statusCode = 400;
      throw error;
    }

    const query = `
      INSERT INTO rotation_blocks 
        (program_id, academic_year, block_number, block_name, start_date, end_date)
      VALUES (?, ?, ?, ?, ?, ?);
    `;
    const [result] = await db.query(query, [
      program_id,
      String(academic_year ?? '').trim(),
      block_number,
      block_name,
      window.start_date,
      window.end_date,
    ]);

    return {
      block_id: result.insertId,
      ...blockData,
      start_date: window.start_date,
      end_date: window.end_date,
      duration_weeks: window.duration_weeks,
    };
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

  /**
   * Place a resident in a rotation inside a block.
   *
   * `assigned_weeks` used to be hardcoded to `4.0` whenever the caller omitted
   * it, so a one-week clinic slot was stored as a four-week posting and every
   * duty-hour and progress calculation built on it was wrong. The duration is
   * now derived from the dates actually stored, and an explicit
   * `assigned_weeks` is still honoured for deliberately fractional postings.
   */
  static async assignResidentToRotation(assignmentData) {
    const {
      resident_id,
      rotation_id,
      rotation_block_id,
      start_date,
      end_date,
      assigned_weeks,
      assignment_type,
      notes,
    } = assignmentData;

    const days = diffDays(start_date, end_date);
    const derivedWeeks = days === null ? null : Math.round(((days + 1) / 7) * 100) / 100;

    // The window must sit inside the block it claims to belong to. Without this
    // the assignment is accepted and the cohort master grid — which draws columns
    // from the *block's* dates — silently renders a rotation in a block it does
    // not belong to. Half-block rotations stay legal; only an out-of-block window
    // is rejected.
    const block = await this.getBlockById(rotation_block_id);
    if (block) {
      const blockStart = block.start_date_iso;
      const blockEnd = block.end_date_iso;
      if (blockStart && blockEnd) {
        if (start_date < blockStart || end_date > blockEnd) {
          const error = new Error(
            `Assignment dates ${start_date} to ${end_date} fall outside ${block.block_name} ` +
              `(${blockStart} to ${blockEnd}).`,
          );
          error.statusCode = 400;
          throw error;
        }
      }
    }

    const query = `
      INSERT INTO resident_rotation_assignments
        (resident_id, rotation_id, rotation_block_id, start_date, end_date, assigned_weeks, assignment_type, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `;
    const [result] = await db.query(query, [
      resident_id,
      rotation_id,
      rotation_block_id,
      start_date,
      end_date,
      Number(assigned_weeks) > 0 ? Number(assigned_weeks) : derivedWeeks ?? 4.0,
      assignment_type || 'FULL_BLOCK',
      notes || null,
    ]);
    return {
      assignment_id: result.insertId,
      ...assignmentData,
      assigned_weeks: Number(assigned_weeks) > 0 ? Number(assigned_weeks) : derivedWeeks,
    };
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
        DATE_FORMAT(b.start_date, '%Y-%m-%d') AS start_date_iso,
        DATE_FORMAT(b.end_date, '%Y-%m-%d') AS end_date_iso,
        DAYNAME(b.start_date) AS actual_start_day,
        DAYNAME(b.end_date) AS actual_end_day,
        DATEDIFF(b.end_date, b.start_date) + 1 AS block_days,
        (DATEDIFF(b.end_date, b.start_date) + 1) DIV 7 AS block_weeks
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

  /**
   * Update a block, re-deriving its window from the programme's week-start day.
   *
   * An edit is as capable of breaking the Saturday/Sunday boundary as a create
   * is, so the same `weeks * 7 - 1` arithmetic runs here; `duration_weeks` may
   * be passed to resize the block rather than typing an end date by hand.
   */
  static async updateBlock(blockId, blockData) {
    const { block_name, block_number, academic_year } = blockData;
    const existing = await this.getBlockById(blockId);

    const window = await this.resolveBlockDates({
      programId: existing?.program_id ?? blockData.program_id,
      startDate: blockData.start_date ?? existing?.start_date_iso,
      durationWeeks: blockData.duration_weeks,
      endDate: blockData.end_date,
    });

    if (window.errors.length > 0) {
      const error = new Error(window.errors.join(' '));
      error.statusCode = 400;
      throw error;
    }

    const query = `
      UPDATE rotation_blocks
      SET block_name = ?, start_date = ?, end_date = ?, block_number = ?, academic_year = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;
    const [result] = await db.query(query, [
      block_name ?? existing?.block_name,
      window.start_date,
      window.end_date,
      block_number ?? existing?.block_number,
      academic_year ?? existing?.academic_year,
      blockId,
    ]);
    return { affectedRows: result.affectedRows, start_date: window.start_date, end_date: window.end_date };
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
   * `contact_number` is looked up the same way, preferring a contact-type
   * identifier. This schema's `residents` table has no phone column and
   * `resident_identifiers` currently holds only CORPORATE_ID, NATIONAL_ID,
   * PASSPORT and LICENSE_NUMBER, so the column is null today; it is selected
   * rather than hardcoded as `''` so a mobile number recorded later appears in
   * the grid without another migration of the query.
   *
   * Block dates are also returned DATE_FORMAT'd: mysql2 materialises a DATE
   * column at the server's local midnight, so the raw value is a UTC instant
   * whose local calendar day is the truth and whose `.slice(0, 10)` is a day
   * early for anyone west of the server's offset.
   *
   * @param {object} filters
   * @param {string} filters.academic_year - Required. Accepts "2026/2027" or "2026-2027".
   * @param {number} [filters.program_id]  - Restrict to one program.
   * @param {number} [filters.pgy_level]   - Restrict to one year in program.
   * @param {string} [filters.resident_status] - Restrict to an enrolment status.
   */
  static async getCohortGrid(filters = {}) {
    const { program_id, pgy_level, resident_status } = filters;
    const yearValues = academicYearMatchValues(filters.academic_year);

    let query = `
      SELECT
        re.resident_id,
        CONCAT(r.first_name, ' ', COALESCE(r.middle_initial, ''), ' ', r.last_name) AS resident_name,
        r.first_name,
        r.last_name,
        ${PRIMARY_IDENTIFIER_SQL} AS employee_id,
        ${CONTACT_IDENTIFIER_SQL} AS contact_number,
        re.year_in_program AS pgy_level,
        re.resident_status,
        rb.program_id,
        p.program_code,
        p.week_start_day,
        rb.id AS block_id,
        rb.block_number,
        rb.block_name,
        rb.academic_year,
        rb.start_date AS block_start_date,
        rb.end_date AS block_end_date,
        DATE_FORMAT(rb.start_date, '%Y-%m-%d') AS block_start_date_iso,
        DATE_FORMAT(rb.end_date, '%Y-%m-%d') AS block_end_date_iso,
        DAYNAME(rb.start_date) AS block_start_day,
        DAYNAME(rb.end_date) AS block_end_day,
        DATEDIFF(rb.end_date, rb.start_date) + 1 AS block_days,
        rra.id AS assignment_id,
        rra.rotation_id,
        rot.rotation_code,
        rot.rotation_name,
        rot.department_name,
        rra.start_date,
        rra.end_date,
        DATE_FORMAT(rra.start_date, '%Y-%m-%d') AS assignment_start_date_iso,
        DATE_FORMAT(rra.end_date, '%Y-%m-%d') AS assignment_end_date_iso,
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
      WHERE rb.academic_year IN (${yearValues.map(() => '?').join(', ')})
    `;
    const params = [...yearValues];

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
   * @param {string} academicYear - "2026/2027" or "2026-2027"; both are matched.
   * @param {number} [programId]
   * @returns {Promise<Array<{program_id:number, window_start:string, window_end:string}>>}
   */
  static async getAcademicYearScopes(academicYear, programId = null) {
    const yearValues = academicYearMatchValues(academicYear);

    let query = `
      SELECT
        program_id,
        MIN(start_date) AS window_start,
        MAX(end_date) AS window_end
      FROM rotation_blocks
      WHERE academic_year IN (${yearValues.map(() => '?').join(', ')})
    `;
    const params = [...yearValues];
    if (programId) { query += ' AND program_id = ?'; params.push(programId); }
    query += ' GROUP BY program_id ORDER BY program_id ASC';

    const [rows] = await db.query(query, params);
    return rows;
  }
}

module.exports = RotationService;
module.exports.PRIMARY_IDENTIFIER_SQL = PRIMARY_IDENTIFIER_SQL;
