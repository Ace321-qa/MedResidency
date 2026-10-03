const db = require('../config/db');

class AttendanceService {
  /**
   * Log daily attendance and automatically evaluate duty hour compliance.
   * Wrapped in an ACID transaction so the attendance log and its duty hour
   * violation audit record are committed or rolled back together.
   */
  static async logAttendance(logData) {
    const {
      resident_id,
      assignment_id,
      shift_date,
      clock_in,
      clock_out,
      total_hours,
      attendance_status,
      other_leave_specify,
      notes
    } = logData;

    // Obtain a dedicated connection from pool for transaction isolation
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // 1. Fetch active compliance rules sorted by most recent active enrollment
      const rulesQuery = `
        SELECT dhr.* 
        FROM duty_hour_rules dhr
        JOIN residency_enrollments re ON re.program_id = dhr.program_id
        WHERE re.resident_id = ? 
          AND re.resident_status = 'ACTIVE_FULL_TIME'
          AND dhr.is_active = 1
        ORDER BY re.created_at DESC
        LIMIT 1;
      `;
      const [rules] = await connection.query(rulesQuery, [resident_id]);
      const activeRule = rules[0];

      // Evaluate continuous shift cap (24.0h limit + 4.0h transition limit)
      let isBreached = false;
      let breachReason = null;

      if (total_hours && activeRule) {
        const maxAllowed = parseFloat(activeRule.max_continuous_shift_hours) + parseFloat(activeRule.max_transition_extension_hours);
        if (parseFloat(total_hours) > maxAllowed) {
          isBreached = true;
          breachReason = `Shift duration of ${total_hours} hours exceeds maximum allowed continuous limit of ${maxAllowed} hours (${activeRule.max_continuous_shift_hours}h shift + ${activeRule.max_transition_extension_hours}h transition extension).`;
        }
      }

      // 2. Insert attendance log
      const insertLogQuery = `
        INSERT INTO resident_attendance_logs 
          (resident_id, assignment_id, shift_date, clock_in, clock_out, total_hours, attendance_status, other_leave_specify, is_flagged_for_breach, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `;

      const [logResult] = await connection.query(insertLogQuery, [
        resident_id,
        assignment_id || null,
        shift_date,
        clock_in || null,
        clock_out || null,
        total_hours || null,
        attendance_status || 'PRESENT',
        other_leave_specify || null,
        isBreached,
        notes || null
      ]);

      const logId = logResult.insertId;

      // 3. Insert audit violation record atomically if breached
      if (isBreached) {
        const violationQuery = `
          INSERT INTO duty_hour_violations 
            (resident_id, attendance_log_id, rule_type, severity, violation_details)
          VALUES (?, ?, 'CONTINUOUS_SHIFT_EXCEEDED', 'CRITICAL_VIOLATION', ?);
        `;
        await connection.query(violationQuery, [resident_id, logId, breachReason]);
      }

      // Commit both operations together
      await connection.commit();

      return {
        log_id: logId,
        resident_id,
        shift_date,
        total_hours,
        attendance_status,
        is_flagged_for_breach: isBreached,
        breach_details: breachReason,
        rule_evaluated: activeRule ? activeRule.rule_set_name : 'NO_ACTIVE_RULE_FOUND'
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Fetch attendance logs with violation details for a resident
   */
  static async getAttendanceByResident(residentId) {
    const query = `
      SELECT 
        al.id AS log_id,
        CONCAT(r.first_name, ' ', r.last_name) AS resident_name,
        al.shift_date,
        al.clock_in,
        al.clock_out,
        al.total_hours,
        al.attendance_status,
        al.other_leave_specify,
        al.is_flagged_for_breach,
        dhv.rule_type AS violation_rule,
        dhv.severity AS violation_severity,
        dhv.violation_details
      FROM resident_attendance_logs al
      JOIN residents r ON r.id = al.resident_id
      LEFT JOIN duty_hour_violations dhv ON dhv.attendance_log_id = al.id
      WHERE al.resident_id = ?
      ORDER BY al.shift_date DESC;
    `;
    const [rows] = await db.query(query, [residentId]);
    return rows;
  }
}

module.exports = AttendanceService;
