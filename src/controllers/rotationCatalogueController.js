const db = require('../config/db');
const {
  generateCatalogueTemplate,
  parseCatalogueFile,
  MAX_ABBREVIATION_LENGTH,
  MAX_NAME_LENGTH,
} = require('../utils/excel/catalogue');

/**
 * Rotations Catalogue — the programme's registry of hospital and clinic
 * rotations.
 *
 * The catalogue is the `rotations` table, projected through the
 * `rotations_catalogue` view so the API speaks the names this feature is
 * specified with (`full_name`, `department`, `abbreviation`) while the roster,
 * the master grid and every existing assignment keep reading the same rows.
 * Two tables would be two sources of truth for "what rotations exist", and the
 * master grid would resolve one of them.
 *
 * That single source of truth is also why deletion carries a safety check: an
 * assignment row holds `rotation_id` with a RESTRICT foreign key, so a rotation
 * with any assignment behind it cannot be removed. The check here turns the
 * database's opaque `ER_ROW_IS_REFERENCED_2` into a sentence that says how many
 * residents are affected — and how many of those assignments are still running.
 */

const VIEW_COLUMNS =
  'id, program_id, full_name, department, abbreviation, is_active, default_duration_weeks, created_at, updated_at';

const CREATE_VIEW_SQL = `
  CREATE OR REPLACE VIEW rotations_catalogue AS
  SELECT id,
         program_id,
         rotation_name AS full_name,
         department_name AS department,
         rotation_code AS abbreviation,
         is_active,
         default_duration_weeks,
         created_at,
         updated_at
    FROM rotations`;

/**
 * Build the view once per process.
 *
 * There is no migration runner in this project and the schema lives on a
 * managed Hostinger database, so the projection is created lazily the first
 * time the catalogue is read. `CREATE OR REPLACE` is idempotent; if it fails
 * (a user with no DDL rights, say) the code still checks whether the view is
 * already there, because a working view must not be taken down by an inability
 * to recreate it.
 */
let schemaReady = false;
async function ensureCatalogueSchema() {
  if (schemaReady) return;
  try {
    await db.query(CREATE_VIEW_SQL);
    schemaReady = true;
  } catch (error) {
    const [rows] = await db.query(
      "SELECT COUNT(*) AS total FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rotations_catalogue'",
    );
    if (Number(rows[0]?.total ?? 0) > 0) {
      schemaReady = true;
      return;
    }
    throw error;
  }
}

const FIELD_LABELS = {
  full_name: 'Full Rotation Name',
  department: 'Hospital Department',
  abbreviation: 'Abbreviation',
};

/**
 * Trim, upper-case the abbreviation, and report what is missing or too long.
 *
 * The three checks that matter for a catalogue are all here: a blank field
 * would create a rotation nobody can recognise, an abbreviation over 50
 * characters cannot fit its column, and a duplicate abbreviation would collide
 * with the `(program_id, rotation_code)` unique key the master grid resolves by.
 *
 * @param {object} input
 * @param {{partial?: boolean}} [options] When `partial`, absent fields are
 *   ignored instead of being required — the shape an edit form needs, so
 *   renaming a rotation does not demand re-sending its department.
 * @returns {{values: object, errors: string[]}}
 */
function normalizeEntry(input, options = {}) {
  const partial = options.partial === true;
  const values = {};
  const errors = [];

  for (const [field, label] of Object.entries(FIELD_LABELS)) {
    const present = Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined;
    if (!present) {
      if (!partial) errors.push(`${label} is required`);
      continue;
    }

    const text = String(input[field] ?? '').trim();
    const normalized = field === 'abbreviation' ? text.toUpperCase() : text;

    if (normalized === '') {
      errors.push(`${label} is required`);
      continue;
    }
    const limit = field === 'abbreviation' ? MAX_ABBREVIATION_LENGTH : MAX_NAME_LENGTH;
    if (normalized.length > limit) {
      errors.push(`${label} must be ${limit} characters or fewer`);
      continue;
    }
    values[field] = normalized;
  }

  return { values, errors };
}

async function programExists(programId) {
  const [rows] = await db.query('SELECT id FROM programs WHERE id = ?', [programId]);
  return rows.length > 0;
}

