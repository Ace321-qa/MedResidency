const upload = require('../middleware/upload');
const AttendanceService = require('../services/attendanceService');
const { generateTimesheetTemplate, parseTimesheetFile } = require('../utils/excel/timesheet');

/**
 * Monthly timesheet import — bulk-filling a month of attendance.
 *
 * One file, one transaction-free loop over `AttendanceService.logAttendance`,
 * because each shift must keep its own duty-hour evaluation: a month where one
 * bad row rolls back every good row already written would be worse than a
 * partial import with a precise list of what failed.
 *
 * Validation happens *before* the first insert. The workbook is either
 * acceptable row by row or it is rejected with one message per bad row, so a
 * coordinator never has to fix the file one error at a time.
 */
class AttendanceImportController {
  /** GET /api/v1/attendance/template */
  static async template(req, res) {
    try {
      const buf = generateTimesheetTemplate(SAMPLE_ROWS);
      res.setHeader('Content-Disposition', 'attachment; filename="monthly_timesheet_template.xlsx"');
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.send(buf);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /** POST /api/v1/attendance/import — multipart `file` + `resident_id`. */
  static async import(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded' });
      }

      const residentId = Number(req.body?.resident_id);
      if (!Number.isInteger(residentId) || residentId <= 0) {
        return res
          .status(400)
          .json({ success: false, error: 'resident_id is required to import a timesheet' });
      }

      let parsed;
      try {
        parsed = parseTimesheetFile(req.file.buffer);
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }

      if (parsed.errors.length > 0) {
        return res.status(400).json({ success: false, errors: parsed.errors });
      }

      const added = [];
      const failures = [];

      for (const row of parsed.rows) {
        try {
          const result = await AttendanceService.logAttendance({
            resident_id: residentId,
            shift_date: row.shift_date,
            clock_in: row.clock_in,
            clock_out: row.clock_out,
            total_hours: row.total_hours,
            attendance_status: row.attendance_status,
            notes: row.notes,
          });
          added.push(result.log_id);
        } catch (error) {
          failures.push({ row: row.row, message: error.message });
        }
      }

      if (failures.length > 0) {
        return res.status(400).json({ success: false, errors: failures, added });
      }

      return res.json({ success: true, added, count: added.length });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
}

/** The three example rows the mobile client mirrors when it builds offline. */
const SAMPLE_ROWS = [
  ['2026-10-01', 'PRESENT', '2026-10-01 08:00:00', '2026-10-01 17:00:00', 8, 'Regular day shift'],
  ['2026-10-02', 'ON_CALL', '2026-10-02 08:00:00', '2026-10-03 08:00:00', 24, 'Continuous duty'],
  ['2026-10-03', 'ANNUAL_LEAVE', '', '', 0, 'Approved annual leave'],
];

module.exports = AttendanceImportController;
