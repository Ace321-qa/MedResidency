const db = require('../config/db');
const { normalizeAcademicYear } = require('../utils/academicYear');
const RotationService = require('./rotationService');
const { PRIMARY_IDENTIFIER_SQL } = RotationService;

class LongitudinalService {
  static async getClinicTypes(programId) {
    const query = `
      SELECT id, program_id, clinic_code, clinic_name, default_day_of_week, start_time, end_time, requires_release_letter, is_active
      FROM longitudinal_clinic_types
      WHERE program_id = ?
      ORDER BY clinic_name ASC
    `;
    const [rows] = await db.query(query, [programId]);
    return rows;
  }

  static async getResidentLongitudinalAssignments(residentId) {
    const query = `
      SELECT
        rla.id AS longitudinal_assignment_id,
        rla.resident_id,
        rla.clinic_type_id,
        lct.clinic_code,
        lct.clinic_name,
        rla.site_name,
        rla.supervisor_name,
        rla.faculty_supervisor_id,
        rla.day_of_week,
        rla.start_time,
        rla.end_time,
        rla.start_date,
        rla.end_date,
        rla.is_active,
        rla.requires_release_letter,
        rla.release_letter_generated,
        rla.notes
      FROM resident_longitudinal_assignments rla
      JOIN longitudinal_clinic_types lct ON lct.id = rla.clinic_type_id
      WHERE rla.resident_id = ?
      ORDER BY rla.start_date ASC
    `;
    const [rows] = await db.query(query, [residentId]);
    return rows;
  }

  static async getAllLongitudinalAssignments(programId) {
    const query = `
      SELECT
        rla.id AS longitudinal_assignment_id,
        rla.resident_id,
        CONCAT(r.first_name, ' ', r.last_name) AS resident_name,
        rla.clinic_type_id,
        lct.clinic_code,
        lct.clinic_name,
        rla.site_name,
        rla.supervisor_name,
        rla.faculty_supervisor_id,
        rla.day_of_week,
        rla.start_time,
        rla.end_time,
        rla.start_date,
        rla.end_date,
        rla.is_active,
        re.year_in_program AS pgy_level
      FROM resident_longitudinal_assignments rla
      JOIN longitudinal_clinic_types lct ON lct.id = rla.clinic_type_id
      JOIN residents r ON r.id = rla.resident_id
      LEFT JOIN residency_enrollments re ON re.resident_id = r.id
      WHERE lct.program_id = ?
      ORDER BY lct.clinic_name ASC, rla.day_of_week ASC
    `;
    const [rows] = await db.query(query, [programId]);
    return rows;
  }

  static async getFacultySupervisors(programId) {
    const query = `
      SELECT id, program_id, first_name, last_name, title, email, phone, is_active
      FROM faculty_supervisors
      WHERE program_id = ?
      ORDER BY last_name ASC, first_name ASC
    `;
    const [rows] = await db.query(query, [programId]);
    return rows;
  }

  static async getClinicSlots(clinicTypeId) {
    const query = `
      SELECT id, clinic_type_id, slot_number, slot_label, day_of_week, start_time, end_time, site_name, notes, is_active
      FROM longitudinal_clinic_slots
      WHERE clinic_type_id = ?
      ORDER BY slot_number ASC
    `;
    const [rows] = await db.query(query, [clinicTypeId]);
    return rows;
  }

  static async getSupervisorAssignments(programId, clinicTypeId = null) {
    let query = `
      SELECT
        lsa.id,
        lsa.program_id,
        lsa.clinic_type_id,
        lct.clinic_code,
        lct.clinic_name,
        lsa.longitudinal_assignment_id,
        lsa.longitudinal_clinic_slot_id,
        lsa.faculty_supervisor_id,
        CONCAT(fs.first_name, ' ', fs.last_name) AS faculty_supervisor_name,
        fs.title AS faculty_title,
        lsa.resident_id,
        CONCAT(r.first_name, ' ', r.last_name) AS resident_name,
        lsa.start_date,
        lsa.end_date,
        lsa.rotation_period_months,
        lsa.is_primary,
        lsa.is_active,
        lsa.notes
      FROM longitudinal_clinic_supervisor_assignments lsa
      JOIN faculty_supervisors fs ON fs.id = lsa.faculty_supervisor_id
      JOIN longitudinal_clinic_types lct ON lct.id = lsa.clinic_type_id
      LEFT JOIN residents r ON r.id = lsa.resident_id
      WHERE lsa.program_id = ?
    `;
    const params = [programId];
    if (clinicTypeId) {
      query += ' AND lsa.clinic_type_id = ?';
      params.push(clinicTypeId);
    }
    query += ' ORDER BY lsa.start_date DESC';
    const [rows] = await db.query(query, params);
    return rows;
  }

  static async createSupervisorAssignment(data) {
    const {
      program_id,
      clinic_type_id,
      longitudinal_assignment_id,
      longitudinal_clinic_slot_id,
      faculty_supervisor_id,
      resident_id,
      start_date,
      end_date,
      is_primary,
      rotation_period_months,
      notes
    } = data;
    const query = `
      INSERT INTO longitudinal_clinic_supervisor_assignments
        (program_id, clinic_type_id, longitudinal_assignment_id, longitudinal_clinic_slot_id, faculty_supervisor_id, resident_id,
         start_date, end_date, is_primary, rotation_period_months, notes, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `;
    const [result] = await db.query(query, [
      program_id,
      clinic_type_id,
      longitudinal_assignment_id || null,
      longitudinal_clinic_slot_id || null,
      faculty_supervisor_id,
      resident_id || null,
      start_date,
      end_date,
      is_primary !== undefined ? (is_primary ? 1 : 0) : 1,
      rotation_period_months || 3,
      notes || null
    ]);
    return { id: result.insertId, ...data };
  }

