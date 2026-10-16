const db = require('../config/db');

const DEFAULT_TEMPLATE_CODE = 'STANDARD-RELEASE';

// Sent states that block a regeneration unless the caller explicitly opts in.
// DRAFT is deliberately absent: a draft is superseded by the real dispatch.
const LIVE_SENT_STATES = ['SENT', 'DELIVERED'];

// The `sent_status` enum published by the schema. The live database runs
// without STRICT_TRANS_TABLES, so an out-of-range ENUM value is stored as ''
// instead of raising an error — every write is validated against this list.
const SENT_STATUSES = ['DRAFT', 'SENT', 'DELIVERED', 'REVOKED'];

// Statuses that stamp `sent_at`: a letter the programme actually put in front
// of a department head, not one parked as a draft.
const DISPATCHED_STATUSES = ['SENT', 'DELIVERED'];

const DEFAULT_TEMPLATE_SUBJECT =
  'Official Release Request for Resident: {{RESIDENT_NAME}} ({{PGY_LEVEL}})';

const DEFAULT_TEMPLATE_BODY = `Dear {{DEPT_HEAD_NAME}},

This letter is to formally request the weekly release of Dr. {{RESIDENT_NAME}} ({{PGY_LEVEL}}), currently rotating in {{HOSPITAL_DEPT}}, to attend their mandatory {{CLINIC_NAME}} at {{SITE_NAME}} every {{RELEASE_DAY}} from {{START_TIME}} to {{END_TIME}}.

Thank you for your continued support of medical residency education.

Sincerely,
Residency Program Administration`;

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

