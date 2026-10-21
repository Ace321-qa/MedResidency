const db = require('../config/db');
const ProgramConnectionService = require('../services/programConnectionService');

/**
 * Programmes — the registry of residency programmes the platform serves.
 *
 * Until now the platform had no way to add or rename a programme: `programs`
 * was seeded by hand, and the sign-in picker could only list the programmes it
 * could *infer* from whichever residents a roster page happened to contain. A
 * programme with no enrolled residents — a brand-new one, or one whose residents
 * have all graduated — simply disappeared from the picker. This endpoint makes
 * the programmes table the source of truth: programmes are listed whether or not
 * anyone is enrolled, and the enrolled count is reported alongside rather than
 * inferred.
 *
 * Deletion follows the same safety rule as the rotations catalogue: a programme
 * with enrolled residents is never hard-deleted behind their backs. It is
 * deactivated instead (`is_active = 0`), which removes it from the sign-in
 * picker while leaving every roster, rotation and letter intact — so the answer
 * to "delete this programme" is never "and also lose six residents' history".
 */

const FIELD_LIMITS = {
  program_code: 50,
  program_name: 255,
  specialty_name: 255,
  institution_name: 255,
  coordinator_email: 255,
};

const FIELD_LABELS = {
  program_code: 'Programme code',
  program_name: 'Programme name',
  specialty_name: 'Specialty',
  institution_name: 'Institution',
  coordinator_email: 'Coordinator email',
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let schemaReady = false;

/**
 * Bring the `programs` table up to the shape this CRUD relies on.
 *
 * The table predates this endpoint, so the first job is to make it accept a
 * create that carries only a name and a code — the two fields the form asks for.
 * Older installs declared the descriptive columns `NOT NULL` with no default, so
 * they are relaxed to nullable here. The DDL is idempotent and best-effort: if
 * the database user has no DDL rights the code still works, because the insert
 * supplies the descriptive columns itself (see `normaliseProgram`).
 */
async function ensureProgramSchema() {
  if (schemaReady) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS programs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      program_code VARCHAR(50) NOT NULL,
      program_name VARCHAR(255) NOT NULL,
      specialty_name VARCHAR(255) NULL,
      institution_name VARCHAR(255) NULL,
      country_code CHAR(2) NULL,
      accrediting_body VARCHAR(100) NULL,
      training_years DECIMAL(4,2) NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      week_start_day ENUM('SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY')
        NOT NULL DEFAULT 'SUNDAY',
      academic_year_start_month INT UNSIGNED NOT NULL DEFAULT 7,
      default_block_duration_weeks INT UNSIGNED NOT NULL DEFAULT 4,
      standard_shift_hours DECIMAL(4,2) NOT NULL DEFAULT 7.00,
      coordinator_email VARCHAR(255) NOT NULL DEFAULT 'coordinator@medresidency.org',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_programs_code (program_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  for (const clause of [
    'MODIFY COLUMN specialty_name VARCHAR(255) NULL',
    'MODIFY COLUMN institution_name VARCHAR(255) NULL',
    'MODIFY COLUMN country_code CHAR(2) NULL',
  ]) {
    try {
      await db.query(`ALTER TABLE programs ${clause}`);
    } catch (error) {
      console.warn(`[programs] could not relax "${clause}": ${error.message}`);
    }
  }

  try {
    const [columns] = await db.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'programs' AND COLUMN_NAME = 'coordinator_email'`
    );
    if (columns.length === 0) {
      await db.query(
        "ALTER TABLE programs ADD COLUMN coordinator_email VARCHAR(255) NOT NULL DEFAULT 'coordinator@medresidency.org'"
      );
    } else {
      try {
        await db.query(
          "ALTER TABLE programs MODIFY COLUMN coordinator_email VARCHAR(255) NOT NULL DEFAULT 'coordinator@medresidency.org'"
        );
      } catch (error) {
        console.warn(`[programs] could not modify coordinator_email: ${error.message}`);
      }
    }
  } catch (error) {
    console.warn(`[programs] could not ensure coordinator_email: ${error.message}`);
  }

  try {
    await db.query(
      "UPDATE programs SET coordinator_email = 'fm.coordinator@medresidency.org' WHERE (coordinator_email IS NULL OR coordinator_email = '' OR coordinator_email = 'coordinator@medresidency.org') AND (LOWER(program_name) LIKE '%family%' OR LOWER(program_code) LIKE '%fm%' OR LOWER(specialty_name) LIKE '%family%')"
    );
    await db.query(
      "UPDATE programs SET coordinator_email = 'im.coordinator@medresidency.org' WHERE (coordinator_email IS NULL OR coordinator_email = '' OR coordinator_email = 'coordinator@medresidency.org') AND (LOWER(program_name) LIKE '%internal%' OR LOWER(program_code) LIKE '%im%' OR LOWER(specialty_name) LIKE '%internal%')"
    );
    await db.query(
      "UPDATE programs SET coordinator_email = 'peds.coordinator@medresidency.org' WHERE (coordinator_email IS NULL OR coordinator_email = '' OR coordinator_email = 'coordinator@medresidency.org') AND (LOWER(program_name) LIKE '%pediatric%' OR LOWER(program_code) LIKE '%ped%' OR LOWER(specialty_name) LIKE '%pediatric%')"
    );
  } catch (error) {
    console.warn(`[programs] could not backfill coordinator emails: ${error.message}`);
  }

  schemaReady = true;
}

/**
 * A programme plus the number of residents actively enrolled in it.
 *
 * The count is a correlated subquery rather than a JOIN + GROUP BY: with an
 * outer join a programme nobody is enrolled in still reports one row, and the
 * `GROUP BY` shape depends on `ONLY_FULL_GROUP_BY` being off to keep the
 * non-aggregated columns — a setting this project's managed database does not
 * promise. `LIKE 'ACTIVE%'` folds `ACTIVE_FULL_TIME` and `ACTIVE_PART_TIME`
 * together and excludes leave, off-cycle and graduated residents, which is what
 * "active resident count" means here.
 */
const PROGRAM_COLUMNS = `
  p.id,
  p.program_code,
  p.program_name,
  p.specialty_name,
  p.institution_name,
  p.coordinator_email,
  p.is_active,
  p.created_at,
  p.updated_at,
  (
    SELECT COUNT(*)
      FROM residency_enrollments re
     WHERE re.program_id = p.id
       AND re.resident_status LIKE 'ACTIVE%'
  ) AS resident_count
`;

async function findProgram(id) {
  const [rows] = await db.query(
    `SELECT ${PROGRAM_COLUMNS} FROM programs p WHERE p.id = ?`,
    [id],
  );
  return rows[0] ?? null;
}

function parseId(raw) {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Trim and validate a programme payload.
 *
 * `partial` is the shape an edit form needs: absent fields are ignored so
 * renaming a programme does not demand re-sending its code — but a field that is
 * *present and blank* is still an error, because "clear the name" is not a valid
 * update.
 */
function normalizeProgram(input, options = {}) {
  const partial = options.partial === true;
  const values = {};
  const errors = [];

  for (const field of ['program_name', 'program_code', 'specialty_name', 'institution_name', 'coordinator_email']) {
    const present = Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined;
    if (!present) {
      if (!partial && (field === 'program_name' || field === 'program_code' || field === 'coordinator_email')) {
        errors.push(field === 'coordinator_email' ? 'Coordinator email is required.' : `${FIELD_LABELS[field]} is required`);
      }
      continue;
    }

    const text = String(input[field] ?? '').trim();
    const normalized = field === 'program_code' ? text.toUpperCase() : text.toLowerCase();

    if (text === '' && (field === 'program_name' || field === 'program_code' || field === 'coordinator_email')) {
      errors.push(field === 'coordinator_email' ? 'Coordinator email is required.' : `${FIELD_LABELS[field]} is required`);
      continue;
    }
    if (text.length > FIELD_LIMITS[field]) {
      errors.push(`${FIELD_LABELS[field]} must be ${FIELD_LIMITS[field]} characters or fewer`);
      continue;
    }

    if (field === 'coordinator_email') {
      if (!EMAIL_REGEX.test(normalized)) {
        errors.push('A valid coordinator email is required.');
        continue;
      }
      values[field] = normalized;
      continue;
    }

    values[field] = text === '' ? null : normalized;
  }

  if (Object.prototype.hasOwnProperty.call(input, 'is_active') && input.is_active !== undefined) {
    values.is_active = input.is_active === true || input.is_active === 1 || input.is_active === '1' ? 1 : 0;
  }

  return { values, errors };
}

class ProgramController {
  /** `GET /programs[?active=true]` — every programme, with its resident count. */
  static async getPrograms(req, res) {
    try {
      await ensureProgramSchema();

      const wantsActiveOnly = ['true', '1', 'yes'].includes(
        String(req.query.active ?? '').toLowerCase(),
      );

      const [rows] = await db.query(
        `SELECT ${PROGRAM_COLUMNS}
           FROM programs p
          ${wantsActiveOnly ? 'WHERE p.is_active = 1' : ''}
          ORDER BY p.is_active DESC, p.program_name ASC, p.id ASC`,
      );
      return res.status(200).json({ success: true, count: rows.length, data: rows });
    } catch (error) {
      console.error('Error in getPrograms controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'The programmes could not be loaded', details: error.message });
    }
  }

  /** `POST /programs` — register a new residency programme. */
  static async createProgram(req, res) {
    try {
      await ensureProgramSchema();

      const { values, errors } = normalizeProgram(req.body ?? {});
      if (errors.length > 0) {
        return res.status(400).json({ success: false, error: errors.join('; ') });
      }

      const [result] = await db.query(
        `INSERT INTO programs
           (program_code, program_name, specialty_name, institution_name, country_code, is_active, coordinator_email)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          values.program_code,
          values.program_name,
          values.specialty_name ?? values.program_name,
          values.institution_name ?? null,
          normalizeCountry(req.body?.country_code),
          values.is_active ?? 1,
          values.coordinator_email,
        ],
      );

      const created = await findProgram(result.insertId);
      return res.status(201).json({
        success: true,
        message: `Programme "${values.program_name}" created`,
        data: created,
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          success: false,
          error: `The programme code "${req.body?.program_code ?? ''}" is already in use. Codes must be unique.`,
        });
      }
      console.error('Error in createProgram controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'The programme could not be created', details: error.message });
    }
  }

  /** `PUT /programs/:id` — rename a programme, change its code, or activate/deactivate it. */
  static async updateProgram(req, res) {
    try {
      await ensureProgramSchema();

      const id = parseId(req.params.id);
      if (!id) {
        return res.status(400).json({ success: false, error: 'A numeric programme id is required' });
      }

      const existing = await findProgram(id);
      if (!existing) {
        return res.status(404).json({ success: false, error: `Programme ${id} was not found` });
      }

      const { values, errors } = normalizeProgram(req.body ?? {}, { partial: true });
      if (errors.length > 0) {
        return res.status(400).json({ success: false, error: errors.join('; ') });
      }
      if (Object.keys(values).length === 0) {
        return res.status(400).json({
          success: false,
          error: `Nothing to update. Provide at least one of: ${Object.keys(FIELD_LABELS).join(', ')}, is_active`,
        });
      }

      const fields = Object.keys(values);
      const setClause = fields.map((field) => `${field} = ?`).join(', ');
      await db.query(`UPDATE programs SET ${setClause} WHERE id = ?`, [
        ...fields.map((field) => values[field]),
        id,
      ]);

      const updated = await findProgram(id);
      return res.status(200).json({
        success: true,
        message: `Programme "${updated.program_name}" updated`,
        data: updated,
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          success: false,
          error: `The programme code "${req.body?.program_code ?? ''}" is already in use. Codes must be unique.`,
        });
      }
      console.error('Error in updateProgram controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'The programme could not be updated', details: error.message });
    }
  }

  /**
   * `DELETE /programs/:id` — remove a programme, or deactivate it when residents
   * are enrolled.
   *
   * The two outcomes are reported distinctly so the UI can tell the coordinator
   * which one happened: an empty programme is deleted outright, while one with
   * residents is deactivated and its count returned, because silently discarding
   * an enrolment would orphan the roster, the rotations and the letters that
   * point at this programme.
   */
  static async deleteProgram(req, res) {
    let existing = null;
    try {
      await ensureProgramSchema();

      const id = parseId(req.params.id);
      if (!id) {
        return res.status(400).json({ success: false, error: 'A numeric programme id is required' });
      }

      existing = await findProgram(id);
      if (!existing) {
        return res.status(404).json({ success: false, error: `Programme ${id} was not found` });
      }

      const [usage] = await db.query(
        `SELECT COUNT(*) AS total FROM residency_enrollments WHERE program_id = ?`,
        [id],
      );
      const enrolled = Number(usage[0]?.total ?? 0);

      if (enrolled > 0) {
        await db.query('UPDATE programs SET is_active = 0 WHERE id = ?', [id]);
        const deactivated = await findProgram(id);
        return res.status(200).json({
          success: true,
          message:
            `"${existing.program_name}" has ${enrolled} enrolled resident${enrolled === 1 ? '' : 's'}, ` +
            'so it was deactivated instead of deleted. Its roster and history are untouched.',
          data: { id, deleted: false, deactivated: true, resident_count: enrolled, program: deactivated },
        });
      }

      await db.query('DELETE FROM programs WHERE id = ?', [id]);
      return res.status(200).json({
        success: true,
        message: `Programme "${existing.program_name}" deleted`,
        data: { id, deleted: true, deactivated: false, resident_count: 0, program: null },
      });
    } catch (error) {
      if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.code === 'ER_ROW_IS_REFERENCED') {
        // A dependent row (a rotation, a block) still points at this programme.
        await db
          .query('UPDATE programs SET is_active = 0 WHERE id = ?', [id])
          .catch(() => {});
        return res.status(200).json({
          success: true,
          message:
            `"${existing?.program_name ?? 'This programme'}" still has dependent records, ` +
            'so it was deactivated instead of deleted.',
          data: { id, deleted: false, deactivated: true, resident_count: 0, program: null },
        });
      }
      console.error('Error in deleteProgram controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'The programme could not be deleted', details: error.message });
    }
  }

  /**
   * `GET /programs/network` — the citywide residency map.
   *
   * Programmes as nodes, declared partnerships as edges, and the cross-programme
   * postings actually standing today as observed ties. Declared and observed are
   * reported separately rather than merged, because "we agreed to exchange" and
   * "we are exchanging" are different facts and a coordinator needs to see a
   * partnership that has not been used yet as exactly that.
   */
  static async getNetwork(req, res) {
    try {
      const network = await ProgramConnectionService.getNetwork();
      return res.status(200).json({ success: true, data: network });
    } catch (error) {
      console.error('Error in getNetwork controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'The residency network could not be loaded', details: error.message });
    }
  }

  /** `GET /programs/:id/connections` — one programme's partnerships. */
  static async getProgramConnections(req, res) {
    try {
      const id = parseId(req.params.id);
      if (!id) {
        return res.status(400).json({ success: false, error: 'A numeric programme id is required' });
      }
      const [rows] = await ProgramConnectionService.ensureSchema().then(() =>
        db.query(
          `SELECT
             pc.id,
             pc.source_program_id,
             src.program_name AS source_program_name,
             pc.target_program_id,
             tgt.program_name AS target_program_name,
             pc.connection_type,
             pc.is_active,
             DATE_FORMAT(pc.created_at, '%Y-%m-%d %H:%i') AS created_at
           FROM program_connections pc
             JOIN programs src ON src.id = pc.source_program_id
             JOIN programs tgt ON tgt.id = pc.target_program_id
           WHERE (pc.source_program_id = ? OR pc.target_program_id = ?)
           ORDER BY pc.is_active DESC, pc.id DESC;`,
          [id, id],
        ),
      );
      return res.status(200).json({ success: true, count: rows.length, data: rows });
    } catch (error) {
      console.error('Error in getProgramConnections controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'The connections could not be loaded', details: error.message });
    }
  }

  /**
   * `POST /programs/connections` — declare a partnership.
   *
   * Accepts either orientation: the caller says "this programme connects to
   * that one", and the pair is stored once (see the service), so a re-declaration
   * from the other side does not create a second, mirrored row.
   */
  static async createConnection(req, res) {
    try {
      const { source_program_id, target_program_id, connection_type } = req.body ?? {};
      const outcome = await ProgramConnectionService.connect(
        source_program_id,
        target_program_id,
        connection_type,
      );
      if (!outcome.ok) {
        return res.status(outcome.status).json({ success: false, error: outcome.error });
      }
      return res.status(outcome.status).json({
        success: true,
        message: outcome.message,
        data: outcome.data,
      });
    } catch (error) {
      console.error('Error in createConnection controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'The connection could not be created', details: error.message });
    }
  }

  /** `DELETE /programs/connections/:id` — withdraw a partnership. */
  static async deleteConnection(req, res) {
    try {
      const outcome = await ProgramConnectionService.disconnect(req.params.id);
      if (!outcome.ok) {
        return res.status(outcome.status).json({ success: false, error: outcome.error });
      }
      return res.status(200).json({ success: true, message: outcome.message, data: outcome.data });
    } catch (error) {
      console.error('Error in deleteConnection controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'The connection could not be removed', details: error.message });
    }
  }

  /**
   * `GET /programs/connection-types` — the partnership kinds the screen offers.
   *
   * Served rather than hard-coded in the app so the enum lives in one place: a
   * type added here reaches the form without a client release.
   */
  static async getConnectionTypes(req, res) {
    return res.status(200).json({
      success: true,
      data: ProgramConnectionService.getConnectionTypes(),
    });
  }
}

/** Normalise a 2-letter ISO country code, tolerating absent or blank input. */
function normalizeCountry(value) {
  const text = String(value ?? '').trim().toUpperCase();
  return text.length === 2 ? text : text === '' ? null : text.slice(0, 2);
}

module.exports = ProgramController;
