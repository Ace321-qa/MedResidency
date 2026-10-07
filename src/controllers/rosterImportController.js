const db = require('../config/db');
const { generateRosterTemplate, parseRosterFile } = require('../utils/excel/roster');

class RosterImportController {
  static async downloadTemplate(req, res) {
    try {
      const buf = generateRosterTemplate();
      res.setHeader('Content-Disposition', 'attachment; filename="roster_template.xlsx"');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.send(buf);
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  }

  static async import(req, res) {
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
      const rows = parseRosterFile(req.file.buffer);
      const errors = [];
      const seen = new Set();
      for (let r of rows) {
        if (!r.first_name || !r.last_name || !r.corporate_id || !r.pgy_level || !r.start_date || !r.expected_completion_date) {
          errors.push({ row: r.row, error: 'Missing required field' });
          continue;
        }
        if (seen.has(r.corporate_id)) {
          errors.push({ row: r.row, error: `Duplicate Corporate ID in file: ${r.corporate_id}` });
          continue;
        }
        seen.add(r.corporate_id);
      }
      if (errors.length) return res.status(400).json({ success: false, errors });
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        const [p] = await conn.query('SELECT id, program_name, program_code FROM programs ORDER BY id ASC LIMIT 1');
        const programId = p[0] ? p[0].id : 1;
        const added = [];
        for (let r of rows) {
          const [rid] = await conn.query('SELECT id FROM resident_identifiers WHERE identifier_type="CORPORATE_ID" AND identifier_value=?', [r.corporate_id]);
          if (rid.length) throw new Error(`Row ${r.row}: Corporate ID ${r.corporate_id} already exists`);
          const [resIns] = await conn.query(
            'INSERT INTO residents (first_name, middle_initial, last_name, date_of_birth, sex, nationality, citizenship_status) VALUES (?,?,?,?,?,?,?)',
            [r.first_name, r.middle_name, r.last_name, '1990-01-01', 'UNKNOWN', 'Not Specified', 'UNKNOWN']
          );
          const residentId = resIns.insertId;
          await conn.query(
            'INSERT INTO resident_identifiers (resident_id, identifier_type, identifier_value, is_primary) VALUES (?,?,?,1)',
            [residentId, 'CORPORATE_ID', r.corporate_id]
          );
          await conn.query(
            'INSERT INTO residency_enrollments (resident_id, program_id, resident_status, position_type, year_in_program, start_date, expected_completion_date) VALUES (?,?,?,?,?,?,?)',
            [residentId, programId, 'ACTIVE', 'FULL_TIME', parseInt(r.pgy_level) || 1, r.start_date, r.expected_completion_date]
          );
          added.push(residentId);
        }
        await conn.commit();
        res.json({ success: true, added });
      } catch (e) {
        await conn.rollback();
        res.status(400).json({ success: false, error: e.message });
      } finally {
        conn.release();
      }
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  }
}

module.exports = RosterImportController;
