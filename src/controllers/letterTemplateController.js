const db = require('../config/db');

class LetterTemplateController {
  static async list(req, res) {
    try {
      const [rows] = await db.query('SELECT * FROM release_letter_templates ORDER BY id DESC');
      res.json({ success: true, data: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  }
  static async create(req, res) {
    try {
      const { program_id = 1, template_code, template_name, letter_subject, letter_body, is_active = 1 } = req.body;
      const [r] = await db.query(
        'INSERT INTO release_letter_templates (program_id, template_code, template_name, letter_subject, letter_body, is_active) VALUES (?,?,?,?,?,?)',
        [program_id, template_code, template_name, letter_subject, letter_body, is_active]
      );
      res.json({ success: true, id: r.insertId });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  }
  static async update(req, res) {
    try {
      const id = req.params.id;
      const { template_code, template_name, letter_subject, letter_body, is_active } = req.body;
      await db.query(
        'UPDATE release_letter_templates SET template_code=?, template_name=?, letter_subject=?, letter_body=?, is_active=? WHERE id=?',
        [template_code, template_name, letter_subject, letter_body, is_active, id]
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  }
  static async delete(req, res) {
    try {
      const id = req.params.id;
      await db.query('DELETE FROM release_letter_templates WHERE id=?', [id]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  }
}

module.exports = LetterTemplateController;