/** The row behind `:id`, or `null`. */
async function findEntry(id) {
  const [rows] = await db.query(`SELECT ${VIEW_COLUMNS} FROM rotations_catalogue WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

function parseId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Is `abbreviation` already taken by a different row of the same programme? */
async function abbreviationTaken(programId, abbreviation, exceptId = null) {
  const [rows] = exceptId
    ? await db.query(
        'SELECT id FROM rotations_catalogue WHERE program_id = ? AND abbreviation = ? AND id <> ?',
        [programId, abbreviation, exceptId],
      )
    : await db.query('SELECT id FROM rotations_catalogue WHERE program_id = ? AND abbreviation = ?', [
        programId,
        abbreviation,
      ]);
  return rows.length > 0;
}

class RotationCatalogueController {
  /** `GET /rotations/catalogue?program_id=X` — every rotation in a programme. */
  static async getCatalogue(req, res) {
    try {
      const programId = Number(req.query.program_id);
      if (!Number.isInteger(programId) || programId <= 0) {
        return res
          .status(400)
          .json({ success: false, error: 'Missing required query parameter: program_id' });
      }

      await ensureCatalogueSchema();
      const [rows] = await db.query(
        `SELECT ${VIEW_COLUMNS} FROM rotations_catalogue WHERE program_id = ? ORDER BY full_name ASC`,
        [programId],
      );
      return res.status(200).json({ success: true, count: rows.length, data: rows });
    } catch (error) {
      console.error('Error in getCatalogue controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to fetch the rotation catalogue', details: error.message });
    }
  }

  /** `POST /rotations/catalogue` — add one rotation by hand. */
  static async createRotation(req, res) {
    try {
      const programId = Number(req.body.program_id);
      if (!Number.isInteger(programId) || programId <= 0) {
        return res.status(400).json({ success: false, error: 'program_id is required' });
      }

      const { values, errors } = normalizeEntry(req.body);
      if (errors.length > 0) {
        return res.status(400).json({ success: false, error: errors.join('; ') });
      }
      if (!(await programExists(programId))) {
        return res
          .status(400)
          .json({ success: false, error: `Programme ${programId} does not exist` });
      }
      if (await abbreviationTaken(programId, values.abbreviation)) {
        return res.status(409).json({
          success: false,
          error: `Abbreviation "${values.abbreviation}" is already used by another rotation in this programme.`,
        });
      }

      await ensureCatalogueSchema();
      const [result] = await db.query(
        'INSERT INTO rotations_catalogue (program_id, full_name, department, abbreviation) VALUES (?, ?, ?, ?)',
        [programId, values.full_name, values.department, values.abbreviation],
      );

      const created = await findEntry(result.insertId);
      return res.status(201).json({
        success: true,
        message: 'Rotation added to the catalogue',
        data: created,
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          success: false,
          error: `Abbreviation "${req.body.abbreviation ?? ''}" is already used by another rotation in this programme.`,
        });
      }
      console.error('Error in createRotation controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'The rotation could not be created', details: error.message });
    }
  }

  /** `PUT /rotations/catalogue/:id` — rename or otherwise edit one rotation. */
  static async updateRotation(req, res) {
    try {
      const id = parseId(req.params.id);
      if (!id) {
        return res.status(400).json({ success: false, error: 'A numeric rotation id is required' });
      }

      await ensureCatalogueSchema();
      const existing = await findEntry(id);
      if (!existing) {
        return res.status(404).json({ success: false, error: `Rotation ${id} was not found` });
      }

      const { values, errors } = normalizeEntry(req.body, { partial: true });
      if (errors.length > 0) {
        return res.status(400).json({ success: false, error: errors.join('; ') });
      }
      if (Object.keys(values).length === 0) {
        return res.status(400).json({
          success: false,
          error: `Nothing to update. Provide at least one of: ${Object.keys(FIELD_LABELS).join(', ')}`,
        });
      }

      const merged = { ...existing, ...values };
      if (await abbreviationTaken(existing.program_id, merged.abbreviation, id)) {
        return res.status(409).json({
          success: false,
          error: `Abbreviation "${merged.abbreviation}" is already used by another rotation in this programme.`,
        });
      }

      const fields = Object.keys(values);
      const setClause = fields.map((field) => `${field} = ?`).join(', ');
      await db.query(`UPDATE rotations_catalogue SET ${setClause} WHERE id = ?`, [
        ...fields.map((field) => values[field]),
        id,
      ]);

      const updated = await findEntry(id);
      return res.status(200).json({
        success: true,
        message: 'Rotation updated',
        data: updated,
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          success: false,
          error: 'That abbreviation is already used by another rotation in this programme.',
        });
      }
      console.error('Error in updateRotation controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'The rotation could not be updated', details: error.message });
    }
  }

  /**
   * `DELETE /rotations/catalogue/:id` — remove a rotation, but never one a
   * resident is scheduled against.
   *
   * The count is reported rather than implied: "4 assignments, 2 still active"
   * tells the coordinator that two residents have future weeks on this rotation
   * and that the other two are history they must decide what to do with,
   * instead of leaving them to discover the constraint one attempt at a time.
   */
  static async deleteRotation(req, res) {
    let existing = null;
    try {
      const id = parseId(req.params.id);
      if (!id) {
        return res.status(400).json({ success: false, error: 'A numeric rotation id is required' });
      }

      await ensureCatalogueSchema();
      existing = await findEntry(id);
      if (!existing) {
        return res.status(404).json({ success: false, error: `Rotation ${id} was not found` });
      }

      const [usage] = await db.query(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(end_date >= CURDATE()), 0) AS active
           FROM resident_rotation_assignments
          WHERE rotation_id = ?`,
        [id],
      );
      const total = Number(usage[0]?.total ?? 0);
      const active = Number(usage[0]?.active ?? 0);

      if (total > 0) {
        return res.status(400).json({
          success: false,
          error:
            `Cannot delete "${existing.full_name}": ${total} resident assignment${total === 1 ? '' : 's'}` +
            `${active > 0 ? ` (${active} active)` : ''} rely on it. Remove the assignments first.`,
          assignments: total,
          active_assignments: active,
        });
      }

      await db.query('DELETE FROM rotations_catalogue WHERE id = ?', [id]);
      return res.status(200).json({
        success: true,
        message: 'Rotation deleted',
        data: { id, full_name: existing.full_name, abbreviation: existing.abbreviation },
      });
    } catch (error) {
      if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.code === 'ER_ROW_IS_REFERENCED') {
        return res.status(400).json({
          success: false,
          error: `Cannot delete "${existing?.full_name ?? 'this rotation'}": resident assignments still reference it.`,
        });
      }
      console.error('Error in deleteRotation controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'The rotation could not be deleted', details: error.message });
    }
  }

  /** `GET /rotations/catalogue/template` — the blank workbook. */
  static async downloadTemplate(req, res) {
    try {
      const buffer = generateCatalogueTemplate();
      res.setHeader('Content-Disposition', 'attachment; filename="rotations_catalogue_template.xlsx"');
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.send(buffer);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * `POST /rotations/catalogue/import` — bulk upload.
   *
   * All or nothing. The workbook is validated in full (blank fields, oversized
   * codes, an abbreviation repeated inside the file) before the transaction
   * opens, and every row is written with an upsert keyed on the programme's
   * unique abbreviation, so uploading the same filled-in template twice
   * updates rather than duplicates — which is what makes "download, edit,
   * re-upload" a safe way to fix a mistake.
   */
  static async importCatalogue(req, res) {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file was uploaded.' });
    }

    let parsed;
    try {
      parsed = parseCatalogueFile(req.file.buffer);
    } catch (error) {
      return res
        .status(400)
        .json({ success: false, issues: [{ field: 'File', message: error.message }] });
    }

    const requestedProgramId = Number(req.body.program_id) || null;

    const conn = await db.getConnection();
    let inTransaction = false;
    try {
      const [programs] = requestedProgramId
        ? await conn.query('SELECT id, program_name FROM programs WHERE id = ?', [requestedProgramId])
        : await conn.query('SELECT id, program_name FROM programs ORDER BY id ASC LIMIT 1');
      if (programs.length === 0) {
        return res.status(400).json({
          success: false,
          issues: [{ field: 'Programme', message: 'no programme exists to catalogue rotations for' }],
        });
      }
      const program = programs[0];

      if (parsed.errors.length > 0) {
        return res.status(400).json({ success: false, issues: parsed.errors });
      }

      // The view is created outside the transaction: DDL commits implicitly in
      // MySQL and would silently end the transaction it was opened inside.
      await ensureCatalogueSchema();
      await conn.beginTransaction();
      inTransaction = true;

      // Which of these abbreviations are already in the programme, read before
      // any row is written. The upsert's `affectedRows` cannot answer that:
      // MariaDB reports 1 for a duplicate row left exactly as it was and 2 for
      // one it changed, so counting on it would tell the coordinator that a
      // re-upload of an untouched file "created" rows that were already there.
      const placeholders = parsed.rows.map(() => '?').join(', ');
      const [existingRows] = await conn.query(
        `SELECT abbreviation FROM rotations_catalogue
          WHERE program_id = ? AND abbreviation IN (${placeholders})`,
        [program.id, ...parsed.rows.map((row) => row.abbreviation)],
      );
      const alreadyThere = new Set(existingRows.map((row) => row.abbreviation));

      let created = 0;
      let updated = 0;
      for (const row of parsed.rows) {
        if (alreadyThere.has(row.abbreviation)) updated += 1;
        else created += 1;
        await conn.query(
          `INSERT INTO rotations_catalogue (program_id, full_name, department, abbreviation)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), department = VALUES(department)`,
          [program.id, row.full_name, row.department, row.abbreviation],
        );
      }

      await conn.commit();
      inTransaction = false;

      return res.json({
        success: true,
        count: parsed.rows.length,
        created,
        updated,
        summary:
          `${parsed.rows.length} catalogue row${parsed.rows.length === 1 ? '' : 's'} saved for ${program.program_name} ` +
          `(${created} new, ${updated} updated).`,
      });
    } catch (error) {
      if (inTransaction) {
        await conn.rollback().catch(() => {});
      }
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          success: false,
          issues: [{ field: 'Abbreviation', message: 'is already used by another rotation in this programme' }],
        });
      }
      return res.status(400).json({ success: false, error: error.message });
    } finally {
      conn.release();
    }
  }
}

module.exports = RotationCatalogueController;
