const db = require('../config/db');

class SupervisorService {
  /**
   * Randomize or rotate supervising faculty to residents within a 3-month cycle
   * (or shorter customized periods).
   * @param {object} options
   * @param {number} options.programId
   * @param {number} [options.clinicTypeId]
   * @param {number} [options.rotationMonths=3]
   * @param {boolean} [options.randomize=true]
   * @param {string} [options.rationale]
   */
  static async randomizeSupervisors(options = {}) {
    const { programId, clinicTypeId, rotationMonths = 3, randomize = true, rationale = null } = options;
    if (!programId) {
      const error = new Error('programId is required');
      error.statusCode = 400;
      throw error;
    }

    // Fetch current supervisor assignments
    let query = `
      SELECT lsa.*
      FROM longitudinal_clinic_supervisor_assignments lsa
      WHERE lsa.program_id = ? AND lsa.is_active = 1
    `;
    const params = [programId];
    if (clinicTypeId) {
      query += ' AND lsa.clinic_type_id = ?';
      params.push(clinicTypeId);
    }
    const [assignments] = await db.query(query, params);

    if (assignments.length === 0) {
      return { updated: 0, assignments: [] };
    }

    // Fetch available faculty
    const [faculty] = await db.query(
      'SELECT id, first_name, last_name, title FROM faculty_supervisors WHERE is_active = 1 AND program_id = ?',
      [programId]
    );

    if (faculty.length === 0) {
      return { updated: 0, assignments: [] };
    }

    // Simple randomization - shuffle faculty
    const shuffled = [...faculty].sort(() => Math.random() - 0.5);

    const updates = [];
    let idx = 0;
    for (let i = 0; i < assignments.length; i++) {
      const assignment = assignments[i];
      const chosen = shuffled[idx % shuffled.length];
      idx++;

      const newEndDate = new Date(assignment.start_date);
      newEndDate.setMonth(newEndDate.getMonth() + Number(rotationMonths || 3));

      await db.query(
        `UPDATE longitudinal_clinic_supervisor_assignments
         SET faculty_supervisor_id = ?, end_date = ?, rotation_period_months = ?, notes = ?
         WHERE id = ?`,
        [
          chosen.id,
          newEndDate.toISOString().split('T')[0],
          Number(rotationMonths || 3),
          rationale || (randomize ? 'Randomized rotation assignment' : 'Manual rotation'),
          assignment.id,
        ]
      );
      updates.push({ id: assignment.id, newFacultyId: chosen.id });
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

    await db.query('DELETE FROM primary_care_backup_faculty WHERE daily_header_id = ? AND day_of_week = ?', [
      dailyHeaderId,
      dayOfWeek,
    ]);

    const inserts = [];
    for (let i = 0; i < facultyList.length; i++) {
      const f = facultyList[i];
      inserts.push([dailyHeaderId, dayOfWeek, f.faculty_name || null, f.faculty_id || null, i + 1]);
    }
    if (inserts.length > 0) {
      await db.query(
        'INSERT INTO primary_care_backup_faculty (daily_header_id, day_of_week, faculty_name, faculty_id, priority_order) VALUES ?',
        [inserts]
      );
    }
    return this.getBackupFaculty(dayOfWeek, { dailyHeaderId });
  }
}

module.exports = SupervisorService;
