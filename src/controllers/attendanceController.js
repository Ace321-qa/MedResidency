const AttendanceService = require('../services/attendanceService');

class AttendanceController {
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
      console.error('Error in logAttendance controller:', error.message);

      // Handle missing foreign key references (invalid resident_id / assignment_id)
      if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_NO_REFERENCED_ROW') {
        return res.status(404).json({
          success: false,
          error: 'Invalid foreign key reference. Ensure resident_id and assignment_id exist.'
        });
      }

      // Handle invalid enum value for attendance_status
      if (error.code === 'ER_DATA_TOO_LONG' || error.code === 'ER_TRUNCATED_WRONG_VALUE' || error.errno === 1265) {
        return res.status(400).json({
          success: false,
          error: 'Invalid attendance_status value. Must be one of: PRESENT, ABSENT, ON_CALL, SICK_LEAVE, VACATION, ANNUAL_LEAVE, CASUAL_LEAVE, EMERGENCY_LEAVE, HAJJ_LEAVE, ACADEMIC_LEAVE, STUDY_LEAVE, EXAM_LEAVE, OTHER_LEAVE'
        });
      }

      return res.status(500).json({
        success: false,
        error: 'Database operation failed',
        details: error.message
      });
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
