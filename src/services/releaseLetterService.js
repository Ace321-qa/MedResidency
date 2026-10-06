const db = require('../config/db');

const DEFAULT_TEMPLATE_CODE = 'STANDARD-RELEASE';

// Sent states that block a regeneration unless the caller explicitly opts in
const LIVE_SENT_STATES = ['GENERATED', 'SENT', 'ACKNOWLEDGED'];

/**
 * Format a MySQL TIME value as `hh:mm AM/PM` for the letter body
 */
function formatTime(value) {
  if (!value) return null;
  const [hours, minutes] = String(value).split(':');
  const hour = Number(hours);
  if (Number.isNaN(hour)) return null;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(displayHour).padStart(2, '0')}:${minutes} ${suffix}`;
}

/**
 * Normalise a MySQL DATE value into a plain YYYY-MM-DD string.
 * mysql2 materialises DATE columns at local midnight, so the local calendar
 * parts are the true stored date; toISOString() would shift it back a day on
 * any UTC+ host.
 */
function toDateString(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

class ReleaseLetterService {
  /**
   * Replace {{PLACEHOLDER}} tokens in a template with merge values and report
   * any placeholder the template expects but the resolver could not supply
   */
  static mergeTemplate(template, values) {
    const unresolved = [];

    const merged = String(template).replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (token, key) => {
      const value = values[key];
      if (value !== undefined && value !== null && value !== '') {
        return value;
      }
      unresolved.push(key);
      return token;
    });

    return { merged, unresolved: [...new Set(unresolved)] };
  }

  /**
   * Resolve the resident, program and PGY level used by the merge fields
   */
  static async getResidentMergeContext(residentId) {
    const [rows] = await db.query(
      `SELECT
         r.id AS resident_id,
         r.first_name,
         r.middle_initial,
         r.last_name,
         re.program_id,
         re.year_in_program,
         p.program_name,
         p.specialty_name,
         p.institution_name
       FROM residents r
       LEFT JOIN residency_enrollments re ON re.resident_id = r.id
       LEFT JOIN programs p ON p.id = re.program_id
       WHERE r.id = ?
       ORDER BY re.created_at DESC
       LIMIT 1;`,
      [residentId]
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ');

    return {
      resident_id: row.resident_id,
      resident_name: fullName,
      pgy_level: row.year_in_program ? `PGY-${row.year_in_program}` : null,
      program_id: row.program_id || null,
      program_name: row.program_name || null,
      specialty_name: row.specialty_name || null,
      institution_name: row.institution_name || null,
    };
  }

  /**
   * Load the longitudinal clinic assignment that anchors the letter, together
   * with its clinic type. When no assignment is supplied, resolve the resident's
   * active clinic that still requires a release letter.
   */
  static async resolveLongitudinalAssignment(residentId, assignmentId) {
    const baseSelect = `
      SELECT
        rla.id AS longitudinal_assignment_id,
        rla.resident_id,
        rla.site_name,
        rla.supervisor_name,
        rla.day_of_week,
        rla.start_time,
        rla.end_time,
        rla.start_date,
        rla.end_date,
        rla.requires_release_letter,
        rla.release_letter_generated,
        lct.clinic_code,
        lct.clinic_name,
        lct.program_id AS clinic_program_id
      FROM resident_longitudinal_assignments rla
      JOIN longitudinal_clinic_types lct ON lct.id = rla.clinic_type_id
    `;

    if (assignmentId) {
      const [rows] = await db.query(
        `${baseSelect} WHERE rla.id = ? AND rla.resident_id = ? LIMIT 1;`,
        [assignmentId, residentId]
      );
      if (rows.length === 0) {
        const error = new Error(
          `Longitudinal assignment ${assignmentId} was not found for resident ${residentId}`
        );
        error.statusCode = 404;
        throw error;
      }
      return rows[0];
    }

    const [rows] = await db.query(
      `${baseSelect}
       WHERE rla.resident_id = ?
         AND rla.is_active = 1
         AND rla.requires_release_letter = 1
         AND rla.release_letter_generated = 0
       ORDER BY rla.start_date ASC
       LIMIT 1;`,
      [residentId]
    );

    if (rows.length === 0) {
      const error = new Error(
        `No active longitudinal clinic requiring a release letter was found for resident ${residentId}`
      );
      error.statusCode = 409;
      throw error;
    }

    return rows[0];
  }

  /**
   * Fetch the active mail-merge template for a program
   */
  static async getTemplate(programId, { template_id, template_code } = {}) {
    if (template_id) {
      const [byId] = await db.query(
        `SELECT * FROM release_letter_templates WHERE id = ? AND is_active = 1 LIMIT 1;`,
        [template_id]
      );
      if (byId.length > 0) return byId[0];
    }

    const code = template_code || DEFAULT_TEMPLATE_CODE;

    if (!programId) {
      const error = new Error('Cannot resolve a letter template without an active program enrollment');
      error.statusCode = 409;
      throw error;
    }

    const [rows] = await db.query(
      `SELECT * FROM release_letter_templates
       WHERE program_id = ? AND template_code = ? AND is_active = 1
       LIMIT 1;`,
      [programId, code]
    );

    if (rows.length === 0) {
      const error = new Error(
        `Active template "${code}" was not found for program ${programId}`
      );
      error.statusCode = 404;
      throw error;
    }

    return rows[0];
  }

  /**
   * Determine which hospital department currently holds the resident, so the
   * letter can address the right department head. The rotation overlapping the
   * longitudinal clinic window wins; otherwise the program specialty is used.
   */
  static async resolveHospitalDepartment(residentId, windowStart, windowEnd, fallback) {
    const [rows] = await db.query(
      `SELECT rot.department_name
       FROM resident_rotation_assignments rra
       JOIN rotations rot ON rot.id = rra.rotation_id
       WHERE rra.resident_id = ?
         AND rra.start_date <= ?
         AND rra.end_date >= ?
       ORDER BY rra.start_date DESC, rra.id DESC
       LIMIT 1;`,
      [residentId, windowEnd || windowStart, windowStart]
    );

    if (rows.length > 0 && rows[0].department_name) {
      return rows[0].department_name;
    }

    return fallback || null;
  }

  /**
   * Check whether a live letter already exists for this assignment + template
   */
  static async findExistingLetter(assignmentId, templateId) {
    const [rows] = await db.query(
      `SELECT id, sent_status FROM generated_release_letters
       WHERE longitudinal_assignment_id = ? AND template_id = ?
         AND sent_status IN (?)
       LIMIT 1;`,
      [assignmentId, templateId, LIVE_SENT_STATES]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Generate a mail-merge release letter and persist it. The letter row and the
   * assignment's release_letter_generated flag commit together in one transaction.
   */
  static async generateLetter(letterData) {
    const {
      resident_id,
      longitudinal_assignment_id,
      template_id,
      template_code,
      recipient_dept_head,
      hospital_department_name,
      sent_status,
      regenerate = false,
    } = letterData;

    const context = await this.getResidentMergeContext(resident_id);
    if (!context) {
      const error = new Error(`Resident ${resident_id} not found`);
      error.statusCode = 404;
      throw error;
    }

    const assignment = await this.resolveLongitudinalAssignment(
      resident_id,
      longitudinal_assignment_id
    );
    const template = await this.getTemplate(
      template_id ? null : context.program_id || assignment.clinic_program_id,
      { template_id, template_code }
    );

    const existing = await this.findExistingLetter(
      assignment.longitudinal_assignment_id,
      template.id
    );

    if (existing && !regenerate) {
      const error = new Error(
        `Letter ${existing.id} already exists for longitudinal assignment ${assignment.longitudinal_assignment_id} using template ${template.template_code}. Pass regenerate: true to supersede it.`
      );
      error.statusCode = 409;
      throw error;
    }

    const assignmentStart = toDateString(assignment.start_date);
    const assignmentEnd = toDateString(assignment.end_date);
    const hospitalDept =
      hospital_department_name ||
      (await this.resolveHospitalDepartment(
        resident_id,
        assignmentStart,
        assignmentEnd,
        context.specialty_name
      ));

    const values = {
      RESIDENT_NAME: context.resident_name,
      PGY_LEVEL: context.pgy_level,
      HOSPITAL_DEPT: hospitalDept,
      CLINIC_NAME: assignment.clinic_name,
      SITE_NAME: assignment.site_name,
      RELEASE_DAY: assignment.day_of_week,
      START_TIME: formatTime(assignment.start_time),
      END_TIME: formatTime(assignment.end_time),
      DEPT_HEAD_NAME: recipient_dept_head || null,
      SUPERVISOR_NAME: assignment.supervisor_name,
      PROGRAM_NAME: context.program_name,
      SPECIALTY_NAME: context.specialty_name,
      INSTITUTION_NAME: context.institution_name,
      RELEASE_START_DATE: assignmentStart,
      RELEASE_END_DATE: assignmentEnd,
    };

    const body = this.mergeTemplate(template.letter_body, values);
    const subject = this.mergeTemplate(template.letter_subject, values);

    const nextStatus = sent_status || 'GENERATED';
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      const [insertResult] = await connection.query(
        `INSERT INTO generated_release_letters
           (longitudinal_assignment_id, resident_id, template_id, recipient_dept_head,
            hospital_department_name, generated_letter_body, sent_status, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          assignment.longitudinal_assignment_id,
          resident_id,
          template.id,
          recipient_dept_head || 'Head of Department',
          hospitalDept,
          body.merged,
          nextStatus,
          nextStatus === 'SENT' || nextStatus === 'ACKNOWLEDGED' ? new Date() : null,
        ]
      );

      await connection.query(
        `UPDATE resident_longitudinal_assignments
         SET release_letter_generated = 1
         WHERE id = ?;`,
        [assignment.longitudinal_assignment_id]
      );

      await connection.commit();

      return {
        letter_id: insertResult.insertId,
        supersedes_letter_id: existing ? existing.id : null,
        resident_id,
        resident_name: context.resident_name,
        pgy_level: context.pgy_level,
        longitudinal_assignment_id: assignment.longitudinal_assignment_id,
        template_id: template.id,
        template_code: template.template_code,
        template_name: template.template_name,
        recipient_dept_head: recipient_dept_head || 'Head of Department',
        hospital_department_name: hospitalDept,
        sent_status: nextStatus,
        letter_subject: subject.merged,
        generated_letter_body: body.merged,
        merge_values: values,
        // Subject as well as body: a letter whose body filled in cleanly but
        // whose subject still reads "{{PGY_LEVEL}}" is not ready to send, and the
        // controller's warning is the only place that is said out loud.
        unresolved_placeholders: [...new Set([...subject.unresolved, ...body.unresolved])],
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Rebuild the merge values for a stored letter, so the *subject* can be merged
   * on read.
   *
   * `generateLetter` merges the subject but never persists it — the column does
   * not exist on `generated_release_letters` — and the list query used to return
   * `release_letter_templates.letter_subject` verbatim. That is the raw template,
   * so a letter whose body reads "Dr. Omar Al-Nouri (PGY-1)" opened under a
   * subject still full of `{{RESIDENT_NAME}}`: the one line a coordinator reads
   * first was the one line nobody merged.
   *
   * Every value here mirrors the map in `generateLetter`. The body is stored
   * merged, so this only ever has to agree with the template's subject line —
   * and if it cannot fill a token, `mergeTemplate` leaves it in place, which the
   * preview highlights rather than hiding.
   */
  static buildMergeValues(row) {
    return {
      RESIDENT_NAME: row.resident_name,
      PGY_LEVEL: row.year_in_program ? `PGY-${row.year_in_program}` : null,
      HOSPITAL_DEPT: row.hospital_department_name,
      CLINIC_NAME: row.clinic_name,
      SITE_NAME: row.site_name,
      RELEASE_DAY: row.day_of_week,
      START_TIME: formatTime(row.start_time),
      END_TIME: formatTime(row.end_time),
      DEPT_HEAD_NAME: row.recipient_dept_head,
      SUPERVISOR_NAME: row.supervisor_name,
      PROGRAM_NAME: row.program_name,
      SPECIALTY_NAME: row.specialty_name,
      INSTITUTION_NAME: row.institution_name,
      RELEASE_START_DATE: row.release_start_date,
      RELEASE_END_DATE: row.release_end_date,
    };
  }

  /**
   * Fetch every generated release letter for a resident
   *
   * `letter_subject` is merged here rather than read from the template: see
   * `buildMergeValues`.
   */
  static async getLettersByResident(residentId) {
    const query = `
      SELECT
        grl.id AS letter_id,
        CONCAT(r.first_name, ' ', r.last_name) AS resident_name,
        grl.longitudinal_assignment_id,
        rla.site_name,
        rla.day_of_week,
        rla.start_time,
        rla.end_time,
        rla.supervisor_name,
        lct.clinic_name,
        re.year_in_program,
        p.program_name,
        p.specialty_name,
        p.institution_name,
        grl.template_id,
        rlt.template_code,
        rlt.template_name,
        rlt.letter_subject,
        grl.recipient_dept_head,
        grl.hospital_department_name,
        grl.generated_letter_body,
        grl.sent_status,
        grl.sent_at,
        grl.created_at,
        DATE_FORMAT(rla.start_date, '%Y-%m-%d') AS release_start_date,
        DATE_FORMAT(rla.end_date, '%Y-%m-%d') AS release_end_date
      FROM generated_release_letters grl
      JOIN residents r ON r.id = grl.resident_id
      JOIN release_letter_templates rlt ON rlt.id = grl.template_id
      JOIN resident_longitudinal_assignments rla ON rla.id = grl.longitudinal_assignment_id
      JOIN longitudinal_clinic_types lct ON lct.id = rla.clinic_type_id
      LEFT JOIN residency_enrollments re ON re.id = (
        SELECT re2.id FROM residency_enrollments re2
        WHERE re2.resident_id = r.id
        ORDER BY re2.created_at DESC
        LIMIT 1
      )
      LEFT JOIN programs p ON p.id = re.program_id
      WHERE grl.resident_id = ?
      ORDER BY grl.created_at DESC;
    `;
    const [rows] = await db.query(query, [residentId]);

    return rows.map((row) => ({
      ...row,
      letter_subject: row.letter_subject
        ? this.mergeTemplate(row.letter_subject, this.buildMergeValues(row)).merged
        : row.letter_subject,
    }));
  }
}

module.exports = ReleaseLetterService;