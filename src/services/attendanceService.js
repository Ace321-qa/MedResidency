const db = require('../config/db');
const {
  normalizeClockTime,
  decimalHoursBetween,
  resolveOvernightEnd,
  formatMinuteDateTime,
  continuousDutyChains,
  addDays,
} = require('../utils/dutyTime');

/** Shared SELECT list for the continuous-duty scan: clock stamps as wall-clock strings. */
const CHAIN_SCAN_SELECT = `
  SELECT
    id AS log_id,
    shift_date,
    DATE_FORMAT(clock_in, '%Y-%m-%d %H:%i:%s') AS clock_in,
    DATE_FORMAT(clock_out, '%Y-%m-%d %H:%i:%s') AS clock_out,
    total_hours,
    attendance_status
  FROM resident_attendance_logs
  WHERE resident_id = ?
    AND clock_in IS NOT NULL
    AND clock_out IS NOT NULL
    AND shift_date BETWEEN ? AND ?
  ORDER BY clock_in;
`;

class AttendanceService {
  /**
   * Fetch the most recent active compliance rule for a resident's programme.
   * Runs on the caller's transaction connection so it sees the same snapshot.
   */
  static async _activeRule(connection, residentId) {
    const [rules] = await connection.query(
      `SELECT dhr.*
         FROM duty_hour_rules dhr
         JOIN residency_enrollments re ON re.program_id = dhr.program_id
        WHERE re.resident_id = ?
          AND re.resident_status = 'ACTIVE_FULL_TIME'
          AND dhr.is_active = 1
        ORDER BY re.created_at DESC
        LIMIT 1;`,
      [residentId],
    );
    return rules[0] ?? null;
  }

  /** `max_continuous_shift_hours + max_transition_extension_hours`, or null. */
  static _continuousCap(activeRule) {
    if (!activeRule) return null;
    return (
      parseFloat(activeRule.max_continuous_shift_hours) +
      parseFloat(activeRule.max_transition_extension_hours)
    );
  }

