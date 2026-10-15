const AttendanceService = require('../services/attendanceService');

class AttendanceController {
  /**
   * Map a thrown service error onto the right HTTP status.
   *
   * A clock value the minute-precision parser could not read is a client error,
   * a missing foreign key is a 404, and an enum violation is a 400 — everything
   * else is a genuine server failure.
   */
  static _errorResponse(res, error, context) {
    // eslint-disable-next-line no-console
    console.error(`Error in ${context}:`, error.message);

    if (error.statusCode === 400) {
      return res.status(400).json({ success: false, error: error.message });
    }

    if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_NO_REFERENCED_ROW') {
      return res.status(404).json({
        success: false,
        error: 'Invalid foreign key reference. Ensure resident_id and assignment_id exist.',
      });
    }

    if (error.code === 'ER_DATA_TOO_LONG' || error.code === 'ER_TRUNCATED_WRONG_VALUE' || error.errno === 1265) {
      return res.status(400).json({
        success: false,
        error:
          'Invalid attendance_status value. Must be one of: PRESENT, ABSENT, ON_CALL, SICK_LEAVE, VACATION, ANNUAL_LEAVE, CASUAL_LEAVE, EMERGENCY_LEAVE, HAJJ_LEAVE, ACADEMIC_LEAVE, STUDY_LEAVE, EXAM_LEAVE, OTHER_LEAVE',
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Database operation failed',
      details: error.message,
    });
  }

  /**
   * POST /api/v1/attendance
   */
  static async logAttendance(req, res) {
    try {
      const { resident_id, shift_date } = req.body;

      // Validation Defense: Verify all required fields exist
      if (!resident_id || !shift_date) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: resident_id, shift_date'
        });
      }

      const result = await AttendanceService.logAttendance(req.body);

      return res.status(201).json({
        success: true,
        message: result.is_flagged_for_breach
          ? 'Attendance logged and flagged as a duty hour violation'
          : 'Attendance logged successfully',
        data: result
      });
    } catch (error) {
      return AttendanceController._errorResponse(res, error, 'logAttendance controller');
    }
  }

  /**
   * POST /api/v1/attendance/batch
   *
   * `{ resident_id, rows: [{ shift_date, clock_in, clock_out, total_hours,
   * attendance_status, notes }] }` — one row per calendar day. Written in one
   * transaction and evaluated for continuous duty across the rows, so an
   * overnight call recorded as two rows is judged as one period.
   */
  static async logTimesheetBatch(req, res) {
    try {
      const { resident_id, rows } = req.body;

      if (!resident_id || !Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: resident_id, rows[]',
        });
      }

      const result = await AttendanceService.logTimesheetBatch({ resident_id, rows });

      return res.status(201).json({
        success: true,
        message: result.breaches.violations.length > 0
          ? 'Timesheet saved and flagged for a continuous-duty violation'
          : 'Timesheet saved successfully',
        data: result,
      });
    } catch (error) {
      return AttendanceController._errorResponse(res, error, 'logTimesheetBatch controller');
    }
  }

  /**
   * GET /api/v1/attendance/resident/:resident_id
   */
  static async getResidentAttendance(req, res) {
    try {
      const { resident_id } = req.params;
      const logs = await AttendanceService.getAttendanceByResident(resident_id);

      return res.status(200).json({
        success: true,
        count: logs.length,
        data: logs
      });
    } catch (error) {
      console.error('Error in getResidentAttendance controller:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch attendance logs',
        details: error.message
      });
    }
  }
}

module.exports = AttendanceController;
