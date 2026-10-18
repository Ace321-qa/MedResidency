const db = require('../config/db');
const LongitudinalService = require('./longitudinalService');

/**
 * Supervisor allocation engine.
 *
 * Reallocates supervising faculty to residents over a rotation period (three
 * months by default, or any shorter interval). Two guarantees the caller relies
 * on:
 *
 *  - Atomicity: every reassignment in one run commits together. If any update
 *    fails the whole run rolls back, so a rotation never leaves half the slots
 *    on the old supervisor and half on the new one.
 *  - Auditability: each change writes a row to `primary_care_rotation_audit`
 *    through `LongitudinalService.recordRotationAudit`, which is best-effort and
 *    will not fail the rotation if the audit write fails.
 */
class SupervisorService {
  /**
   * Randomize or rotate supervising faculty against the existing clinic
   * supervisor assignments in `longitudinal_clinic_supervisor_assignments`.
   *
   * @param {object} options
   * @param {number} options.programId
   * @param {number} [options.clinicTypeId] Limit to one clinic type
   * @param {number} [options.rotationMonths=3] Length of the new rotation
   * @param {boolean} [options.randomize=true] Shuffle, or rotate in faculty order
   * @param {string} [options.rationale] Free-text reason stored on the audit row
   */
  static async randomizeSupervisors(options = {}) {
    const { programId, clinicTypeId, rotationMonths = 3, randomize = true, rationale = null } = options;
    if (!programId) {
      const error = new Error('programId is required');
      error.statusCode = 400;
      throw error;
    }

    const months = Number(rotationMonths) > 0 ? Number(rotationMonths) : 3;
    const reason = rationale || (randomize ? 'Randomized rotation assignment' : 'Manual rotation');

    let assignmentQuery = `
      SELECT lsa.*, CONCAT(fs.first_name, ' ', fs.last_name) AS previous_faculty_name
        FROM longitudinal_clinic_supervisor_assignments lsa
        LEFT JOIN faculty_supervisors fs ON fs.id = lsa.faculty_supervisor_id
       WHERE lsa.program_id = ? AND lsa.is_active = 1
    `;
    const params = [programId];
    if (clinicTypeId) {
      assignmentQuery += ' AND lsa.clinic_type_id = ?';
      params.push(clinicTypeId);
    }
    const [assignments] = await db.query(assignmentQuery, params);

    if (assignments.length === 0) {
      return { updated: 0, assignments: [], reason: 'no_assignments' };
    }

    const [faculty] = await db.query(
      `SELECT id, first_name, last_name, title
         FROM faculty_supervisors
        WHERE is_active = 1 AND program_id = ?
        ORDER BY id ASC`,
      [programId],
    );

    if (faculty.length === 0) {
      return { updated: 0, assignments: [], reason: 'no_active_faculty' };
    }

    const pool = randomize ? [...faculty].sort(() => Math.random() - 0.5) : [...faculty];

    const connection = await db.getConnection();
    const updates = [];
    let auditEntries = [];

    try {
      await connection.beginTransaction();

      for (let index = 0; index < assignments.length; index += 1) {
        const assignment = assignments[index];
        const chosen = pool[index % pool.length];

        // Advance the end date from the existing start when present; otherwise
        // from today, so a null start never becomes the epoch.
        const base = assignment.start_date ? new Date(assignment.start_date) : new Date();
        const newEndDate = new Date(base);
        newEndDate.setMonth(newEndDate.getMonth() + months);
        const endDate = newEndDate.toISOString().split('T')[0];

        await connection.query(
          `UPDATE longitudinal_clinic_supervisor_assignments
              SET faculty_supervisor_id = ?, end_date = ?, rotation_period_months = ?, notes = ?
            WHERE id = ?`,
          [chosen.id, endDate, months, reason, assignment.id],
        );

        auditEntries.push({
          programId,
          clinicSlotId: assignment.longitudinal_clinic_slot_id || null,
          previousFacultyName: assignment.previous_faculty_name || null,
          newFacultyId: chosen.id,
          newFacultyName: `Dr. ${chosen.first_name} ${chosen.last_name}`,
          rationale: reason,
          rotationMonths: months,
        });

        updates.push({ id: assignment.id, newFacultyId: chosen.id });
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    // Best-effort, outside the transaction so a missing audit table can never
    // undo a committed rotation.
    for (const entry of auditEntries) {
      await LongitudinalService.recordRotationAudit(entry);
    }

    return { updated: updates.length, assignments: updates };
  }

  static async getBackupFaculty(dayOfWeek, options = {}) {
    const { dailyHeaderId } = options;
    let query = 'SELECT * FROM primary_care_backup_faculty WHERE day_of_week = ?';
    const params = [dayOfWeek];
    if (dailyHeaderId) {
      query += ' AND daily_header_id = ?';
      params.push(dailyHeaderId);
    }
    query += ' ORDER BY priority_order ASC';
    const [rows] = await db.query(query, params);
    return rows;
  }

  static async setBackupFaculty(dayOfWeek, facultyList = [], options = {}) {
    const { dailyHeaderId } = options;
    if (!dailyHeaderId) {
      const error = new Error('dailyHeaderId is required');
      error.statusCode = 400;
      throw error;
    }

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      await connection.query(
        'DELETE FROM primary_care_backup_faculty WHERE daily_header_id = ? AND day_of_week = ?',
        [dailyHeaderId, dayOfWeek],
      );

      if (facultyList.length > 0) {
        const inserts = facultyList.map((entry, i) => {
          const name = typeof entry === 'string' ? entry : entry.name;
          const facultyId =
            typeof entry === 'string' ? null : entry.faculty_id ?? entry.id ?? null;
          return [dailyHeaderId, dayOfWeek, name || null, facultyId, i + 1];
        });

        await connection.query(
          `INSERT INTO primary_care_backup_faculty
             (daily_header_id, day_of_week, faculty_name, faculty_id, priority_order)
           VALUES ?`,
          [inserts],
        );
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    return SupervisorService.getBackupFaculty(dayOfWeek, { dailyHeaderId });
  }
}

module.exports = SupervisorService;
