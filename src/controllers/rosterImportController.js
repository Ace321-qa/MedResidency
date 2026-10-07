const db = require('../config/db');
const { generateRosterTemplate, parseRosterFile } = require('../utils/excel/roster');

/**
 * Roster import.
 *
 * All or nothing: the whole file is validated before a single resident is
 * created, because a half-imported cohort — some residents enrolled, some
 * missing, no record of which — is worse than a rejected file. Each rejected
 * row is reported by number and column so the coordinator can fix the workbook
 * and upload it again.
 */
class RosterImportController {
  static async downloadTemplate(req, res) {
    try {
      const buffer = generateRosterTemplate();
      res.setHeader('Content-Disposition', 'attachment; filename="roster_template.xlsx"');
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.send(buffer);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  static async import(req, res) {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file was uploaded.' });
    }

    let parsed;
    try {
      parsed = parseRosterFile(req.file.buffer);
    } catch (error) {
      return res.status(400).json({ success: false, issues: [{ field: 'File', message: error.message }] });
    }

    const issues = [...parsed.errors];

    const programId = Number(req.body.program_id) || null;

    const conn = await db.getConnection();
    try {
      const [programs] = programId
        ? await conn.query('SELECT id, program_name FROM programs WHERE id = ?', [programId])
        : await conn.query('SELECT id, program_name FROM programs ORDER BY id ASC LIMIT 1');

      if (!programs.length) {
        return res.status(400).json({
          success: false,
          issues: [{ field: 'Programme', message: 'no programme exists to enrol residents into' }],
        });
      }
      const resolvedProgramId = programs[0].id;

      // Duplicate Corporate IDs *within the file* are caught here; duplicates
      // against the database need a query, done once for the whole batch.
      const byCorporateId = new Map();
      for (const row of parsed.rows) {
        const existing = byCorporateId.get(row.corporate_id);
        if (existing) {
          issues.push({
            row: row.row,
            field: 'Corporate ID',
            message: `duplicates row ${existing.row} in this file (${row.corporate_id})`,
          });
        } else {
          byCorporateId.set(row.corporate_id, row);
        }
      }

      if (byCorporateId.size > 0) {
        const identifiers = [...byCorporateId.keys()];
        const [taken] = await conn.query(
          `SELECT identifier_value FROM resident_identifiers
            WHERE identifier_type = 'CORPORATE_ID' AND identifier_value IN (?)`,
          [identifiers],
        );
        const takenSet = new Set(taken.map((record) => record.identifier_value));
        for (const row of byCorporateId.values()) {
          if (takenSet.has(row.corporate_id)) {
            issues.push({
              row: row.row,
              field: 'Corporate ID',
              message: `${row.corporate_id} already belongs to a resident`,
            });
          }
        }
      }

      if (issues.length > 0) {
        return res.status(400).json({ success: false, issues });
      }

      await conn.beginTransaction();
      const added = [];
      for (const row of byCorporateId.values()) {
        const [residentResult] = await conn.query(
          `INSERT INTO residents
             (first_name, middle_initial, last_name, date_of_birth, sex, nationality, citizenship_status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            row.first_name,
            row.middle_initial,
            row.last_name,
            '1990-01-01',
            'UNKNOWN',
            'Not Specified',
            'UNKNOWN',
          ],
        );
        const residentId = residentResult.insertId;

        await conn.query(
          `INSERT INTO resident_identifiers
             (resident_id, identifier_type, identifier_value, is_primary)
           VALUES (?, 'CORPORATE_ID', ?, 1)`,
          [residentId, row.corporate_id],
        );

        await conn.query(
          `INSERT INTO residency_enrollments
             (resident_id, program_id, resident_status, position_type, year_in_program, start_date, expected_completion_date)
           VALUES (?, ?, 'ACTIVE_FULL_TIME', 'FULL_TIME', ?, ?, ?)`,
          [residentId, resolvedProgramId, row.pgy_level ?? 1, row.start_date, row.expected_completion_date],
        );

        added.push(residentId);
      }
      await conn.commit();

      return res.json({
        success: true,
        added,
        summary: `${added.length} resident${added.length === 1 ? '' : 's'} enrolled into ${programs[0].program_name}.`,
      });
    } catch (error) {
      await conn.rollback();
      return res.status(400).json({ success: false, error: error.message });
    } finally {
      conn.release();
    }
  }
}

module.exports = RosterImportController;