  /**
   * Log daily attendance and automatically evaluate duty hour compliance.
   * Wrapped in an ACID transaction so the attendance log and its duty hour
   * violation audit record are committed or rolled back together.
   *
   * Clock times are normalised to the minute before anything else happens:
   * `07:00:00` and `07:00` both become `07:00:00`, so the stored row, the API
   * response and the resident's screen never disagree by a second, and a
   * duration is never accidentally 7h59m because of clock skew. `24:00` is the
   * end of a shift day and normalises to the next midnight.
   */
  static async logAttendance(logData) {
    const {
      resident_id,
      assignment_id,
      shift_date,
      total_hours,
      attendance_status,
      other_leave_specify,
      notes,
    } = logData;

    // Accepts `YYYY-MM-DD HH:MM`, `YYYY-MM-DD HH:MM:SS`, ISO with `T`, or a
    // bare `HH:MM` paired with the shift date. Seconds are discarded.
    const clockIn = normalizeClockTime(logData.clock_in, shift_date);
    const rawClockOut = normalizeClockTime(logData.clock_out, shift_date);

    // An end earlier than the start is an overnight shift: roll it to the next
    // day so the stored span is ordered (the table checks clock_out >= clock_in)
    // and the derived duration is the real one. Single-day rows should split
    // before they reach here instead.
    const clockOut = resolveOvernightEnd(clockIn, rawClockOut);

    // Prefer a duration the caller supplied; otherwise derive it from the
    // two stamps at minute precision. Either way the value stored is the one
    // the breach check was run against.
    const suppliedHours =
      total_hours === null || total_hours === undefined || total_hours === ''
        ? null
        : Number(total_hours);
    const derivedHours = decimalHoursBetween(clockIn, clockOut);
    const effectiveHours =
      suppliedHours !== null && Number.isFinite(suppliedHours) ? suppliedHours : derivedHours;

    // Obtain a dedicated connection from pool for transaction isolation
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // 1. Fetch active compliance rules sorted by most recent active enrollment
      const activeRule = await AttendanceService._activeRule(connection, resident_id);

      // Evaluate continuous shift cap (24.0h limit + 4.0h transition limit)
      let isBreached = false;
      let breachReason = null;

      if (effectiveHours !== null && activeRule) {
        const maxAllowed = AttendanceService._continuousCap(activeRule);
        if (effectiveHours > maxAllowed) {
          isBreached = true;
          breachReason = `Shift duration of ${effectiveHours} hours exceeds maximum allowed continuous limit of ${maxAllowed} hours (${activeRule.max_continuous_shift_hours}h shift + ${activeRule.max_transition_extension_hours}h transition extension).`;
        }
      }

      // 2. Insert attendance log
      const [logResult] = await connection.query(
        `INSERT INTO resident_attendance_logs
           (resident_id, assignment_id, shift_date, clock_in, clock_out, total_hours, attendance_status, other_leave_specify, is_flagged_for_breach, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          resident_id,
          assignment_id || null,
          shift_date,
          clockIn,
          clockOut,
          effectiveHours,
          attendance_status || 'PRESENT',
          other_leave_specify || null,
          isBreached,
          notes || null,
        ],
      );

      const logId = logResult.insertId;

      // 3. Insert audit violation record atomically if breached
      if (isBreached) {
        await connection.query(
          `INSERT INTO duty_hour_violations
             (resident_id, attendance_log_id, rule_type, severity, violation_details)
           VALUES (?, ?, 'CONTINUOUS_SHIFT_EXCEEDED', 'CRITICAL_VIOLATION', ?);`,
          [resident_id, logId, breachReason],
        );
      }

      // Commit both operations together
      await connection.commit();

      return {
        log_id: logId,
        resident_id,
        shift_date,
        clock_in: formatMinuteDateTime(clockIn),
        clock_out: formatMinuteDateTime(clockOut),
        total_hours: effectiveHours,
        attendance_status,
        is_flagged_for_breach: isBreached,
        breach_details: breachReason,
        rule_evaluated: activeRule ? activeRule.rule_set_name : 'NO_ACTIVE_RULE_FOUND',
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Log a whole timesheet (one row per calendar day) in one transaction, then
   * evaluate **continuous duty across consecutive rows**.
   *
   * A 24-hour call is two rows — `08:00 → 24:00` and the next day's `00:00 →
   * 08:00` — so no single row can breach the continuous-duty cap. The rows are
   * therefore re-read as a wall-clock sequence and grouped into chains: any
   * chain whose elapsed time exceeds `max_continuous_shift_hours +
   * max_transition_extension_hours` is flagged, every row in it marked, and one
   * `duty_hour_violations` record written against the chain's first day.
   *
   * @param {{resident_id: number, rows: object[]}} input
   */
  static async logTimesheetBatch({ resident_id, rows }) {
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      const activeRule = await AttendanceService._activeRule(connection, resident_id);
      const cap = AttendanceService._continuousCap(activeRule);

      const inserted = [];
      for (const row of rows) {
        const clockIn = normalizeClockTime(row.clock_in, row.shift_date);
        const rawClockOut = normalizeClockTime(row.clock_out, row.shift_date);
        const clockOut = resolveOvernightEnd(clockIn, rawClockOut);

        const suppliedHours =
          row.total_hours === null || row.total_hours === undefined || row.total_hours === ''
            ? null
            : Number(row.total_hours);
        const derivedHours = decimalHoursBetween(clockIn, clockOut);
        const effectiveHours =
          suppliedHours !== null && Number.isFinite(suppliedHours) ? suppliedHours : derivedHours;

        const [result] = await connection.query(
          `INSERT INTO resident_attendance_logs
             (resident_id, assignment_id, shift_date, clock_in, clock_out, total_hours, attendance_status, other_leave_specify, is_flagged_for_breach, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?);`,
          [
            resident_id,
            row.assignment_id || null,
            row.shift_date,
            clockIn,
            clockOut,
            effectiveHours,
            row.attendance_status || 'PRESENT',
            row.other_leave_specify || null,
            row.notes || null,
          ],
        );

        inserted.push({
          log_id: result.insertId,
          shift_date: row.shift_date,
          clock_in: clockIn,
          clock_out: clockOut,
          total_hours: effectiveHours,
          attendance_status: row.attendance_status || 'PRESENT',
        });
      }

      const breaches = await AttendanceService._evaluateContinuousDuty(
        connection,
        resident_id,
        cap,
        inserted,
        activeRule,
      );

      await connection.commit();

      return {
        added: inserted.map((row) => row.log_id),
        count: inserted.length,
        flagged: breaches.flagged,
        breaches,
        rule_evaluated: activeRule ? activeRule.rule_set_name : 'NO_ACTIVE_RULE_FOUND',
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Re-read the rows around the ones just written, group them into continuous
   * chains, and flag every chain that runs past the cap. Returns the flags and a
   * short description of each breach; validation is a no-op when there is no
   * active rule or nothing was written.
   */
  static async _evaluateContinuousDuty(connection, residentId, cap, inserted, activeRule) {
    if (cap === null || inserted.length === 0) {
      return { flagged: [], violations: [] };
    }

    const dates = inserted.map((row) => row.shift_date).filter(Boolean).sort();
    const from = addDays(dates[0], -1);
    const to = addDays(dates[dates.length - 1], 1);

    const [scanRows] = await connection.query(CHAIN_SCAN_SELECT, [residentId, from, to]);
    const chains = continuousDutyChains(scanRows);

    const newIds = new Set(inserted.map((row) => row.log_id));
    const flagged = new Set();
    const violations = [];

    for (const chain of chains) {
      if (chain.totalHours <= cap) continue;
      if (!chain.logs.some((log) => newIds.has(Number(log.log_id)))) continue;

      for (const log of chain.logs) flagged.add(Number(log.log_id));

      violations.push({
        anchor_log_id: Number(chain.logs[0].log_id),
        total_hours: chain.totalHours,
        rows: chain.logs.length,
        details: `Continuous duty of ${chain.totalHours} hours across ${chain.logs.length} calendar row(s) exceeds the ${cap}-hour limit (${activeRule.max_continuous_shift_hours}h shift + ${activeRule.max_transition_extension_hours}h transition extension).`,
      });
    }

    if (flagged.size > 0) {
      await connection.query(
        `UPDATE resident_attendance_logs SET is_flagged_for_breach = 1 WHERE id IN (?);`,
        [[...flagged]],
      );

      for (const violation of violations) {
        // Re-importing the same days must not multiply the audit trail.
        const [existing] = await connection.query(
          `SELECT id FROM duty_hour_violations
            WHERE attendance_log_id = ? AND rule_type = 'CONTINUOUS_SHIFT_EXCEEDED'
            LIMIT 1;`,
          [violation.anchor_log_id],
        );
        if (existing.length > 0) continue;

        await connection.query(
          `INSERT INTO duty_hour_violations
             (resident_id, attendance_log_id, rule_type, severity, violation_details)
           VALUES (?, ?, 'CONTINUOUS_SHIFT_EXCEEDED', 'CRITICAL_VIOLATION', ?);`,
          [residentId, violation.anchor_log_id, violation.details],
        );
      }
    }

    return { flagged: [...flagged], violations };
  }

  /**
   * Fetch attendance logs with violation details for a resident.
   *
   * `clock_in` / `clock_out` are DATE_FORMATted to `YYYY-MM-DD HH:MM` rather
   * than left as a DATETIME, which mysql2 would materialise as a UTC instant
   * (`...T04:00:00.000Z`). The stored value is a wall-clock time, so returning
   * it without a timezone — and without the always-zero seconds — matches both
   * what was written and what the resident sees.
   */
  static async getAttendanceByResident(residentId) {
    const query = `
      SELECT
        al.id AS log_id,
        CONCAT(r.first_name, ' ', r.last_name) AS resident_name,
        al.shift_date,
        DATE_FORMAT(al.clock_in, '%Y-%m-%d %H:%i') AS clock_in,
        DATE_FORMAT(al.clock_out, '%Y-%m-%d %H:%i') AS clock_out,
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
