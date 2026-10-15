const upload = require('../middleware/upload');
const AttendanceService = require('../services/attendanceService');
const { generateTimesheetTemplate, parseTimesheetFile } = require('../utils/excel/timesheet');

/**
 * Monthly timesheet import — bulk-filling a month of attendance.
 *
 * The workbook is parsed and validated **before** the first insert, so the file
 * is either acceptable row by row or it is rejected with one message per bad
 * row — a coordinator never has to fix the upload one error at a time.
 *
 * The accepted rows then go in through `logTimesheetBatch`, a single
 * transaction. One transaction is what makes the continuous-duty check correct:
 * because a row is one calendar day, an overnight call is two rows that only
 * mean anything together, and judgement has to happen over the whole set rather
 * than row by row as it is written.
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

      const result = await AttendanceService.logTimesheetBatch({
        resident_id: residentId,
        rows: parsed.rows,
      });

      return res.json({
        success: true,
        added: result.added,
        count: result.count,
        flagged: result.flagged,
        breaches: result.breaches.violations,
        rule_evaluated: result.rule_evaluated,
      });
    } catch (error) {
      // A row the database rejects (unreadable clock, missing resident) is a
      // bad request, matching the pre-insert validation above.
      if (error.statusCode === 400) {
        return res.status(400).json({ success: false, error: error.message });
      }
      if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_NO_REFERENCED_ROW') {
        return res
          .status(404)
          .json({ success: false, error: 'resident_id does not reference an existing resident' });
      }
      return res.status(500).json({ success: false, error: error.message });
    }
  }
}

/**
 * The example rows the mobile client mirrors when it builds the file offline.
 *
 * One row is one calendar day, so the sample shows how a 24-hour call is
 * written: not as a single 24-hour row but split at midnight — `08:00 → 24:00`
 * on the first day and `00:00 → 08:00` on the second — which is what the
 * continuous-duty engine stitches back together when the file is imported.
 */
const SAMPLE_ROWS = [
  ['2026-10-01', 'PRESENT', '08:00', '17:00', 8, 'Regular day shift'],
  ['2026-10-02', 'ON_CALL', '08:00', '24:00', 16, 'Continuous duty (Part 1 - Day 1)'],
  ['2026-10-03', 'ON_CALL', '00:00', '08:00', 8, 'Continuous duty (Part 2 - Day 2)'],
];

module.exports = AttendanceImportController;
