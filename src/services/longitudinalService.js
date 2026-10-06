const db = require('../config/db');
const { addMonths, describeWindow } = require('../utils/blockDates');
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

  /**
   * Every longitudinal assignment in a programme, optionally scoped to a year.
   *
   * `longitudinal_assignments` carries no `academic_year` column, so a year has to
   * be resolved through the date window the assignment actually covers — the same
   * overlap test `getLongitudinalMatrix` uses, against the programme's rotation
   * blocks for that year. Omitting `academicYear` keeps the unfiltered behaviour,
   * which is what the resident's own profile needs: a resident wants their whole
   * longitudinal record, not the slice for the year currently selected.
   */
  static async getAllLongitudinalAssignments(programId, academicYear = null) {
    let query = `
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
    `;
    const params = [programId];

    if (academicYear) {
      const scopes = await RotationService.getAcademicYearScopes(academicYear, programId);
      if (scopes.length === 0) return [];

      // One scope per program; the programme is already pinned, so the first is
      // the whole window. The overlap test is deliberately permissive: an
      // assignment with open-ended dates belongs to every year it touches.
      const scope = scopes[0];
      query += ` AND (rla.start_date IS NULL OR rla.start_date <= ?)
                AND (rla.end_date IS NULL OR rla.end_date >= ?)`;
      params.push(scope.window_end, scope.window_start);
    }

    query += ' ORDER BY lct.clinic_name ASC, rla.day_of_week ASC';

    const [rows] = await db.query(query, params);
    return rows;
  }

  /**
/**
   * Faculty who can supervise a longitudinal clinic.
   *
   * The supervisor form could never offer a selection because this list came back
   * empty: `getFacultySupervisors` matched on `program_id` alone and the table
   * carries rows for every department in the hospital, most of them not supervising
   * this programme — and, before this change, departed faculty as well. It now
   * filters to active faculty registered against the programme, which is what
   * "supervising faculty" means in a supervision assignment, and reports which
   * of the programme's clinics each person already supervises so the assignment
   * screen can label an option.
   *
   * Departed faculty stay reachable with `includeInactive`, because a record of a
   * posting that has already ended must still be editable.
   *
   * @param {number} programId
   * @param {object} [options]
   * @param {boolean} [options.includeInactive=false]
   * @param {number} [options.clinicTypeId] - Also report covered clinic types.
   */
  static async getFacultySupervisors(programId, { includeInactive = false, clinicTypeId } = {}) {
    let query = `
      SELECT id, program_id, first_name, last_name, title, email, phone, is_active
      FROM faculty_supervisors
      WHERE program_id = ?
    `;
    const params = [programId];
    if (!includeInactive) {
      query += ' AND is_active = 1';
    }
    query += ' ORDER BY last_name ASC, first_name ASC';

    const [rows] = await db.query(query, params);
    if (!clinicTypeId || rows.length === 0) return rows;

    // Which clinics each of these faculty already supervise, for the option label.
    const placeholders = rows.map(() => '?').join(', ');
    const [links] = await db.query(
      `SELECT faculty_supervisor_id, clinic_type_id
       FROM longitudinal_clinic_supervisor_assignments
       WHERE clinic_type_id = ? AND faculty_supervisor_id IN (${placeholders}) AND is_active = 1`,
      [clinicTypeId, ...rows.map((row) => row.id)]
    );

    const byFaculty = new Map();
    for (const link of links) {
      const list = byFaculty.get(link.faculty_supervisor_id) ?? [];
      list.push(link.clinic_type_id);
      byFaculty.set(link.faculty_supervisor_id, list);
    }

    return rows.map((row) => ({ ...row, clinic_type_ids: byFaculty.get(row.id) ?? [] }));
  }

  static async getClinicSlots(clinicTypeId) {
    const query = `
      SELECT
        id,
        clinic_type_id,
        slot_number,
        slot_label,
        day_of_week,
        TIME_FORMAT(start_time, '%H:%i') AS start_time,
        TIME_FORMAT(end_time, '%H:%i') AS end_time,
        site_name,
        notes,
        is_active
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
        fs.is_active AS faculty_is_active,
        lsa.resident_id,
        CONCAT(r.first_name, ' ', r.last_name) AS resident_name,
        lsa.start_date,
        lsa.end_date,
        DATE_FORMAT(lsa.start_date, '%Y-%m-%d') AS start_date_iso,
        DATE_FORMAT(lsa.end_date, '%Y-%m-%d') AS end_date_iso,
        lsa.rotation_period_months,
        lsa.is_primary,
        lsa.is_active,
        lsa.notes,
        lcs.slot_number,
        lcs.slot_label,
        lcs.day_of_week AS slot_day_of_week,
        lcs.site_name AS slot_site_name
      FROM longitudinal_clinic_supervisor_assignments lsa
      JOIN faculty_supervisors fs ON fs.id = lsa.faculty_supervisor_id
      JOIN longitudinal_clinic_types lct ON lct.id = lsa.clinic_type_id
      LEFT JOIN residents r ON r.id = lsa.resident_id
      LEFT JOIN longitudinal_clinic_slots lcs ON lcs.id = lsa.longitudinal_clinic_slot_id
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

  /**
   * Create a faculty supervision assignment.
   *
   * The end date is the *evaluation* end date: a supervision posting runs for
   * `rotation_period_months` (three by default) from the start date, so the end
   * is derived rather than typed. A coordinator who sets a start date and an end
   * date that disagrees with the three-month period is asking for one of them to
   * be wrong, so an explicit mismatch is rejected with the derived date in the
   * message instead of being silently overwritten.
   */
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
      notes,
    } = data;

    const months = Number(rotation_period_months) > 0 ? Number(rotation_period_months) : 3;
    const derivedEnd = addMonths(start_date, months);

    if (!derivedEnd) {
      const error = new Error('start_date must be a real date in YYYY-MM-DD form.');
      error.statusCode = 400;
      throw error;
    }

    if (end_date && String(end_date).slice(0, 10) !== derivedEnd) {
      const error = new Error(
        `A ${months}-month supervision period starting ${String(start_date).slice(0, 10)} ends on ${derivedEnd}, not ${String(end_date).slice(0, 10)}.`
      );
      error.statusCode = 400;
      throw error;
    }

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
      String(start_date).slice(0, 10),
      derivedEnd,
      is_primary !== undefined ? (is_primary ? 1 : 0) : 1,
      months,
      notes || null,
    ]);

    return {
      id: result.insertId,
      ...data,
      start_date: String(start_date).slice(0, 10),
      end_date: derivedEnd,
      rotation_period_months: months,
      period_label: `${months} month${months === 1 ? '' : 's'} · ${describeWindow(String(start_date).slice(0, 10), derivedEnd)}`,
    };
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
    // `getAcademicYearScopes` matches both the hyphenated and slash spellings of
    // the year, so it is handed whatever the caller sent.
    const academicYear = filters.academic_year;
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