async function tableColumns(tableName) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?;`,
    [tableName]
  );
  return rows;
}

/**
 * Bring `release_letter_templates` and `generated_release_letters` up to the
 * documented shape. Idempotent: every step only runs when the column (or enum
 * member) is missing, so boot, tests and a fresh Hostinger restore all converge
 * on the same schema.
 *
 * The subject column is named `subject_line` by contract; older installs
 * created it as `letter_subject`, so the first run renames the column rather
 * than leaving two subject fields to keep in sync.
 */
let schemaPromise = null;

function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = applySchema().catch((error) => {
      // Allow a retry on the next call instead of caching the failure forever.
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function applySchema() {
  // --- release_letter_templates ------------------------------------------
  const templateColumns = await tableColumns('release_letter_templates');
  const templateNames = new Set(templateColumns.map((row) => row.COLUMN_NAME));

  if (!templateNames.has('subject_line')) {
    if (templateNames.has('letter_subject')) {
      await db.query(
        'ALTER TABLE release_letter_templates CHANGE COLUMN letter_subject subject_line VARCHAR(255) NOT NULL;'
      );
    } else {
      await db.query(
        'ALTER TABLE release_letter_templates ADD COLUMN subject_line VARCHAR(255) NOT NULL AFTER template_name;'
      );
    }
  }
  if (!templateNames.has('created_at')) {
    await db.query(
      'ALTER TABLE release_letter_templates ADD COLUMN created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP;'
    );
  }
  if (!templateNames.has('updated_at')) {
    await db.query(
      'ALTER TABLE release_letter_templates ADD COLUMN updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;'
    );
  }

  // --- generated_release_letters -----------------------------------------
  const letterColumns = await tableColumns('generated_release_letters');
  const letterNames = new Set(letterColumns.map((row) => row.COLUMN_NAME));

  if (!letterNames.has('rotation_assignment_id')) {
    await db.query(
      'ALTER TABLE generated_release_letters ADD COLUMN rotation_assignment_id BIGINT UNSIGNED NULL AFTER longitudinal_assignment_id;'
    );
    try {
      await db.query(
        'ALTER TABLE generated_release_letters ADD INDEX idx_grl_rotation_assignment (rotation_assignment_id);'
      );
    } catch (error) {
      if (error.code !== 'ER_DUP_KEYNAME') throw error;
    }
  }
  if (!letterNames.has('supervising_faculty')) {
    await db.query(
      'ALTER TABLE generated_release_letters ADD COLUMN supervising_faculty VARCHAR(191) NULL AFTER hospital_department_name;'
    );
  }

  const longColumn = letterColumns.find((row) => row.COLUMN_NAME === 'longitudinal_assignment_id');
  if (longColumn && longColumn.IS_NULLABLE === 'NO') {
    await db.query(
      'ALTER TABLE generated_release_letters MODIFY COLUMN longitudinal_assignment_id BIGINT UNSIGNED NULL;'
    );
  }

  const statusColumn = letterColumns.find((row) => row.COLUMN_NAME === 'sent_status');
  if (statusColumn) {
    const type = String(statusColumn.COLUMN_TYPE).toUpperCase();
    // 1. Widen the enum first so every legacy value has somewhere to land.
    if (!type.includes('DELIVERED') || !type.includes('REVOKED')) {
      await db.query(
        `ALTER TABLE generated_release_letters
         MODIFY COLUMN sent_status ENUM('DRAFT','GENERATED','SENT','ACKNOWLEDGED','DELIVERED','REVOKED')
         NOT NULL DEFAULT 'SENT';`
      );
    }
    // 2. Normalise the data to the published lifecycle. GENERATED meant "a
    //    letter went out", ACKNOWLEDGED meant "the department confirmed it" —
    //    those are SENT and DELIVERED. Rows the old enum could not represent
    //    were stored as '' (the database runs non-strict) and were dispatched
    //    for real, so they become SENT too.
    await db.query(
      `UPDATE generated_release_letters
       SET sent_status = 'DELIVERED'
       WHERE CAST(sent_status AS CHAR) = 'ACKNOWLEDGED';`
    );
    await db.query(
      `UPDATE generated_release_letters
       SET sent_status = 'SENT'
       WHERE CAST(sent_status AS CHAR) NOT IN ('DRAFT', 'SENT', 'DELIVERED', 'REVOKED');`
    );
    // 3. Shrink back to the documented four values.
    const fresh = await tableColumns('generated_release_letters');
    const freshType = String(
      fresh.find((row) => row.COLUMN_NAME === 'sent_status')?.COLUMN_TYPE ?? ''
    ).toUpperCase();
    if (freshType.includes('GENERATED') || freshType.includes('ACKNOWLEDGED')) {
      await db.query(
        `ALTER TABLE generated_release_letters
         MODIFY COLUMN sent_status ENUM('DRAFT','SENT','DELIVERED','REVOKED')
         NOT NULL DEFAULT 'SENT';`
      );
    }
  }
}

/**
 * Seed the STANDARD-RELEASE template for any programme that does not have one,
 * so a programme created after boot can generate a letter without a coordinator
 * first writing a template from scratch. Matched by (program_id, template_code),
 * exactly like the default-clinic seeder.
 */
async function ensureDefaultTemplates() {
  const [programs] = await db.query('SELECT id FROM programs ORDER BY id ASC;');
  if (programs.length === 0) return 0;

  const [existing] = await db.query(
    'SELECT program_id FROM release_letter_templates WHERE template_code = ?;',
    [DEFAULT_TEMPLATE_CODE]
  );
  const covered = new Set(existing.map((row) => Number(row.program_id)));
  let seeded = 0;

  for (const program of programs) {
    if (covered.has(Number(program.id))) continue;
    await db.query(
      `INSERT INTO release_letter_templates
         (program_id, template_code, template_name, subject_line, letter_body, is_active)
       VALUES (?, ?, ?, ?, ?, 1);`,
      [
        program.id,
        DEFAULT_TEMPLATE_CODE,
        'Standard Department Release Request Letter',
        DEFAULT_TEMPLATE_SUBJECT,
        DEFAULT_TEMPLATE_BODY,
      ]
    );
    seeded += 1;
  }
  return seeded;
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
   * Resolve the resident, program and PGY level used by the merge fields.
   *
   * The corporate id, email and mobile have no columns on `residents`; they
   * live in `resident_identifiers` and are pulled in with one correlated
   * subquery per type (a JOIN would multiply rows for residents holding
   * several identifiers of the same type).
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
         p.institution_name,
         (
           SELECT ri.identifier_value FROM resident_identifiers ri
           WHERE ri.resident_id = r.id AND ri.identifier_type = 'CORPORATE_ID'
           ORDER BY ri.is_primary DESC, ri.id ASC LIMIT 1
         ) AS corporate_id,
         (
           SELECT ri.identifier_value FROM resident_identifiers ri
           WHERE ri.resident_id = r.id AND ri.identifier_type = 'EMAIL'
           ORDER BY ri.is_primary DESC, ri.id ASC LIMIT 1
         ) AS resident_email,
         (
           SELECT ri.identifier_value FROM resident_identifiers ri
           WHERE ri.resident_id = r.id AND ri.identifier_type = 'MOBILE'
           ORDER BY ri.is_primary DESC, ri.id ASC LIMIT 1
         ) AS resident_mobile
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
      corporate_id: row.corporate_id || null,
      resident_email: row.resident_email || null,
      resident_mobile: row.resident_mobile || null,
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
   * Load the hospital rotation assignment that anchors a rotation release
   * letter, with the rotation's department — the letter's destination.
   */
  static async resolveRotationAssignment(residentId, rotationAssignmentId) {
    const [rows] = await db.query(
      `SELECT
         rra.id AS rotation_assignment_id,
         rra.resident_id,
         rra.start_date,
         rra.end_date,
         rra.notes,
         rot.rotation_name,
         rot.department_name
       FROM resident_rotation_assignments rra
       JOIN rotations rot ON rot.id = rra.rotation_id
       WHERE rra.id = ? AND rra.resident_id = ?
       LIMIT 1;`,
      [rotationAssignmentId, residentId]
    );

    if (rows.length === 0) {
      const error = new Error(
        `Rotation assignment ${rotationAssignmentId} was not found for resident ${residentId}`
      );
      error.statusCode = 404;
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
   * Check whether a live letter already exists for this assignment + template.
   * Either anchor (clinic or rotation) counts, so the same rotation cannot get
   * two live letters just because they used different rows to anchor them.
   */
  static async findExistingLetter(anchor, templateId) {
    const conditions = [];
    const params = [];

    if (anchor.longitudinal_assignment_id) {
      conditions.push('longitudinal_assignment_id = ?');
      params.push(anchor.longitudinal_assignment_id);
    }
    if (anchor.rotation_assignment_id) {
      conditions.push('rotation_assignment_id = ?');
      params.push(anchor.rotation_assignment_id);
    }
    if (conditions.length === 0) return null;

    params.push(templateId, LIVE_SENT_STATES);

    const [rows] = await db.query(
      `SELECT id, sent_status FROM generated_release_letters
       WHERE (${conditions.join(' OR ')}) AND template_id = ?
         AND sent_status IN (?)
       LIMIT 1;`,
      params
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Resolve every value a template can reference. Shared by generation and the
   * live preview, so what the coordinator sees before dispatch is exactly what
   * the letter will contain afterwards.
   */
  static async composeLetter(letterData) {
    const {
      resident_id,
      longitudinal_assignment_id,
      rotation_assignment_id,
      template_id,
      template_code,
      recipient_dept_head,
      hospital_department_name,
      supervising_faculty,
    } = letterData;

    const context = await this.getResidentMergeContext(resident_id);
    if (!context) {
      const error = new Error(`Resident ${resident_id} not found`);
      error.statusCode = 404;
      throw error;
    }

    let longitudinal = null;
    let rotation = null;

    // A letter may be anchored to the clinic, to the rotation, or to both; with
    // neither id supplied the resident's clinic still awaiting release is
    // resolved, which is the coordinator's usual one-tap flow.
    if (rotation_assignment_id) {
      rotation = await this.resolveRotationAssignment(resident_id, rotation_assignment_id);
    }
    if (longitudinal_assignment_id || !rotation) {
      longitudinal = await this.resolveLongitudinalAssignment(
        resident_id,
        longitudinal_assignment_id
      );
    }

    const anchor = {
      longitudinal_assignment_id: longitudinal ? longitudinal.longitudinal_assignment_id : null,
      rotation_assignment_id: rotation ? rotation.rotation_assignment_id : null,
    };

    const template = await this.getTemplate(
      template_id
        ? null
        : context.program_id || (longitudinal ? longitudinal.clinic_program_id : null),
      { template_id, template_code }
    );

    const assignmentStart = toDateString(longitudinal ? longitudinal.start_date : rotation.start_date);
    const assignmentEnd = toDateString(longitudinal ? longitudinal.end_date : rotation.end_date);

    let hospitalDept = hospital_department_name || null;
    if (!hospitalDept && longitudinal) {
      hospitalDept = await this.resolveHospitalDepartment(
        resident_id,
        assignmentStart,
        assignmentEnd,
        context.specialty_name
      );
    }
    if (!hospitalDept && rotation) {
      hospitalDept = rotation.department_name || context.specialty_name || null;
    }

    const values = {
      RESIDENT_NAME: context.resident_name,
      PGY_LEVEL: context.pgy_level,
      CORPORATE_ID: context.corporate_id,
      RESIDENT_EMAIL: context.resident_email,
      RESIDENT_MOBILE: context.resident_mobile,
      HOSPITAL_DEPT: hospitalDept,
      CLINIC_NAME: longitudinal ? longitudinal.clinic_name : null,
      SITE_NAME: longitudinal ? longitudinal.site_name : null,
      RELEASE_DAY: longitudinal ? longitudinal.day_of_week : null,
      START_TIME: longitudinal ? formatTime(longitudinal.start_time) : null,
      END_TIME: longitudinal ? formatTime(longitudinal.end_time) : null,
      DEPT_HEAD_NAME: recipient_dept_head || null,
      SUPERVISING_FACULTY: supervising_faculty || null,
      SUPERVISOR_NAME: longitudinal ? longitudinal.supervisor_name : null,
      ROTATION_NAME: rotation ? rotation.rotation_name : null,
      PROGRAM_NAME: context.program_name,
      SPECIALTY_NAME: context.specialty_name,
      INSTITUTION_NAME: context.institution_name,
      RELEASE_START_DATE: assignmentStart,
      RELEASE_END_DATE: assignmentEnd,
    };

    // The subject column is `subject_line`; older rows may still answer to
    // `letter_subject` if the schema migration has not run in this process.
    const subjectTemplate = template.subject_line ?? template.letter_subject ?? '';
    const body = this.mergeTemplate(template.letter_body, values);
    const subject = this.mergeTemplate(subjectTemplate, values);

    return {
      context,
      anchor,
      longitudinal,
      rotation,
      template,
      values,
      hospitalDept,
      body,
      subject,
      unresolved: [...new Set([...subject.unresolved, ...body.unresolved])],
    };
  }

  /**
   * Generate a mail-merge release letter and persist it. The letter row and the
   * assignment's release_letter_generated flag commit together in one transaction.
   */
  static async generateLetter(letterData) {
    const {
      resident_id,
      supervising_faculty,
      recipient_dept_head,
      sent_status,
      regenerate = false,
    } = letterData;

    const composed = await this.composeLetter(letterData);
    const { context, anchor, longitudinal, template, values, hospitalDept, body, subject } =
      composed;

    const existing = await this.findExistingLetter(anchor, template.id);

    if (existing && !regenerate) {
      const error = new Error(
        `Letter ${existing.id} already exists for this assignment using template ${template.template_code}. Pass regenerate: true to supersede it.`
      );
      error.statusCode = 409;
      throw error;
    }

    const nextStatus = sent_status || 'SENT';
    if (!SENT_STATUSES.includes(nextStatus)) {
      const error = new Error(
        `Invalid sent_status value. Must be one of: ${SENT_STATUSES.join(', ')}`
      );
      error.statusCode = 400;
      throw error;
    }

    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      const [insertResult] = await connection.query(
        `INSERT INTO generated_release_letters
           (longitudinal_assignment_id, rotation_assignment_id, resident_id, template_id,
            recipient_dept_head, hospital_department_name, supervising_faculty,
            generated_letter_body, sent_status, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          anchor.longitudinal_assignment_id,
          anchor.rotation_assignment_id,
          resident_id,
          template.id,
          recipient_dept_head || 'Head of Department',
          hospitalDept,
          supervising_faculty || null,
          body.merged,
          nextStatus,
          DISPATCHED_STATUSES.includes(nextStatus) ? new Date() : null,
        ]
      );

      if (anchor.longitudinal_assignment_id) {
        await connection.query(
          `UPDATE resident_longitudinal_assignments
           SET release_letter_generated = 1
           WHERE id = ?;`,
          [anchor.longitudinal_assignment_id]
        );
      }

      // Superseding is a takeover, not a second live letter: the one being
      // replaced loses its SENT/DELIVERED state so the department head is only
      // ever being asked to act on the newest version.
      if (existing && regenerate) {
        await connection.query(
          `UPDATE generated_release_letters SET sent_status = 'REVOKED' WHERE id = ?;`,
          [existing.id]
        );
      }

      await connection.commit();

      return {
        letter_id: insertResult.insertId,
        supersedes_letter_id: existing ? existing.id : null,
        resident_id,
        resident_name: context.resident_name,
        pgy_level: context.pgy_level,
        longitudinal_assignment_id: anchor.longitudinal_assignment_id,
        rotation_assignment_id: anchor.rotation_assignment_id,
        template_id: template.id,
        template_code: template.template_code,
        template_name: template.template_name,
        recipient_dept_head: recipient_dept_head || 'Head of Department',
        hospital_department_name: hospitalDept,
        supervising_faculty: supervising_faculty || null,
        sent_status: nextStatus,
        letter_subject: subject.merged,
        generated_letter_body: body.merged,
        merge_values: values,
        // Subject as well as body: a letter whose body filled in cleanly but
        // whose subject still reads "{{PGY_LEVEL}}" is not ready to send, and the
        // controller's warning is the only place that is said out loud.
        unresolved_placeholders: composed.unresolved,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Run the same resolution and merge as `generateLetter` without writing a row,
   * so the coordinator can read the finished letter before dispatching it.
   */
  static async previewLetter(letterData) {
    const composed = await this.composeLetter(letterData);
    const existing = await this.findExistingLetter(composed.anchor, composed.template.id);

    return {
      resident_id: composed.context.resident_id,
      resident_name: composed.context.resident_name,
      pgy_level: composed.context.pgy_level,
      longitudinal_assignment_id: composed.anchor.longitudinal_assignment_id,
      rotation_assignment_id: composed.anchor.rotation_assignment_id,
      template_id: composed.template.id,
      template_code: composed.template.template_code,
      template_name: composed.template.template_name,
      recipient_dept_head: letterData.recipient_dept_head || null,
      hospital_department_name: composed.hospitalDept,
      supervising_faculty: letterData.supervising_faculty || null,
      letter_subject: composed.subject.merged,
      generated_letter_body: composed.body.merged,
      merge_values: composed.values,
      unresolved_placeholders: composed.unresolved,
      existing_letter_id: existing ? existing.id : null,
    };
  }

  /**
   * Rebuild the merge values for a stored letter, so the *subject* can be merged
   * on read.
   *
   * `generateLetter` merges the subject but never persists it — the column does
   * not exist on `generated_release_letters` — and the list query used to return
   * `release_letter_templates.subject_line` verbatim. That is the raw template,
   * so a letter whose body read "Dr. Omar Al-Nouri (PGY-1)" could open under a
   * subject still full of `{{RESIDENT_NAME}}`: the one line a coordinator reads
   * first was the one line nobody merged.
   *
   * Every value here mirrors the map in `composeLetter`. The body is stored
   * merged, so this only ever has to agree with the template's subject line —
   * and if it cannot fill a token, `mergeTemplate` leaves it in place, which the
   * preview highlights rather than hiding.
   */
  static buildMergeValues(row) {
    return {
      RESIDENT_NAME: row.resident_name,
      PGY_LEVEL: row.year_in_program ? `PGY-${row.year_in_program}` : null,
      CORPORATE_ID: row.corporate_id ?? null,
      RESIDENT_EMAIL: row.resident_email ?? null,
      RESIDENT_MOBILE: row.resident_mobile ?? null,
      HOSPITAL_DEPT: row.hospital_department_name,
      CLINIC_NAME: row.clinic_name,
      SITE_NAME: row.site_name,
      RELEASE_DAY: row.day_of_week,
      START_TIME: formatTime(row.start_time),
      END_TIME: formatTime(row.end_time),
      DEPT_HEAD_NAME: row.recipient_dept_head,
      SUPERVISING_FACULTY: row.supervising_faculty ?? null,
      SUPERVISOR_NAME: row.supervisor_name,
      ROTATION_NAME: row.rotation_name ?? null,
      PROGRAM_NAME: row.program_name,
      SPECIALTY_NAME: row.specialty_name,
      INSTITUTION_NAME: row.institution_name,
      RELEASE_START_DATE: row.release_start_date,
      RELEASE_END_DATE: row.release_end_date,
    };
  }

  /** The select shared by the resident view and the coordinator's log. */
  static get LETTER_SELECT() {
    return `
      SELECT
        grl.id AS letter_id,
        CONCAT(r.first_name, ' ', r.last_name) AS resident_name,
        grl.longitudinal_assignment_id,
        grl.rotation_assignment_id,
        rla.site_name,
        rla.day_of_week,
        rla.start_time,
        rla.end_time,
        rla.supervisor_name,
        lct.clinic_name,
        rot.rotation_name,
        re.year_in_program,
        p.program_name,
        p.specialty_name,
        p.institution_name,
        grl.template_id,
        rlt.template_code,
        rlt.template_name,
        rlt.subject_line AS letter_subject,
        grl.recipient_dept_head,
        grl.hospital_department_name,
        grl.supervising_faculty,
        grl.generated_letter_body,
        grl.sent_status,
        grl.sent_at,
        grl.created_at,
        (
          SELECT ri.identifier_value FROM resident_identifiers ri
          WHERE ri.resident_id = r.id AND ri.identifier_type = 'CORPORATE_ID'
          ORDER BY ri.is_primary DESC, ri.id ASC LIMIT 1
        ) AS corporate_id,
        DATE_FORMAT(COALESCE(rla.start_date, rra.start_date), '%Y-%m-%d') AS release_start_date,
        DATE_FORMAT(COALESCE(rla.end_date, rra.end_date), '%Y-%m-%d') AS release_end_date
      FROM generated_release_letters grl
      JOIN residents r ON r.id = grl.resident_id
      JOIN release_letter_templates rlt ON rlt.id = grl.template_id
      LEFT JOIN resident_longitudinal_assignments rla ON rla.id = grl.longitudinal_assignment_id
      LEFT JOIN longitudinal_clinic_types lct ON lct.id = rla.clinic_type_id
      LEFT JOIN resident_rotation_assignments rra ON rra.id = grl.rotation_assignment_id
      LEFT JOIN rotations rot ON rot.id = rra.rotation_id
      LEFT JOIN residency_enrollments re ON re.id = (
        SELECT re2.id FROM residency_enrollments re2
        WHERE re2.resident_id = r.id
        ORDER BY re2.created_at DESC
        LIMIT 1
      )
      LEFT JOIN programs p ON p.id = re.program_id
    `;
  }

  static mapLetterRows(rows) {
    return rows.map((row) => ({
      ...row,
      year_in_program: row.year_in_program ?? null,
      letter_subject: row.letter_subject
        ? this.mergeTemplate(row.letter_subject, this.buildMergeValues(row)).merged
        : row.letter_subject,
    }));
  }

  /**
   * Fetch every generated release letter for a resident.
   *
   * Left joins throughout: a rotation-anchored letter has no clinic row, and an
   * inner join would hide the very letter the resident is meant to present.
   * `letter_subject` is merged on read rather than read from the template: see
   * `buildMergeValues`.
   */
  static async getLettersByResident(residentId) {
    await ensureSchema();
    const [rows] = await db.query(
      `${this.LETTER_SELECT} WHERE grl.resident_id = ? ORDER BY grl.created_at DESC;`,
      [residentId]
    );
    return this.mapLetterRows(rows);
  }

  /**
   * The coordinator's dispatch log: every letter merged from one of the
   * programme's templates, newest first.
   */
  static async getLettersByProgram(programId) {
    await ensureSchema();
    const params = [];
    let where = '';
    if (programId) {
      where = ' WHERE rlt.program_id = ?';
      params.push(programId);
    }
    const [rows] = await db.query(
      `${this.LETTER_SELECT}${where} ORDER BY grl.created_at DESC;`,
      params
    );
    return this.mapLetterRows(rows);
  }

  /**
   * Template CRUD. The subject column is stored as `subject_line` and published
   * as `letter_subject` so clients see one stable field name.
   */

  static async listTemplates(programId) {
    await ensureSchema();
    const params = [];
    let where = '';
    if (programId) {
      where = ' WHERE program_id = ?';
      params.push(programId);
    }
    const [rows] = await db.query(
      `SELECT id, program_id, template_code, template_name,
              subject_line AS letter_subject, letter_body, is_active, created_at, updated_at
       FROM release_letter_templates${where}
       ORDER BY is_active DESC, template_code ASC;`,
      params
    );
    return rows;
  }

  static normalizeTemplateInput(input) {
    const subject = input.subject_line ?? input.letter_subject;
    return {
      program_id: input.program_id,
      template_code: input.template_code,
      template_name: input.template_name,
      subject_line: subject,
      letter_body: input.letter_body,
      is_active: input.is_active === undefined || input.is_active === null
        ? 1
        : Number(input.is_active) === 0 || input.is_active === false
          ? 0
          : 1,
    };
  }

  static assertTemplateComplete(data) {
    const missing = [];
    if (!data.template_code || String(data.template_code).trim() === '') missing.push('template_code');
    if (!data.template_name || String(data.template_name).trim() === '') missing.push('template_name');
    if (!data.subject_line || String(data.subject_line).trim() === '') missing.push('subject_line');
    if (!data.letter_body || String(data.letter_body).trim() === '') missing.push('letter_body');
    if (missing.length > 0) {
      const error = new Error(`Missing required field(s): ${missing.join(', ')}`);
      error.statusCode = 400;
      throw error;
    }
  }

  static async createTemplate(input) {
    await ensureSchema();
    const data = this.normalizeTemplateInput(input);
    if (!data.program_id) data.program_id = 1;
    this.assertTemplateComplete(data);

    try {
      const [result] = await db.query(
        `INSERT INTO release_letter_templates
           (program_id, template_code, template_name, subject_line, letter_body, is_active)
         VALUES (?, ?, ?, ?, ?, ?);`,
        [
          data.program_id,
          String(data.template_code).trim(),
          String(data.template_name).trim(),
          String(data.subject_line).trim(),
          data.letter_body,
          data.is_active,
        ]
      );
      return result.insertId;
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        const dup = new Error(
          `Template code "${data.template_code}" already exists for this programme.`
        );
        dup.statusCode = 409;
        throw dup;
      }
      throw error;
    }
  }

  static async updateTemplate(id, input) {
    await ensureSchema();
    const [existing] = await db.query(
      'SELECT id FROM release_letter_templates WHERE id = ? LIMIT 1;',
      [id]
    );
    if (existing.length === 0) {
      const error = new Error(`Template ${id} was not found`);
      error.statusCode = 404;
      throw error;
    }

    const data = this.normalizeTemplateInput(input);
    const sets = [];
    const params = [];
    for (const [column, value] of [
      ['template_code', data.template_code],
      ['template_name', data.template_name],
      ['subject_line', data.subject_line],
      ['letter_body', data.letter_body],
      ['is_active', data.is_active],
    ]) {
      if (value === undefined || value === null) continue;
      sets.push(`${column} = ?`);
      params.push(value);
    }
    if (sets.length === 0) {
      const error = new Error('No template fields were supplied for update');
      error.statusCode = 400;
      throw error;
    }

    params.push(id);
    try {
      await db.query(
        `UPDATE release_letter_templates SET ${sets.join(', ')} WHERE id = ?;`,
        params
      );
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        const dup = new Error('Template code already exists for this programme.');
        dup.statusCode = 409;
        throw dup;
      }
      throw error;
    }
    return true;
  }

  static async deleteTemplate(id) {
    await ensureSchema();
    const [existing] = await db.query(
      'SELECT id FROM release_letter_templates WHERE id = ? LIMIT 1;',
      [id]
    );
    if (existing.length === 0) {
      const error = new Error(`Template ${id} was not found`);
      error.statusCode = 404;
      throw error;
    }

    try {
      await db.query('DELETE FROM release_letter_templates WHERE id = ?;', [id]);
    } catch (error) {
      if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.errno === 1451) {
        const inUse = new Error(
          'Letters have already been generated from this template. Set it inactive instead — sent letters keep their stored text either way.'
        );
        inUse.statusCode = 409;
        throw inUse;
      }
      throw error;
    }
    return true;
  }

  static async ensureReady() {
    await ensureSchema();
    await ensureDefaultTemplates();
  }
}

ReleaseLetterService.SENT_STATUSES = SENT_STATUSES;
ReleaseLetterService.DEFAULT_TEMPLATE_CODE = DEFAULT_TEMPLATE_CODE;

module.exports = ReleaseLetterService;
