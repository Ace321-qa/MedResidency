const db = require('../config/db');

class LetterService {
  /**
   * Generate an official mail-merged release letter from template
   */
  static async generateReleaseLetter(letterData) {
    const { longitudinal_assignment_id, template_id, recipient_dept_head, hospital_department_name } = letterData;

    // 1. Fetch assignment and resident profile details
    const assignQuery = `
      SELECT 
        rla.id AS assignment_id,
        rla.resident_id,
        CONCAT(r.first_name, ' ', r.last_name) AS resident_name,
        p.program_code,
        re.year_in_program,
        lct.clinic_name,
        rla.site_name,
        rla.day_of_week,
        TIME_FORMAT(rla.start_time, '%h:%i %p') AS start_time,
        TIME_FORMAT(rla.end_time, '%h:%i %p') AS end_time
      FROM resident_longitudinal_assignments rla
      JOIN residents r ON r.id = rla.resident_id
      JOIN longitudinal_clinic_types lct ON lct.id = rla.clinic_type_id
      JOIN residency_enrollments re ON re.resident_id = r.id AND re.resident_status = 'ACTIVE_FULL_TIME'
      JOIN programs p ON p.id = re.program_id
      WHERE rla.id = ?;
    `;
    const [assignments] = await db.query(assignQuery, [longitudinal_assignment_id]);
    if (!assignments[0]) throw new Error('Longitudinal assignment not found');
    const assign = assignments[0];

    // 2. Fetch Release Letter Template
    const tempQuery = `SELECT * FROM release_letter_templates WHERE id = ?;`;
    const [templates] = await db.query(tempQuery, [template_id || 1]);
    if (!templates[0]) throw new Error('Release letter template not found');
    const template = templates[0];

    // 3. Mail-Merge: Parse placeholders
    let parsedBody = template.letter_body
      .replace(/{{RESIDENT_NAME}}/g, assign.resident_name)
      .replace(/{{PGY_LEVEL}}/g, `PGY-${assign.year_in_program}`)
      .replace(/{{HOSPITAL_DEPT}}/g, hospital_department_name)
      .replace(/{{CLINIC_NAME}}/g, assign.clinic_name)
      .replace(/{{SITE_NAME}}/g, assign.site_name)
      .replace(/{{RELEASE_DAY}}/g, assign.day_of_week)
      .replace(/{{START_TIME}}/g, assign.start_time)
      .replace(/{{END_TIME}}/g, assign.end_time)
      .replace(/{{DEPT_HEAD_NAME}}/g, recipient_dept_head);

    // 4. Save generated letter record in database
    const insertLetterQuery = `
      INSERT INTO generated_release_letters
        (longitudinal_assignment_id, resident_id, template_id, recipient_dept_head, hospital_department_name, generated_letter_body, sent_status, sent_at)
      VALUES (?, ?, ?, ?, ?, ?, 'SENT', NOW());
    `;

    const [result] = await db.query(insertLetterQuery, [
      longitudinal_assignment_id,
      assign.resident_id,
      template.id,
      recipient_dept_head,
      hospital_department_name,
      parsedBody
    ]);

    // Update assignment to record letter generation
    await db.query(`UPDATE resident_longitudinal_assignments SET release_letter_generated = TRUE WHERE id = ?;`, [longitudinal_assignment_id]);

    return {
      letter_id: result.insertId,
      resident_name: assign.resident_name,
      recipient_dept_head,
      hospital_department_name,
      generated_letter_body: parsedBody,
      sent_status: 'SENT'
    };
  }

  /**
   * Fetch generated letters for a resident
   */
  static async getLettersByResident(residentId) {
    const query = `
      SELECT 
        grl.id AS letter_id,
        CONCAT(r.first_name, ' ', r.last_name) AS resident_name,
        grl.recipient_dept_head,
        grl.hospital_department_name,
        grl.sent_status,
        grl.sent_at,
        grl.generated_letter_body
      FROM generated_release_letters grl
      JOIN residents r ON r.id = grl.resident_id
      WHERE grl.resident_id = ?
      ORDER BY grl.created_at DESC;
    `;
    const [rows] = await db.query(query, [residentId]);
    return rows;
  }
}

module.exports = LetterService;