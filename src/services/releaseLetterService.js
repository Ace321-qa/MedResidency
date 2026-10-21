const db = require('../config/db');
const NotificationService = require('./notificationService');

const DEFAULT_TEMPLATE_CODE = 'STANDARD-RELEASE';

/**
 * The rotation-notice template.
 *
 * A second template rather than a rewording of `STANDARD-RELEASE`, because the
 * two are different documents: the release request asks a department to let a
 * resident *out* of service for a recurring weekly clinic, while this one
 * confirms a placement and asks the receiving department to accept the resident
 * *in* for a whole block. Reusing one body for both would mail a department a
 * request it had already agreed to.
 */
const ROTATION_NOTICE_TEMPLATE_CODE = 'STANDARD-ROTATION-NOTICE';

const ROTATION_NOTICE_SUBJECT =
  'Rotation Placement Notice: {{RESIDENT_NAME}} ({{PGY_LEVEL}}) — {{HOSPITAL_DEPT}}';

/**
 * Deliberately written against the tokens `composeLetter` already resolves, so
 * nothing here needs a new merge value. Every token appears at least once, which
 * is what lets the merge's `unresolved` report stand as a real check: a token
 * that is missing from the body can never be reported as missing.
 */
const ROTATION_NOTICE_BODY = `Dear {{DEPT_HEAD_NAME}},

This letter confirms that Dr. {{RESIDENT_NAME}} ({{PGY_LEVEL}}), Corporate ID {{CORPORATE_ID}}, of the {{PROGRAM_NAME}} at {{INSTITUTION_NAME}}, has been scheduled to rotate in your department.

Rotation: {{ROTATION_NAME}}
Receiving department: {{HOSPITAL_DEPT}}
Period: {{RELEASE_START_DATE}} to {{RELEASE_END_DATE}}
Supervising faculty: {{SUPERVISING_FACULTY}}

We would be grateful for your acceptance of this placement for the period above. Should the resident's supervision, accommodation or orientation require any arrangement on your side, please contact the programme office and we will make it promptly.

For your records, the resident may be reached at {{RESIDENT_EMAIL}} or {{RESIDENT_MOBILE}}.

Thank you for your continued support of medical residency education.

Sincerely,
{{COORDINATOR_NAME}}
{{PROGRAM_NAME}}
{{INSTITUTION_NAME}}

Issued {{TODAYS_DATE}}`;

/**
 * How a letter row was produced. The column is written by both flows so a log
 * entry says which action created it; the master-grid notice dispatch is the
 * one this constant names.
 */
const DISPATCH_TYPE_MASTER_GRID = 'FINALIZED_MASTER_GRID';

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

/**
 * The full month names behind `{{TODAYS_DATE}}`, which is formatted the way an
 * institutional letter dates itself: `MMMM DD, YYYY` ("October 17, 2026").
 * Deliberately not the `05 Jul 2026` the app's list rows use — a release letter
 * is a document, and a document does not abbreviate its months.
 */
const LETTER_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Format a stored DATE as `MMMM DD, YYYY` for `{{TODAYS_DATE}}`.
 * Returns null for anything that is not a real calendar date, so the merge
 * reports the token as unresolved instead of printing "undefined".
 */
function formatLetterDate(value) {
  const text = toDateString(value);
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const month = LETTER_MONTHS[Number(match[2]) - 1];
  if (!month) return null;
  return `${month} ${match[3]}, ${match[1]}`;
}

/**
 * Normalise the dispatch date a client supplies for `{{TODAYS_DATE}}`.
 *
 * Absent means "today" — the date the letter is generated/sent, which is
 * deliberately *not* the release start date. A supplied value must be a real
 * `YYYY-MM-DD` calendar day; anything else is a 400 rather than a silent
 * fallback, because a letter dated wrongly is a letter nobody can act on.
 */
function normalizeLetterIssueDate(value) {
  if (value === undefined || value === null || value === '') {
    return toDateString(new Date());
  }
  const text = String(value).trim();
  const error = new Error('letter_issue_date must be a real calendar date in YYYY-MM-DD form.');
  error.statusCode = 400;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw error;
  const [year, month, day] = text.split('-').map(Number);
  const round = new Date(year, month - 1, day);
  if (round.getFullYear() !== year || round.getMonth() !== month - 1 || round.getDate() !== day) {
    throw error;
  }
  return text;
}