  static async rotateSupervisor(assignmentId, newSupervisorId, newStartDate, newEndDate, notes) {
    const query = `
      UPDATE longitudinal_clinic_supervisor_assignments
      SET faculty_supervisor_id = ?, start_date = ?, end_date = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;
    const [result] = await db.query(query, [newSupervisorId, newStartDate, newEndDate, notes || null, assignmentId]);
    return { affectedRows: result.affectedRows };
  }

  /**
   * Longitudinal Matrix: one row per resident per longitudinal clinic type.
   *
   * Longitudials run the whole year rather than sitting inside a rotation
   * block, so the academic year is resolved through rotation_blocks to get the
   * program(s) and the calendar window (see
   * RotationService.getAcademicYearScopes). An assignment counts as covering
   * that year when it overlaps the window -- which includes it, rather than
   * being fully contained by it, because a clinic running the full academic
   * year extends past both ends of the block calendar.
   *
   * LEFT JOINs keep unassigned cells visible, so the matrix doubles as the
   * clinic coverage report the coordinator needs to spot gaps.
   *
   * Row grain is one resident/clinic/assignment; `assignment_count` reports how
   * many assignments share that cell.
   *
   * @param {object} filters
   * @param {string} filters.academic_year - Required. Accepts "2026/2027" or "2026-2027".
   * @param {number} [filters.program_id]
   * @param {number} [filters.pgy_level]
   * @param {string} [filters.resident_status]
   */
  static async getLongitudinalMatrix(filters = {}) {
    const { pgy_level, resident_status } = filters;
    const academicYear = normalizeAcademicYear(filters.academic_year);
    const programId = filters.program_id || null;

    const scopes = await RotationService.getAcademicYearScopes(academicYear, programId);
    if (scopes.length === 0) return [];

    const placeholders = scopes.map(() => '?').join(', ');
    const windowConditions = scopes
      .map(
        () =>
          `(
            (rla.start_date IS NULL OR rla.start_date <= ?) AND
            (rla.end_date IS NULL OR rla.end_date >= ?)
          )`
      )
      .join(' OR ');

    // Placeholders bind in SQL text order: the window conditions live in the
    // LEFT JOIN ON clause, which is emitted before the WHERE clause.
    const windowParams = [];
    for (const scope of scopes) {
      windowParams.push(scope.window_end, scope.window_start);
    }
    const params = [...windowParams, ...scopes.map((scope) => scope.program_id)];

    let query = `
      SELECT
        re.resident_id,
        CONCAT(r.first_name, ' ', COALESCE(r.middle_initial, ''), ' ', r.last_name) AS resident_name,
        ${PRIMARY_IDENTIFIER_SQL} AS employee_id,
        re.year_in_program AS pgy_level,
        re.resident_status,
        re.program_id,
        p.program_code,
        lct.id AS clinic_type_id,
        lct.clinic_code,
        lct.clinic_name,
        lct.default_day_of_week,
        lct.start_time AS default_start_time,
        lct.end_time AS default_end_time,
        lct.requires_release_letter,
        lct.is_active AS clinic_type_is_active,
        rla.id AS longitudinal_assignment_id,
        rla.site_name,
        rla.site_id,
        rla.day_of_week,
        rla.start_time,
        rla.end_time,
        rla.start_date,
        rla.end_date,
        rla.faculty_supervisor_id,
        CONCAT(fs.first_name, ' ', fs.last_name) AS faculty_supervisor_name,
        rla.supervisor_name,
        rla.is_active,
        rla.requires_release_letter AS assignment_requires_release_letter,
        rla.release_letter_generated,
        rla.notes,
        (rla.id IS NOT NULL) AS is_assigned,
        (
          SELECT COUNT(*)
          FROM resident_longitudinal_assignments cell_rla
          WHERE cell_rla.resident_id = re.resident_id
            AND cell_rla.clinic_type_id = lct.id
        ) AS assignment_count
      FROM longitudinal_clinic_types lct
      JOIN programs p ON p.id = lct.program_id
      JOIN residency_enrollments re ON re.program_id = lct.program_id
      JOIN residents r ON r.id = re.resident_id
      LEFT JOIN resident_longitudinal_assignments rla
        ON rla.resident_id = re.resident_id
       AND rla.clinic_type_id = lct.id
       AND (${windowConditions})
      LEFT JOIN faculty_supervisors fs ON fs.id = rla.faculty_supervisor_id
      WHERE lct.program_id IN (${placeholders})
    `;

    if (pgy_level) { query += ' AND re.year_in_program = ?'; params.push(pgy_level); }
    if (resident_status) { query += ' AND re.resident_status = ?'; params.push(resident_status); }
    query +=
      ' ORDER BY re.year_in_program ASC, r.last_name ASC, r.first_name ASC, lct.clinic_name ASC';

    const [rows] = await db.query(query, params);
    return rows;
  }
}

module.exports = LongitudinalService;