/** The first non-blank string among `values`, trimmed, or null. */
function pickName(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * A block's human label for resident-facing copy.
 *
 * Derived from block metadata only — `Block 5` from the stored number, never a
 * rotation name typed into a heading. A run spanning blocks falls back to a
 * neutral phrase rather than naming one of them and being wrong for the rest.
 */
function formatBlockLabel(blockNumber) {
  const parsed = Number(blockNumber);
  if (!Number.isInteger(parsed) || parsed <= 0) return 'the scheduled block';
  return `Block ${parsed}`;
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
 * Add `letter_issue_date DATE DEFAULT CURDATE()` to a letter table.
 *
 * The parenthesised expression default is what MySQL 8.0.13+ and current
 * MariaDB accept; older servers reject it, so the column is retried as a plain
 * nullable column and the same-day default is applied by the backfill below.
 * Either way every row — including the ones already stored — ends up with a
 * real issue date, and the column's own default keeps future inserts correct
 * even if a write path forgets to send one.
 */
async function addLetterIssueDateColumn(table) {
  try {
    await db.query(`ALTER TABLE ${table} ADD COLUMN letter_issue_date DATE NULL DEFAULT (CURDATE());`);
  } catch (error) {
    // Another boot added it first. MySQL/MariaDB report a duplicate column as
    // errno 1060 / SQLSTATE 42S21 with the code `ER_DUP_FIELDNAME` (older
    // wording: `ER_DUP_FIELD`), so all three spellings are accepted — and the
    // run falls through to the idempotent backfill below rather than aborting
    // the whole migration on a second boot.
    const duplicate =
      error.errno === 1060 ||
      error.code === 'ER_DUP_FIELDNAME' ||
      error.code === 'ER_DUP_FIELD';
    if (duplicate) {
      // Column already present — nothing to add.
    } else if (error.errno === 1064 || error.errno === 1067) {
      // 1064 (syntax) / 1067 (invalid default): this server cannot take the
      // expression default, so fall back to nullable + explicit backfill.
      await db.query(`ALTER TABLE ${table} ADD COLUMN letter_issue_date DATE NULL DEFAULT NULL;`);
    } else {
      throw error;
    }
  }

  // Existing letters were issued the day they were created; anything else
  // (a fresh column on a table without rows) resolves to today.
  const fallback =
    table === 'generated_release_letters'
      ? 'COALESCE(DATE(created_at), CURDATE())'
      : 'CURDATE()';
  await db.query(
    `UPDATE ${table} SET letter_issue_date = ${fallback} WHERE letter_issue_date IS NULL;`
  );
}

/** Add a metadata column when it is missing, keeping `columnNames` in sync. */
async function addMetadataColumn(table, columnNames, column, definition, afterColumn) {
  if (columnNames.has(column)) return;
  const after = afterColumn ? ` AFTER ${afterColumn}` : '';
  await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}${after};`);
  columnNames.add(column);
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
  // Dispatch metadata: who signs the letters this template produces, when they
  // are dated, and the preceptor the destination hospital puts in charge. The
  // template copies are defaults — a letter resolves letterData first, the
  // template second, and the programme's own roster last.
  await addLetterIssueDateColumn('release_letter_templates');
  await addMetadataColumn('release_letter_templates', templateNames, 'coordinator_name', 'VARCHAR(255) NULL');
  await addMetadataColumn('release_letter_templates', templateNames, 'program_director_name', 'VARCHAR(255) NULL');
  await addMetadataColumn('release_letter_templates', templateNames, 'destination_supervising_faculty', 'VARCHAR(255) NULL');

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

  // The dispatch/destination metadata a mail-merged letter now carries:
  // `letter_issue_date` is the day the letter was actually issued (today when
  // generated — never the rotation's start date), the two *_name columns are
  // the officials on the dispatching side, and `destination_supervising_faculty`
  // is the preceptor supervising the resident at the *receiving* hospital, kept
  // as its own column so it can never be confused with the programme-side
  // `supervisor_name` of the continuity clinic.
  await addLetterIssueDateColumn('generated_release_letters');
  await addMetadataColumn('generated_release_letters', letterNames, 'coordinator_name', 'VARCHAR(255) NULL');
  await addMetadataColumn('generated_release_letters', letterNames, 'program_director_name', 'VARCHAR(255) NULL');
  await addMetadataColumn(
    'generated_release_letters',
    letterNames,
    'destination_supervising_faculty',
    'VARCHAR(255) NULL',
    'supervising_faculty'
  );

  // Master-grid notice dispatch metadata. `dispatch_type` says which action
  // produced the row (a single clinic release or a whole-block notice run),
  // `recipient_coord_email` is the address the notice was addressed to — kept
  // even when it could not be resolved, so a log entry never implies a recipient
  // that does not exist — and `sent_by_user_id` records who clicked send.
  await addMetadataColumn('generated_release_letters', letterNames, 'dispatch_type', 'VARCHAR(40) NULL');
  await addMetadataColumn('generated_release_letters', letterNames, 'recipient_coord_email', 'VARCHAR(191) NULL');
  await addMetadataColumn(
    'generated_release_letters',
    letterNames,
    'sent_by_user_id',
    'BIGINT UNSIGNED NULL'
  );

  // Letters dispatched before the destination column existed already carry their
  // preceptor in `supervising_faculty`; copy it across so the first read after
  // migration resolves {{SUPERVISING_FACULTY}} for them too.
  if (letterNames.has('supervising_faculty')) {
    await db.query(
      `UPDATE generated_release_letters
       SET destination_supervising_faculty = supervising_faculty
       WHERE destination_supervising_faculty IS NULL
         AND supervising_faculty IS NOT NULL
         AND supervising_faculty <> '';`
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
/**
 * Seed a programme with its standard templates at boot, so a programme created
 * after boot can generate a letter without a coordinator first writing a
 * template from scratch. Matched by (program_id, template_code), exactly like
 * the default-clinic seeder.
 *
 * Seeded per code rather than as one pair: a database that already has
 * STANDARD-RELEASE still needs STANDARD-ROTATION-NOTICE, and re-running must
 * add only the missing one.
 */
const SEEDED_TEMPLATES = [
  {
    code: DEFAULT_TEMPLATE_CODE,
    name: 'Standard Department Release Request Letter',
    subject: DEFAULT_TEMPLATE_SUBJECT,
    body: DEFAULT_TEMPLATE_BODY,
  },
  {
    code: ROTATION_NOTICE_TEMPLATE_CODE,
    name: 'Standard Rotation Placement Notice Letter',
    subject: ROTATION_NOTICE_SUBJECT,
    body: ROTATION_NOTICE_BODY,
  },
];

async function ensureDefaultTemplates() {
  const [programs] = await db.query('SELECT id FROM programs ORDER BY id ASC;');
  if (programs.length === 0) return 0;

  const codes = SEEDED_TEMPLATES.map((template) => template.code);
  const [existing] = await db.query(
    `SELECT program_id, template_code FROM release_letter_templates WHERE template_code IN (?);`,
    [codes]
  );
  const covered = new Set(
    existing.map((row) => `${row.program_id}:${row.template_code}`)
  );
  let seeded = 0;

  for (const program of programs) {
    for (const template of SEEDED_TEMPLATES) {
      if (covered.has(`${program.id}:${template.code}`)) continue;
      await db.query(
        `INSERT INTO release_letter_templates
           (program_id, template_code, template_name, subject_line, letter_body, is_active)
         VALUES (?, ?, ?, ?, ?, 1);`,
        [program.id, template.code, template.name, template.subject, template.body]
      );
      seeded += 1;
    }
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
   * The programme's Program Director, read from the faculty roster — the record
   * that stands in for "program config" when a dispatch does not name one.
   * Matching is prefix-based so both spellings in circulation
   * ("Program Director" and "Program Director (PD)") resolve to the same office,
   * and an Associate PD never wins over the PD.
   */
  static async resolveProgramDirector(programId) {
    if (!programId) return null;
    try {
      const [rows] = await db.query(
        `SELECT CONCAT(first_name, ' ', last_name) AS name
         FROM faculty_supervisors
         WHERE program_id = ?
           AND administrative_role LIKE 'Program Director%'
         ORDER BY (administrative_role = 'Program Director (PD)') DESC, is_active DESC, id ASC
         LIMIT 1;`,
        [programId]
      );
      return pickName(rows[0] && rows[0].name);
    } catch (error) {
      // The roster belongs to another service; its absence must never fail a
      // letter — it only leaves {{PROGRAM_DIRECTOR_NAME}} to be entered by hand.
      return null;
    }
  }

  /**
   * The coordinator dispatching for the programme, from the provisional `users`
   * identity table (there is no auth yet, and the table may not have been
   * created on a fresh database — hence the guard).
   */
  static async resolveProgramCoordinator(programId) {
    if (!programId) return null;
    try {
      const [rows] = await db.query(
        `SELECT full_name
         FROM users
         WHERE role = 'COORDINATOR' AND program_id = ? AND is_active = 1
         ORDER BY updated_at DESC, id ASC
         LIMIT 1;`,
        [programId]
      );
      return pickName(rows[0] && rows[0].full_name);
    } catch (error) {
      return null;
    }
  }

  /**
   * The dispatching programme's display name, for the cross-programme inbox
   * notification ("*Family Medicine* dispatched a rotation notice …"). Null
   * when the programme is unknown — the notification then falls back to a
   * neutral phrase rather than naming the wrong sender.
   */
  static async resolveProgramName(programId) {
    if (!programId) return null;
    try {
      const [rows] = await db.query(
        `SELECT program_name FROM programs WHERE id = ? LIMIT 1;`,
        [programId]
      );
      return pickName(rows[0] && rows[0].program_name);
    } catch (error) {
      return null;
    }
  }

  /**
   * Resolve every value a template can reference. Shared by generation and the
   * live preview, so what the coordinator sees before dispatch is exactly what
   * the letter will contain afterwards.
   */
  static async composeLetter(letterData) {
    // The merge reads the dispatch metadata columns added by `applySchema`, so
    // the schema has to be converged before any query below runs.
    await ensureSchema();

    const {
      resident_id,
      longitudinal_assignment_id,
      rotation_assignment_id,
      template_id,
      template_code,
      recipient_dept_head,
      hospital_department_name,
      supervising_faculty,
      destination_supervising_faculty,
      letter_issue_date,
      coordinator_name,
      program_director_name,
    } = letterData;

    // Today's date, the day the letter is dispatched — never the release start
    // date. Validated here so preview and generate report the same 400.
    const issueDate = normalizeLetterIssueDate(letter_issue_date);

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

    // Who dispatches the letter, in order of authority: what this dispatch
    // supplied, then the template's programme-wide default, then the roster's
    // own record (the faculty member holding the PD office / the coordinator
    // user row for the programme). The destination preceptor is the one value
    // that never falls back to the dispatching side — a supervisor from the
    // wrong hospital is worse than an unfilled token.
    const officialsProgramId =
      context.program_id || (longitudinal ? longitudinal.clinic_program_id : null);
    const coordinatorName =
      pickName(coordinator_name, template.coordinator_name) ??
      (await this.resolveProgramCoordinator(officialsProgramId));
    const programDirectorName =
      pickName(program_director_name, template.program_director_name) ??
      (await this.resolveProgramDirector(officialsProgramId));
    const destinationFaculty = pickName(destination_supervising_faculty, supervising_faculty);

    const merged = this.buildLetterMerge({
      context,
      longitudinal,
      rotation,
      template,
      hospitalDept,
      issueDate,
      recipientDeptHead: recipient_dept_head,
      destinationFaculty,
      coordinatorName,
      programDirectorName,
    });

    return {
      context,
      anchor,
      longitudinal,
      rotation,
      template,
      values: merged.values,
      hospitalDept,
      issueDate,
      coordinatorName,
      programDirectorName,
      destinationFaculty,
      body: merged.body,
      subject: merged.subject,
      unresolved: merged.unresolved,
    };
  }

  /**
   * The merge fields for one letter, given everything already resolved.
   *
   * Split out from `composeLetter` so the bulk dispatch can resolve its shared
   * inputs once (one context query for every resident, one template for the run)
   * and still merge each letter through exactly this code. Preview, single
   * generate and bulk dispatch therefore fill a template identically.
   */
  static buildLetterMerge({
    context,
    longitudinal,
    rotation,
    template,
    hospitalDept,
    issueDate,
    recipientDeptHead,
    destinationFaculty,
    coordinatorName,
    programDirectorName,
  }) {
    const assignmentStart = toDateString(longitudinal ? longitudinal.start_date : rotation.start_date);
    const assignmentEnd = toDateString(longitudinal ? longitudinal.end_date : rotation.end_date);

    const values = {
      TODAYS_DATE: formatLetterDate(issueDate),
      COORDINATOR_NAME: coordinatorName,
      PROGRAM_DIRECTOR_NAME: programDirectorName,
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
      DEPT_HEAD_NAME: recipientDeptHead || null,
      SUPERVISING_FACULTY: destinationFaculty,
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
      values,
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
      recipient_dept_head,
      sent_status,
      regenerate = false,
    } = letterData;

    const composed = await this.composeLetter(letterData);
    const {
      context,
      anchor,
      template,
      values,
      hospitalDept,
      issueDate,
      coordinatorName,
      programDirectorName,
      destinationFaculty,
      body,
      subject,
    } = composed;

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
            destination_supervising_faculty, coordinator_name, program_director_name,
            letter_issue_date, generated_letter_body, sent_status, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          anchor.longitudinal_assignment_id,
          anchor.rotation_assignment_id,
          resident_id,
          template.id,
          recipient_dept_head || 'Head of Department',
          hospitalDept,
          // `supervising_faculty` is the legacy column every list row still
          // reads; `destination_supervising_faculty` is the destination-side
          // spelling the new tokens merge from. One value, both columns.
          destinationFaculty,
          destinationFaculty,
          coordinatorName,
          programDirectorName,
          issueDate,
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
        supervising_faculty: destinationFaculty,
        destination_supervising_faculty: destinationFaculty,
        coordinator_name: coordinatorName,
        program_director_name: programDirectorName,
        letter_issue_date: issueDate,
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
      supervising_faculty: composed.destinationFaculty,
      destination_supervising_faculty: composed.destinationFaculty,
      coordinator_name: composed.coordinatorName,
      program_director_name: composed.programDirectorName,
      letter_issue_date: composed.issueDate,
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
      TODAYS_DATE:
        formatLetterDate(row.letter_issue_date) ??
        formatLetterDate(row.created_at) ??
        formatLetterDate(new Date()),
      COORDINATOR_NAME: row.coordinator_name ?? null,
      PROGRAM_DIRECTOR_NAME: row.program_director_name ?? null,
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
      SUPERVISING_FACULTY: row.destination_supervising_faculty ?? row.supervising_faculty ?? null,
      SUPERVISOR_NAME: row.supervisor_name,
      ROTATION_NAME: row.rotation_name ?? null,
      PROGRAM_NAME: row.program_name,
      SPECIALTY_NAME: row.specialty_name,
      INSTITUTION_NAME: row.institution_name,
      RELEASE_START_DATE: row.release_start_date,
      RELEASE_END_DATE: row.release_end_date,
    };
  }

  /** The select shared by the resident view, the coordinator's sent log and the inbox. */
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
        -- Whose template merged this letter, i.e. which programme dispatched
        -- it. This is the pivot the two-box inbox/sent split turns on: our own
        -- dispatches are the Sent tab, another programme's dispatch addressed
        -- to us is the Inbox.
        rlt.program_id AS dispatching_program_id,
        (SELECT dp.program_name FROM programs dp WHERE dp.id = rlt.program_id) AS dispatching_program_name,
        (SELECT dp.program_code FROM programs dp WHERE dp.id = rlt.program_id) AS dispatching_program_code,
        -- The programme that owns the rotation this letter is anchored to (the
        -- *host* department's programme), and the resident's home programme
        -- from their latest enrolment (the re alias is already resolved below).
        rot.program_id AS host_program_id,
        re.program_id AS resident_program_id,
        grl.dispatch_type,
        grl.recipient_coord_email,
        grl.sent_by_user_id,
        grl.recipient_dept_head,
        grl.hospital_department_name,
        grl.supervising_faculty,
        grl.destination_supervising_faculty,
        grl.coordinator_name,
        grl.program_director_name,
        DATE_FORMAT(
          COALESCE(grl.letter_issue_date, DATE(grl.created_at), CURDATE()),
          '%Y-%m-%d'
        ) AS letter_issue_date,
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
   * The coordinator's letter boxes: what this programme dispatched (Sent), or
   * what arrived here from other programmes (Inbox).
   *
   * - `box: 'sent'` (the default) — every letter merged from one of *this*
   *   programme's templates. The historical behaviour, unchanged.
   * - `box: 'received'` — letters another programme dispatched that concern
   *   this programme. Two situations land here, and both are the same event
   *   seen from the receiving side: a partner programme's rotation notice for
   *   a resident rotating *into* one of our departments (`host_program_id`
   *   is us), or a letter another programme issued about one of *our*
   *   residents (`resident_program_id` is us). The dispatching programme's
   *   name travels with each row so the inbox can say who sent it.
   *
   * A programme's own letters can never appear in its own inbox: the
   * `rlt.program_id <> ?` guard is what keeps the two boxes disjoint.
   *
   * @param {number|null} programId
   * @param {{box?: 'sent'|'received'}} [options]
   */
  static async getLettersByProgram(programId, options = {}) {
    await ensureSchema();
    const box = options.box === 'received' ? 'received' : 'sent';
    const params = [];
    let where = '';
    if (programId) {
      if (box === 'received') {
        where = ` WHERE rlt.program_id <> ?
          AND (rot.program_id = ? OR re.program_id = ?)`;
        params.push(programId, programId, programId);
      } else {
        where = ' WHERE rlt.program_id = ?';
        params.push(programId);
      }
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
              subject_line AS letter_subject, letter_body, is_active,
              coordinator_name, program_director_name, destination_supervising_faculty,
              created_at, updated_at
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
      // Optional programme-wide defaults a letter merges with when its dispatch
      // does not supply its own; blank means "resolve from the roster instead".
      coordinator_name: pickName(input.coordinator_name),
      program_director_name: pickName(input.program_director_name),
      destination_supervising_faculty: pickName(input.destination_supervising_faculty),
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
           (program_id, template_code, template_name, subject_line, letter_body,
            coordinator_name, program_director_name, destination_supervising_faculty, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          data.program_id,
          String(data.template_code).trim(),
          String(data.template_name).trim(),
          String(data.subject_line).trim(),
          data.letter_body,
          data.coordinator_name,
          data.program_director_name,
          data.destination_supervising_faculty,
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
      ['coordinator_name', data.coordinator_name],
      ['program_director_name', data.program_director_name],
      ['destination_supervising_faculty', data.destination_supervising_faculty],
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

  /**
   * The assignments a master-grid notice run would cover.
   *
   * Scoped by block or explicit window, and always by programme. "Finalized" is
   * a property of the block, not of the assignment, so it is carried on the
   * block row and returned here rather than filtered silently — the caller needs
   * to see which blocks are draft to say so, not to be handed an empty list.
   */
  static async listNoticeTargets({ block_id, start_date, end_date, academic_year, program_id }) {
    await ensureSchema();
    const params = [program_id];
    let scope = '';

    if (block_id) {
      scope = ' AND rb.id = ?';
      params.push(block_id);
    } else if (start_date && end_date) {
      // Overlap, not containment: a block that straddles the window still has
      // residents on service inside it, and omitting it would silently drop
      // notices for exactly the weeks the coordinator was looking at.
      scope = ' AND rra.start_date <= ? AND rra.end_date >= ?';
      params.push(end_date, start_date);
    } else if (academic_year) {
      scope = ' AND rb.academic_year = ?';
      params.push(academic_year);
    }

    const [rows] = await db.query(
      `SELECT
         rra.id AS rotation_assignment_id,
         rra.resident_id,
         CONCAT(r.first_name, ' ', r.last_name) AS resident_name,
         re.year_in_program,
         rot.id AS rotation_id,
         rot.rotation_name,
         rot.department_name,
         rb.id AS block_id,
         rb.block_number,
         rb.block_name,
         rb.academic_year,
         rb.is_finalized,
         DATE_FORMAT(rra.start_date, '%Y-%m-%d') AS start_date,
         DATE_FORMAT(rra.end_date, '%Y-%m-%d') AS end_date
       FROM resident_rotation_assignments rra
       JOIN rotations rot ON rot.id = rra.rotation_id
       JOIN rotation_blocks rb ON rb.id = rra.rotation_block_id
       JOIN residents r ON r.id = rra.resident_id
       LEFT JOIN residency_enrollments re ON re.resident_id = rra.resident_id
       WHERE rb.program_id = ?
         AND rot.department_name IS NOT NULL
         AND rot.department_name <> ''
         ${scope}
       ORDER BY rb.block_number ASC, rot.department_name ASC, r.last_name ASC, r.first_name ASC;`,
      params
    );

    return rows;
  }

  /**
   * Compose every notice a run would produce, without writing anything.
   *
   * Shared by the dispatch and the confirmation preview so the dialog's counts
   * and departments are the ones the send will actually act on — a summary
   * computed separately from the send is a summary that can lie.
   */
  static async planRotationNotices({ block_id, start_date, end_date, academic_year, program_id }) {
    await ensureSchema();

    const targets = await this.listNoticeTargets({
      block_id,
      start_date,
      end_date,
      academic_year,
      program_id,
    });

    const recipients = await this.resolveDepartmentRecipients(program_id);
    const departments = new Map();
    const residents = new Map();

    for (const target of targets) {
      const key = String(target.department_name);
      if (!departments.has(key)) {
        const contact = recipients.get(key) || null;
        departments.set(key, {
          department_name: key,
          resident_count: 0,
          block_numbers: new Set(),
          recipient_coord_email: contact ? contact.email : null,
          recipient_coord_name: contact ? contact.name : null,
          // Said out loud rather than left blank: a notice with no address is
          // stored, not sent, and the coordinator should know that before
          // dispatching a run they believe reaches the department.
          has_recipient: Boolean(contact && contact.email),
        });
      }
      const department = departments.get(key);
      department.resident_count += 1;
      if (target.block_number !== null && target.block_number !== undefined) {
        department.block_numbers.add(target.block_number);
      }

      if (!residents.has(target.resident_id)) {
        residents.set(target.resident_id, {
          resident_id: target.resident_id,
          resident_name: target.resident_name,
          pgy_level: target.year_in_program ? `PGY-${target.year_in_program}` : null,
          assignment_count: 0,
        });
      }
      residents.get(target.resident_id).assignment_count += 1;
    }

    const departmentList = [...departments.values()].map((department) => ({
      ...department,
      block_numbers: [...department.block_numbers].sort((a, b) => a - b),
    }));

    return {
      targets,
      departments: departmentList,
      residents: [...residents.values()],
      block_ids: [...new Set(targets.map((target) => target.block_id))],
      finalized_block_ids: [
        ...new Set(targets.filter((target) => Number(target.is_finalized) === 1).map((t) => t.block_id)),
      ],
      draft_block_ids: [
        ...new Set(targets.filter((target) => Number(target.is_finalized) !== 1).map((t) => t.block_id)),
      ],
      template_code: ROTATION_NOTICE_TEMPLATE_CODE,
    };
  }

  /**
   * Department name → the coordinator who receives that department's notices.
   *
   * There is no department-contact table: `rotations.department_name` is free
   * text and nothing owns it. Rather than invent a recipient, this reads the
   * programme's `users` rows for a coordinator whose name matches the
   * department by prefix and who has an email on file. When nothing matches, the
   * department is reported as having no recipient instead of being sent to a
   * guessed address.
   */
  static async resolveDepartmentRecipients(programId) {
    const contacts = new Map();
    if (!programId) return contacts;
    try {
      const [rows] = await db.query(
        `SELECT full_name, email
         FROM users
         WHERE role = 'COORDINATOR' AND program_id = ? AND is_active = 1
           AND email IS NOT NULL AND email <> '';`,
        [programId]
      );
      for (const row of rows) {
        contacts.set(String(row.full_name).trim().toLowerCase(), {
          name: row.full_name,
          email: row.email,
        });
      }
    } catch (error) {
      // The identity table belongs to another service; its absence only means no
      // department resolves a recipient, which `planRotationNotices` reports.
      return contacts;
    }
    return contacts;
  }

  /**
   * Dispatch rotation notices for a block or window.
   *
   * One letter per resident-assignment is composed from the notice template and
   * stored in `generated_release_letters` with `dispatch_type`
   * FINALIZED_MASTER_GRID — the log the Release Letters screen already reads, so
   * a notice shows up wherever a coordinator expects to find letters.
   *
   * The letter rows commit together: a run that half-wrote would leave a
   * department holding a notice for a placement it was never told about.
   */
  static async dispatchRotationNotices({
    block_id,
    start_date,
    end_date,
    academic_year,
    program_id,
    template_code,
    send_to_coordinators = true,
    notify_residents = true,
    sent_by_user_id = null,
    recipient_dept_head = null,
    coordinator_name = null,
    program_director_name = null,
    regenerate = false,
  } = {}) {
    if (!program_id) {
      const error = new Error('program_id is required to dispatch rotation notices.');
      error.statusCode = 400;
      throw error;
    }
    if (!block_id && !(start_date && end_date) && !academic_year) {
      const error = new Error(
        'A dispatch needs a block_id, an explicit start_date and end_date, or an academic_year.'
      );
      error.statusCode = 400;
      throw error;
    }

    const plan = await this.planRotationNotices({
      block_id,
      start_date,
      end_date,
      academic_year,
      program_id,
    });

    const code = template_code || ROTATION_NOTICE_TEMPLATE_CODE;

    // Everything below is resolved for the whole run at once. A hundred letters
    // that each opened their own six round trips took tens of seconds and blew
    // the request timeout, so the dispatch reads its shared inputs in a handful
    // of batched queries and merges each letter in memory.
    const prepared = await this.prepareNoticeLetters(plan, code, {
      program_id,
      recipient_dept_head,
      coordinator_name,
      program_director_name,
      regenerate,
    });

    const { letters, skipped } = prepared;

    const connection = await db.getConnection();
    const stored = [];
    const notified = [];

    try {
      await connection.beginTransaction();

      // One multi-row INSERT for the whole run, then one UPDATE to revoke the
      // letters this run supersedes. Both inside the single transaction, so a
      // run either lands entirely or not at all.
      const insertedIds = await this.insertNoticeLetters(connection, letters, {
        sent_by_user_id,
        headName: recipient_dept_head || 'Head of Department',
      });
      await this.revokeSupersededLetters(connection, letters);

      letters.forEach((letter, index) => {
        const { target, composed } = letter;
        stored.push({
          letter_id: insertedIds[index],
          resident_id: target.resident_id,
          resident_name: target.resident_name,
          pgy_level: target.year_in_program ? `PGY-${target.year_in_program}` : null,
          rotation_assignment_id: composed.anchor.rotation_assignment_id,
          rotation_name: target.rotation_name,
          hospital_department_name: composed.hospitalDept,
          block_id: target.block_id,
          block_number: target.block_number,
          release_start_date: composed.values.RELEASE_START_DATE,
          release_end_date: composed.values.RELEASE_END_DATE,
          recipient_coord_email: letter.recipient_coord_email,
          has_recipient: letter.has_recipient,
          sent_status: 'SENT',
          dispatched_to_coordinator: send_to_coordinators,
          unresolved_placeholders: composed.unresolved,
        });
      });

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    // Resident notifications are deliberately outside the transaction: they are
    // a courtesy to the resident, and a notification that could not be written
    // must never roll back letters a department has already been sent. They go
    // through the bulk safe path so a whole-block run is three round trips, not
    // three per resident.
    if (notify_residents && stored.length > 0) {
      const written = await NotificationService.notifyResidentsSafe(
        stored.map((letter) => {
          const blockLabel = formatBlockLabel(letter.block_number);
          return {
            resident_id: letter.resident_id,
            resident_name: letter.resident_name,
            title: 'New Rotation Schedule Finalized',
            message:
              `You have been assigned to ${letter.rotation_name} in ` +
              `${letter.hospital_department_name} for ${blockLabel} ` +
              `(${letter.release_start_date} to ${letter.release_end_date}).`,
            type: 'ROTATION_APPROVAL',
            reference_id: letter.rotation_assignment_id,
            reference_type: 'ROTATION_ASSIGNMENT',
          };
        })
      );
      notified.push(...written);
    }

    // Cross-programme inbox routing. A notice run may cover residents who
    // belong to *another* programme and are rotating into one of ours — the
    // Family Medicine coordinator finalizing Block 6 for a resident posted to
    // Internal Medicine Inpatient Wards. The host programme's coordinator is
    // told the dispatch happened, with the wording the Letters inbox mirrors,
    // so the receiving side has the letter in its inbox *and* a notification
    // pointing at it.
    //
    // Deliberately outside the transaction and best-effort, exactly like the
    // resident notifications: the letters are already committed, and a
    // notification that cannot be delivered must never fail the dispatch.
    const coordinatorsNotified = [];
    if (send_to_coordinators && letters.length > 0) {
      const dispatchingProgramName = await this.resolveProgramName(program_id);
      const seen = new Set();
      for (let index = 0; index < letters.length; index += 1) {
        const letter = letters[index];
        const hostProgramId = letter.host_program_id ? Number(letter.host_program_id) : null;
        // Internal postings reuse the same letters but are not a cross-
        // programme event: the host is the sender, so there is no inbox on
        // the other side to route to.
        if (!hostProgramId || hostProgramId === Number(program_id)) continue;
        // One notification per resident per host programme, not per letter:
        // a split block produces several letters for the same person and the
        // coordinator must not receive the same arrival several times.
        const dedupeKey = `${hostProgramId}:${stored[index]?.resident_id ?? letter.target.resident_id}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const storedLetter = stored[index];
        const pgy = letter.target.year_in_program ? `PGY-${letter.target.year_in_program}` : null;
        const blockLabel = formatBlockLabel(letter.target.block_number);
        const department = storedLetter?.hospital_department_name || letter.target.department_name || null;
        const home = dispatchingProgramName || 'A partner programme';

        const notification = await NotificationService.notifyProgramCoordinatorSafe(hostProgramId, {
          type: 'ROTATION_APPROVAL',
          title: 'Incoming Rotation Acceptance Notice',
          message:
            `📩 ${home} dispatched a rotation notice for Dr. ${letter.target.resident_name}` +
            `${pgy ? ` (${pgy})` : ''} for ${blockLabel}` +
            `${department ? ` (${department})` : ''}.`,
          reference_id: storedLetter?.letter_id ?? letter.target.rotation_assignment_id,
          reference_type: 'generated_release_letters',
        });
        if (notification) {
          coordinatorsNotified.push({
            host_program_id: hostProgramId,
            host_program_name: letter.host_program_name,
            resident_id: letter.target.resident_id,
            resident_name: letter.target.resident_name,
            notification_id: notification.id ?? null,
          });
        }
      }
    }

    return {
      program_id,
      template_code: code,
      dispatch_type: DISPATCH_TYPE_MASTER_GRID,
      sent_by_user_id,
      block_ids: plan.block_ids,
      finalized_block_ids: plan.finalized_block_ids,
      draft_block_ids: plan.draft_block_ids,
      send_to_coordinators,
      notify_residents,
      departments: plan.departments,
      letters: stored,
      letters_sent: stored.length,
      letters_without_recipient: stored.filter((letter) => !letter.has_recipient).length,
      residents_notified: notified.length,
      notifications: notified,
      // Cross-programme arrivals, so the dispatch summary can say how many
      // partner programmes were told their visiting resident is expected.
      coordinators_notified: coordinatorsNotified.length,
      cross_program_notices: coordinatorsNotified,
      skipped,
    };
  }

  /**
   * Resolve and merge every letter in a dispatch without touching the database.
   *
   * This is the batched replacement for the old per-target `composeLetter` +
   * `findExistingLetter` loop: instead of ~6 round trips per letter it reads the
   * residents, the rotation assignments, the template, the officials and the
   * existing letters in a fixed number of queries, then merges each letter with
   * the same `buildLetterMerge` the single-letter path uses.
   */
  static async prepareNoticeLetters(plan, templateCode, options = {}) {
    const {
      program_id,
      recipient_dept_head,
      coordinator_name,
      program_director_name,
      regenerate = false,
    } = options;

    const targets = plan.targets.filter((target) => target.rotation_assignment_id);
    const recipientsByDepartment = new Map(
      plan.departments.map((department) => [
        department.department_name,
        { has_recipient: department.has_recipient, email: department.recipient_coord_email },
      ])
    );

    if (targets.length === 0) return { letters: [], skipped: [] };

    const residentIds = [...new Set(targets.map((target) => target.resident_id))];
    const rotationAssignmentIds = [...new Set(targets.map((target) => target.rotation_assignment_id))];

    // The programme is the same for every letter in a notice run, so the
    // template and the two officials resolve once rather than per letter.
    const template = await this.getTemplate(program_id || null, {
      template_code: templateCode,
    });
    const [coordinatorResolved, directorResolved] = await Promise.all([
      pickName(coordinator_name, template.coordinator_name)
        ? Promise.resolve(pickName(coordinator_name, template.coordinator_name))
        : this.resolveProgramCoordinator(program_id || null),
      pickName(program_director_name, template.program_director_name)
        ? Promise.resolve(pickName(program_director_name, template.program_director_name))
        : this.resolveProgramDirector(program_id || null),
    ]);

    const [contexts, rotations, existingByAssignment] = await Promise.all([
      this.loadResidentMergeContexts(residentIds),
      this.loadRotationAssignments(rotationAssignmentIds),
      // Existing letters are always loaded: a regenerate run needs them to
      // revoke the letter it supersedes, exactly as the singular path does.
      this.findExistingLetters(rotationAssignmentIds, template.id),
    ]);

    const issueDate = normalizeLetterIssueDate();
    const headName = recipient_dept_head || 'Head of Department';
    const letters = [];
    const skipped = [];

    for (const target of targets) {
      const context = contexts.get(target.resident_id);
      if (!context) {
        skipped.push({
          rotation_assignment_id: target.rotation_assignment_id,
          resident_id: target.resident_id,
          resident_name: target.resident_name,
          reason: `Resident ${target.resident_id} not found`,
        });
        continue;
      }

      const rotation = rotations.get(target.rotation_assignment_id);
      if (!rotation) {
        skipped.push({
          rotation_assignment_id: target.rotation_assignment_id,
          resident_id: target.resident_id,
          resident_name: target.resident_name,
          reason: `Rotation assignment ${target.rotation_assignment_id} was not found for resident ${target.resident_id}`,
        });
        continue;
      }

      const anchor = {
        longitudinal_assignment_id: null,
        rotation_assignment_id: rotation.rotation_assignment_id,
      };
      const existing = existingByAssignment.get(target.rotation_assignment_id) || null;
      if (existing && !regenerate) {
        skipped.push({
          rotation_assignment_id: target.rotation_assignment_id,
          resident_id: target.resident_id,
          resident_name: target.resident_name,
          reason: `A notice already exists for this assignment (letter ${existing.id}).`,
          existing_letter_id: existing.id,
        });
        continue;
      }

      const hospitalDept =
        target.department_name || rotation.department_name || context.specialty_name || null;
      // A notice names no destination preceptor. The old per-letter path passed
      // neither `destination_supervising_faculty` nor `supervising_faculty`, so
      // both columns were null; the notice asks the department to accept the
      // resident, it does not name who will teach them.
      const destinationFaculty = null;

      const merged = this.buildLetterMerge({
        context,
        longitudinal: null,
        rotation,
        template,
        hospitalDept,
        issueDate,
        recipientDeptHead: headName,
        destinationFaculty,
        coordinatorName: coordinatorResolved,
        programDirectorName: directorResolved,
      });

      const recipient = recipientsByDepartment.get(String(target.department_name)) || {};

      letters.push({
        target,
        existing,
        recipient_coord_email: recipient.email || null,
        has_recipient: Boolean(recipient.has_recipient),
        // Which programme receives this letter's resident. Kept on the letter
        // (not re-derived at dispatch time) so the cross-programme inbox
        // notification can route per letter without another query.
        host_program_id: rotation.host_program_id ?? null,
        host_program_name: rotation.host_program_name ?? null,
        composed: {
          anchor,
          template,
          hospitalDept,
          issueDate,
          coordinatorName: coordinatorResolved,
          programDirectorName: directorResolved,
          destinationFaculty,
          values: merged.values,
          body: merged.body,
          subject: merged.subject,
          unresolved: merged.unresolved,
        },
      });
    }

    return { letters, skipped };
  }

  /** Every resident's merge context, in one query. */
  static async loadResidentMergeContexts(residentIds) {
    const contexts = new Map();
    if (residentIds.length === 0) return contexts;

    const [rows] = await db.query(
      `SELECT
         r.id AS resident_id,
         r.first_name,
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
       WHERE r.id IN (?)
       ORDER BY re.created_at DESC;`,
      [residentIds]
    );

    for (const row of rows) {
      // `ORDER BY re.created_at DESC` means the first row seen for a resident is
      // the most recent enrolment — the same one the single-resident lookup
      // would have picked.
      if (contexts.has(row.resident_id)) continue;
      contexts.set(row.resident_id, {
        resident_id: row.resident_id,
        resident_name: [row.first_name, row.last_name].filter(Boolean).join(' '),
        pgy_level: row.year_in_program ? `PGY-${row.year_in_program}` : null,
        corporate_id: row.corporate_id || null,
        resident_email: row.resident_email || null,
        resident_mobile: row.resident_mobile || null,
        program_id: row.program_id || null,
        program_name: row.program_name || null,
        specialty_name: row.specialty_name || null,
        institution_name: row.institution_name || null,
      });
    }

    return contexts;
  }

  /** Every rotation assignment named by a run, in one query. */
  static async loadRotationAssignments(rotationAssignmentIds) {
    const assignments = new Map();
    if (rotationAssignmentIds.length === 0) return assignments;

    const [rows] = await db.query(
      `SELECT
         rra.id AS rotation_assignment_id,
         rra.resident_id,
         rra.start_date,
         rra.end_date,
         rra.notes,
         rot.rotation_name,
         rot.department_name,
         -- The programme that owns the rotation, i.e. the *receiving* side of
         -- a cross-programme posting. Dispatch uses it to route the inbox
         -- notification to the host coordinator; a rotation with no owning
         -- programme simply reports null and routes nothing.
         rot.program_id AS host_program_id,
         (SELECT hp.program_name FROM programs hp WHERE hp.id = rot.program_id) AS host_program_name
       FROM resident_rotation_assignments rra
       JOIN rotations rot ON rot.id = rra.rotation_id
       WHERE rra.id IN (?);`,
      [rotationAssignmentIds]
    );

    for (const row of rows) assignments.set(row.rotation_assignment_id, row);
    return assignments;
  }

  /**
   * The live letter for each assignment in a run, in one query.
   *
   * The single-letter `findExistingLetter` matches on the rotation anchor only
   * when the letter is anchored to a rotation, which every notice is, so the set
   * form is the same test asked once for the whole run.
   */
  static async findExistingLetters(rotationAssignmentIds, templateId) {
    const existing = new Map();
    if (rotationAssignmentIds.length === 0) return existing;

    const [rows] = await db.query(
      `SELECT id, rotation_assignment_id, sent_status
       FROM generated_release_letters
       WHERE rotation_assignment_id IN (?) AND template_id = ?
         AND sent_status IN (?)
       ORDER BY id ASC;`,
      [rotationAssignmentIds, templateId, LIVE_SENT_STATES]
    );

    for (const row of rows) {
      if (!existing.has(row.rotation_assignment_id)) existing.set(row.rotation_assignment_id, row);
    }
    return existing;
  }

  /**
   * Insert every prepared letter in as few statements as possible.
   *
   * Chunked rather than one statement per row: MySQL caps a statement's
   * placeholders, and a run of a few hundred rows would otherwise exceed it.
   */
  static async insertNoticeLetters(connection, letters, { sent_by_user_id = null, headName = 'Head of Department' } = {}) {
    const insertedIds = [];
    if (letters.length === 0) return insertedIds;

    const COLUMNS = 16;
    const chunkSize = Math.max(1, Math.floor(60000 / COLUMNS));

    for (let start = 0; start < letters.length; start += chunkSize) {
      const chunk = letters.slice(start, start + chunkSize);
      const values = [];
      const placeholders = [];

      for (const letter of chunk) {
        const { target, composed, recipient_coord_email } = letter;
        placeholders.push(`(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, ?, ?, ?)`);
        values.push(
          composed.anchor.rotation_assignment_id,
          target.resident_id,
          composed.template.id,
          headName,
          composed.hospitalDept,
          composed.destinationFaculty,
          composed.destinationFaculty,
          composed.coordinatorName,
          composed.programDirectorName,
          composed.issueDate,
          composed.body.merged,
          new Date(),
          DISPATCH_TYPE_MASTER_GRID,
          recipient_coord_email,
          sent_by_user_id
        );
      }

      const [result] = await connection.query(
        `INSERT INTO generated_release_letters
           (rotation_assignment_id, resident_id, template_id,
            recipient_dept_head, hospital_department_name, supervising_faculty,
            destination_supervising_faculty, coordinator_name, program_director_name,
            letter_issue_date, generated_letter_body, sent_status, sent_at,
            dispatch_type, recipient_coord_email, sent_by_user_id)
         VALUES ${placeholders.join(', ')};`,
        values
      );

      // MySQL hands back the first auto-increment id and the count; the chunk is
      // contiguous, so every id follows from those two numbers.
      const first = result.insertId;
      for (let index = 0; index < chunk.length; index += 1) insertedIds.push(first + index);
    }

    return insertedIds;
  }

  /**
   * Revoke the letters this run supersedes, in one statement.
   *
   * Superseding is a takeover, not a second live letter: the row being replaced
   * loses its SENT/DELIVERED state so the department is only ever asked to act
   * on the newest version.
   */
  static async revokeSupersededLetters(connection, letters) {
    const ids = letters
      .map((letter) => letter.existing && letter.existing.id)
      .filter((id) => id !== null && id !== undefined);
    if (ids.length === 0) return;

    await connection.query(
      `UPDATE generated_release_letters SET sent_status = 'REVOKED' WHERE id IN (?);`,
      [ids]
    );
  }

  static async ensureReady() {
    await ensureSchema();
    await ensureDefaultTemplates();
  }
}

ReleaseLetterService.SENT_STATUSES = SENT_STATUSES;
ReleaseLetterService.DEFAULT_TEMPLATE_CODE = DEFAULT_TEMPLATE_CODE;
ReleaseLetterService.ROTATION_NOTICE_TEMPLATE_CODE = ROTATION_NOTICE_TEMPLATE_CODE;
ReleaseLetterService.DISPATCH_TYPE_MASTER_GRID = DISPATCH_TYPE_MASTER_GRID;

module.exports = ReleaseLetterService;
