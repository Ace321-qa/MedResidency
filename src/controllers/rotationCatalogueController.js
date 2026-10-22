const db = require('../config/db');
const {
  generateCatalogueTemplate,
  parseCatalogueFile,
  MAX_ABBREVIATION_LENGTH,
  MAX_NAME_LENGTH,
} = require('../utils/excel/catalogue');
const { ensureTargetProgramColumn } = require('../utils/ensureTargetProgram');

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
  'id, program_id, target_program_id, full_name, department, abbreviation, is_active, default_duration_weeks, ' +
  'max_capacity, capacity_locked, coordinator_email, created_at, updated_at';

const CREATE_VIEW_SQL = `
  CREATE OR REPLACE VIEW rotations_catalogue AS
  SELECT id,
         program_id,
         target_program_id,
         rotation_name AS full_name,
         department_name AS department,
         rotation_code AS abbreviation,
         is_active,
         default_duration_weeks,
         max_capacity,
         capacity_locked,
         coordinator_email,
         created_at,
         updated_at
    FROM rotations`;

/**
 * The seat-limit columns, added to `rotations` on first use.
 *
 * `max_capacity` is the departmental seat limit — how many residents may sit in
 * this rotation in any one week — and `NULL` or `0` means unlimited, so the
 * column can be added to a populated table without silently capping every
 * existing rotation at zero seats.
 *
 * `capacity_locked` turns that limit into a hard stop: a locked limit is refused
 * even with a rationale, which is what a department says when its three posts
 * are funded rather than merely preferred.
 *
 * There is no migration runner in this project, so these are added the same
 * idempotent way the CCC tables are: ask `information_schema` whether the column
 * is there, and only then `ALTER`. A table created before this feature keeps
 * working because the view's `CREATE OR REPLACE` runs after the columns exist.
 */
async function ensureCapacityColumns() {
  // The cross-programme link (`target_program_id`) lives in a shared guard —
  // the cohort grid and the notice dispatcher read the same column — but is
  // triggered from here too, so the catalogue view below is created after the
  // column it projects exists.
  await ensureTargetProgramColumn();

  const [capacity] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rotations' AND COLUMN_NAME = 'max_capacity'`,
  );
  if (capacity.length === 0) {
    await db.query('ALTER TABLE rotations ADD COLUMN max_capacity INT NULL AFTER default_duration_weeks');
  }

  const [locked] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rotations' AND COLUMN_NAME = 'capacity_locked'`,
  );
  if (locked.length === 0) {
    await db.query(
      'ALTER TABLE rotations ADD COLUMN capacity_locked TINYINT(1) NOT NULL DEFAULT 0 AFTER max_capacity',
    );
  }

  const [coord] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rotations' AND COLUMN_NAME = 'coordinator_email'`,
  );
  if (coord.length === 0) {
    await db.query('ALTER TABLE rotations ADD COLUMN coordinator_email VARCHAR(255) NULL');
  }

  // The audit trail for every placement made over capacity. One row per
  // exception, keyed to the assignment it excuses, so "who allowed this and
  // why" is answerable years later without reading the assignment's notes.
  await db.query(`
    CREATE TABLE IF NOT EXISTS rotation_capacity_exceptions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      assignment_id BIGINT UNSIGNED NULL,
      resident_id BIGINT UNSIGNED NOT NULL,
      rotation_id BIGINT UNSIGNED NOT NULL,
      rotation_block_id BIGINT UNSIGNED NULL,
      status VARCHAR(16) NOT NULL,
      capacity INT NULL,
      peak_occupancy INT NULL,
      peak_weeks JSON NULL,
      reason VARCHAR(500) NOT NULL,
      approver VARCHAR(200) NOT NULL,
      faculty_confirmed TINYINT(1) NOT NULL DEFAULT 0,
      weekly_occupancy JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_capacity_exceptions_assignment (assignment_id),
      KEY idx_capacity_exceptions_rotation (rotation_id),
      KEY idx_capacity_exceptions_resident (resident_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

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
  await ensureCapacityColumns();
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
 * The spellings the API accepts for each catalogue field.
 *
 * The catalogue view speaks `full_name` / `department` / `abbreviation`, while
 * the `rotations` table underneath it speaks `rotation_name` /
 * `department_name` / `rotation_code`, and the hosting link is
 * `target_program_id` on one side and `hosted_by_program_id` on the other.
 *
 * Both are in circulation — the app sends the view's names, the Excel import
 * writes the table's — so each field is read from any of its names rather than
 * from exactly one. A request is a request, whichever column it happens to
 * name, and refusing one spelling of a field the other spelling fills is a
 * failure with no cause the caller can see.
 */
const FIELD_ALIASES = {
  full_name: ['full_name', 'rotation_name'],
  department: ['department', 'department_name'],
  abbreviation: ['abbreviation', 'rotation_code'],
};

/** The hosting link, under either of its names. */
const TARGET_PROGRAM_ALIASES = ['target_program_id', 'hosted_by_program_id'];

/**
 * A derived abbreviation is a label, not a word.
 *
 * Three characters is the shortest code anyone reads without squinting, and six
 * is the longest that still fits beside a rotation name on a narrow screen.
 */
const MIN_DERIVED_ABBREVIATION_LENGTH = 3;
const MAX_DERIVED_ABBREVIATION_LENGTH = 6;

/** The coordinator contact address, and the shape one has to have to be one. */
const MAX_EMAIL_LENGTH = 255;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Read a field from any of the names it is allowed to arrive under.
 *
 * @param {object} input
 * @param {string[]} aliases
 * @returns {{present: boolean, value: *}}
 */
function readAliased(input, aliases) {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(input, alias) && input[alias] !== undefined) {
      return { present: true, value: input[alias] };
    }
  }
  return { present: false, value: undefined };
}

/**
 * Derive a short, uppercase code from a rotation name.
 *
 * "Primary Health Care" becomes "PHC": the initials of the words, widened one
 * letter at a time when there are too few of them to be a code ("Surgery" →
 * "SUR"), and capped at six characters because the column holds a label rather
 * than a word.
 *
 * The mobile form derives the same code from the same name, so a blank
 * abbreviation field means the same thing on both sides of the request: the
 * coordinator sees "PHC" offered before they save, and the server writes
 * "PHC" if they never chose one.
 *
 * @param {string} rotationName
 * @returns {string} The derived code, or an empty string if the name has no
 *   letters to derive one from.
 */
function deriveAbbreviation(rotationName) {
  const words = String(rotationName ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, ''))
    .filter(Boolean);

  if (words.length === 0) return '';

  let code = words.map((word) => word[0].toUpperCase()).join('');

  // Too few initials to be a code: widen, one more letter per word at a time.
  let depth = 1;
  while (code.length < MIN_DERIVED_ABBREVIATION_LENGTH && depth < 8) {
    depth += 1;
    const extra = words
      .filter((word) => word.length >= depth)
      .map((word) => word[depth - 1].toUpperCase())
      .join('');
    if (!extra) break;
    code += extra;
  }

  // Words of one letter each cannot widen any further; take the flat letters.
  if (code.length < MIN_DERIVED_ABBREVIATION_LENGTH) {
    code = words.join('').toUpperCase().slice(0, MIN_DERIVED_ABBREVIATION_LENGTH);
  }

  return code.slice(0, MAX_DERIVED_ABBREVIATION_LENGTH);
}

/** The largest seat limit the form will accept, so a typo cannot read as infinite. */
const MAX_CAPACITY = 999;

/**
 * Normalise the optional seat-limit fields.
 *
 * Kept apart from the text fields because the rules are different in kind: the
 * names are strings with a length limit, whereas `max_capacity` is an optional
 * positive integer whose *absence* is meaningful — `NULL` means unlimited, and
 * an empty form field has to be read as that absence rather than as a zero that
 * would silently close the rotation.
 *
 * A blank string is therefore `NULL`, `0` is accepted and stored as `NULL` for
 * the same reason, and anything that is not a non-negative integer is refused
 * with the field named.
 *
 * @param {object} input
 * @param {boolean} partial - when true, absent fields are left untouched.
 * @returns {{values: object, errors: string[]}}
 */
function normalizeCapacity(input, partial) {
  const values = {};
  const errors = [];

  if (Object.prototype.hasOwnProperty.call(input, 'max_capacity') && input.max_capacity !== undefined) {
    const raw = input.max_capacity;
    // An empty form field arrives as `''`; that is "no limit", not "zero seats".
    if (raw === null || String(raw).trim() === '') {
      values.max_capacity = null;
    } else {
      const parsed = Number(String(raw).trim());
      if (!Number.isInteger(parsed) || parsed < 0) {
        errors.push('Max Capacity / Seat Limit must be a whole number of seats');
      } else if (parsed > MAX_CAPACITY) {
        errors.push(`Max Capacity / Seat Limit must be ${MAX_CAPACITY} or fewer`);
      } else {
        // 0 is documented as unlimited alongside NULL, so the two spellings are
        // collapsed to one value the rest of the system has to understand.
        values.max_capacity = parsed === 0 ? null : parsed;
      }
    }
  } else if (!partial) {
    values.max_capacity = null;
  }

  if (Object.prototype.hasOwnProperty.call(input, 'capacity_locked') && input.capacity_locked !== undefined) {
    const raw = input.capacity_locked;
    if (raw === true || raw === 1 || raw === '1' || raw === 'true') {
      values.capacity_locked = 1;
    } else if (raw === false || raw === 0 || raw === '0' || raw === 'false' || raw === '') {
      values.capacity_locked = 0;
    } else {
      errors.push('Lock Seat Limit must be true or false');
    }
  } else if (!partial) {
    values.capacity_locked = 0;
  }

  return { values, errors };
}

/**
 * Trim, upper-case the abbreviation, and report what is missing or too long.
 *
 * The three checks that matter for a catalogue are all here: a blank field
 * would create a rotation nobody can recognise, an abbreviation over 50
 * characters cannot fit its column, and a duplicate abbreviation would collide
 * with the `(program_id, rotation_code)` unique key the master grid resolves by.
 *
 * Two of the three fields can be derived from the name, and a request that
 * omits them is asking for that derivation rather than for a refusal: a
 * rotation without a department is one whose department is its own name, and a
 * rotation without a code is one whose code is the initials of its name. The
 * fallbacks apply to a create only — a partial update that leaves a field out
 * is leaving the stored value alone, not asking for it to be overwritten.
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

  // Read every field first, under any of the names it is allowed to arrive
  // under, so the fallbacks below have a name to fall back *to*.
  const read = {};
  for (const field of Object.keys(FIELD_LABELS)) {
    const found = readAliased(input, FIELD_ALIASES[field]);
    const raw = found.present ? String(found.value ?? '').trim() : '';
    read[field] = {
      present: found.present,
      value: field === 'abbreviation' ? raw.toUpperCase() : raw,
      tooLong: false,
    };
  }

  // Length limits are checked before the fallbacks, so a name that is itself
  // too long does not also raise a second "too long" error for the department
  // it would have been copied into.
  for (const [field, label] of Object.entries(FIELD_LABELS)) {
    if (!read[field].present) continue;
    const limit = field === 'abbreviation' ? MAX_ABBREVIATION_LENGTH : MAX_NAME_LENGTH;
    if (read[field].value.length > limit) {
      errors.push(`${label} must be ${limit} characters or fewer`);
      read[field].tooLong = true;
    }
  }

  if (!partial && read.full_name.present && !read.full_name.tooLong && read.full_name.value !== '') {
    if (!read.department.present || read.department.value === '') {
      read.department = { present: true, value: read.full_name.value, tooLong: false };
    }
    if (!read.abbreviation.present || read.abbreviation.value === '') {
      const derived = deriveAbbreviation(read.full_name.value);
      if (derived !== '') {
        read.abbreviation = { present: true, value: derived, tooLong: false };
      }
    }
  }

  for (const [field, label] of Object.entries(FIELD_LABELS)) {
    if (!read[field].present) {
      if (!partial) errors.push(`${label} is required`);
      continue;
    }
    if (read[field].tooLong) continue;
    if (read[field].value === '') {
      errors.push(`${label} is required`);
      continue;
    }
    values[field] = read[field].value;
  }

  const capacity = normalizeCapacity(input, partial);
  Object.assign(values, capacity.values);
  errors.push(...capacity.errors);

  const target = normalizeTargetProgram(input, partial);
  Object.assign(values, target.values);
  errors.push(...target.errors);

  const email = normalizeEmail(input, partial);
  Object.assign(values, email.values);
  errors.push(...email.errors);

  return { values, errors };
}

/**
 * Normalise the optional coordinator contact address.
 *
 * The address is optional, but it is not free-form: a rotation is looked up by
 * its coordinator when a placement question arrives, and an address that
 * cannot be delivered to turns that lookup into a dead end for whoever is
 * holding the phone. So the shape is checked here rather than at the point of
 * sending, where the sender only learns about it after the message is gone.
 *
 * A blank field is the absence of an address, which is `NULL` rather than an
 * empty string — the column is nullable and `NULL` is what it means.
 *
 * @param {object} input
 * @param {boolean} partial - when true, an absent field is left untouched.
 * @returns {{values: object, errors: string[]}}
 */
function normalizeEmail(input, partial) {
  if (!Object.prototype.hasOwnProperty.call(input, 'coordinator_email') || input.coordinator_email === undefined) {
    if (partial) return { values: {}, errors: [] };
    return { values: { coordinator_email: null }, errors: [] };
  }

  const raw = input.coordinator_email;
  if (raw === null || String(raw).trim() === '') {
    return { values: { coordinator_email: null }, errors: [] };
  }

  const address = String(raw).trim();
  if (address.length > MAX_EMAIL_LENGTH) {
    return {
      values: {},
      errors: [`Coordinator Email must be ${MAX_EMAIL_LENGTH} characters or fewer`],
    };
  }
  if (!EMAIL_PATTERN.test(address)) {
    return { values: {}, errors: ['Coordinator Email must be a valid email address'] };
  }
  return { values: { coordinator_email: address }, errors: [] };
}

/**
 * Normalise the optional link to a registered programme account.
 *
 * Kept apart from the text fields because it is an identity, not a label: the
 * picker writes the programme's id, and `null` is a real answer meaning "this
 * rotation is not hosted by any registered programme" — which is where every
 * rotation stood before this column existed, and where the Excel import still
 * puts its rows. The existence check lives in the controller, which is already
 * holding a connection for the rest of the create/update path.
 *
 * @param {object} input
 * @param {boolean} partial - when true, an absent field is left untouched.
 * @returns {{values: object, errors: string[]}}
 */
function normalizeTargetProgram(input, partial) {
  const found = readAliased(input, TARGET_PROGRAM_ALIASES);
  if (!found.present) {
    if (partial) return { values: {}, errors: [] };
    return { values: { target_program_id: null }, errors: [] };
  }

  const raw = found.value;
  if (raw === null || raw === '') {
    return { values: { target_program_id: null }, errors: [] };
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      values: {},
      errors: ['Linked Programme must be the id of a registered programme, or empty'],
    };
  }
  return { values: { target_program_id: parsed }, errors: [] };
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

/**
 * Turn a database refusal into a sentence the coordinator can act on.
 *
 * The database reports a duplicate code as `ER_DUP_ENTRY` and a column that
 * does not exist as `ER_BAD_FIELD_ERROR`. Neither says which rotation or which
 * field is at fault, and both arrive as the same opaque 500 the coordinator
 * sees as "Could not save". The raw code is a good key for the log and a
 * useless thing to show a person, so the known refusals are translated here
 * and everything else falls through to the 500 that at least reaches the log.
 *
 * @param {Error} error
 * @param {{abbreviation?: string}} [context] The values that were being saved,
 *   so the message can name them.
 * @returns {string|null} The sentence to send, or `null` when the failure is
 *   not one the caller can do anything about.
 */
function describeDatabaseFailure(error, context = {}) {
  switch (error?.code) {
    case 'ER_DUP_ENTRY':
      return `Abbreviation '${context.abbreviation ?? ''}' already exists in this programme.`;
    case 'ER_BAD_FIELD_ERROR':
    case 'ER_BAD_FIELD_ERROR_UNKNOWN':
      return `The database rejected an unknown column: ${error.sqlMessage ?? error.message}`;
    case 'ER_NO_DEFAULT_FOR_FIELD':
      return `A required column was given no value: ${error.sqlMessage ?? error.message}`;
    case 'ER_BAD_NULL_ERROR':
      return `A required column cannot be empty: ${error.sqlMessage ?? error.message}`;
    case 'ER_TRUNCATED_WRONG_VALUE':
    case 'ER_DATA_TOO_LONG':
      return `A value is too long for its column: ${error.sqlMessage ?? error.message}`;
    case 'ER_WARN_DATA_OUT_OF_RANGE':
    case 'ER_OUT_OF_RANGE':
      return `A value is outside the range its column accepts: ${error.sqlMessage ?? error.message}`;
    default:
      return null;
  }
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
    // Kept outside the `try` so the constraint handler can name the code that
    // was actually saved — which may be the one derived from the name rather
    // than the one the request spelled out.
    let abbreviation = '';
    try {
      const programId = Number(req.body.program_id);
      if (!Number.isInteger(programId) || programId <= 0) {
        return res.status(400).json({ success: false, error: 'program_id is required' });
      }

      const { values, errors } = normalizeEntry(req.body);
      if (errors.length > 0) {
        return res.status(400).json({ success: false, error: errors.join('; ') });
      }
      abbreviation = values.abbreviation ?? '';
      if (!(await programExists(programId))) {
        return res
          .status(400)
          .json({ success: false, error: `Programme ${programId} does not exist` });
      }
      if (values.target_program_id != null && !(await programExists(values.target_program_id))) {
        return res.status(400).json({
          success: false,
          error: `Linked programme ${values.target_program_id} does not exist`,
        });
      }

      // The schema is made ready before the catalogue is read, not after: the
      // duplicate check below queries the `rotations_catalogue` view, and on a
      // database that has never had one, the check would fail on a missing
      // view rather than on the duplicate it was asked to find.
      await ensureCatalogueSchema();

      if (await abbreviationTaken(programId, values.abbreviation)) {
        return res.status(400).json({
          success: false,
          error: `Abbreviation '${values.abbreviation}' already exists in this programme.`,
        });
      }

      const [result] = await db.query(
        `INSERT INTO rotations_catalogue (program_id, target_program_id, full_name, department, abbreviation, max_capacity, capacity_locked, coordinator_email)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          programId,
          values.target_program_id ?? null,
          values.full_name,
          values.department,
          values.abbreviation,
          values.max_capacity ?? null,
          values.capacity_locked ?? 0,
          values.coordinator_email ?? null,
        ],
      );

      const created = await findEntry(result.insertId);
      return res.status(201).json({
        success: true,
        message: 'Rotation added to the catalogue',
        data: created,
      });
    } catch (error) {
      const failure = describeDatabaseFailure(error, { abbreviation });
      if (failure) {
        return res.status(400).json({ success: false, error: failure, code: error.code });
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
          error: `Nothing to update. Provide at least one of: ${[
            ...Object.keys(FIELD_LABELS),
            'max_capacity',
            'capacity_locked',
            'target_program_id',
          ].join(', ')}`,
        });
      }
      if (values.target_program_id != null && !(await programExists(values.target_program_id))) {
        return res.status(400).json({
          success: false,
          error: `Linked programme ${values.target_program_id} does not exist`,
        });
      }

      const merged = { ...existing, ...values };
      if (await abbreviationTaken(existing.program_id, merged.abbreviation, id)) {
        return res.status(400).json({
          success: false,
          error: `Abbreviation '${merged.abbreviation}' already exists in this programme.`,
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
      const failure = describeDatabaseFailure(error, {
        abbreviation: req.body?.abbreviation ?? req.body?.rotation_code,
      });
      if (failure) {
        return res.status(400).json({ success: false, error: failure, code: error.code });
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
          `INSERT INTO rotations_catalogue (program_id, full_name, department, abbreviation, max_capacity, coordinator_email)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), department = VALUES(department), max_capacity = VALUES(max_capacity), coordinator_email = VALUES(coordinator_email)`,
          [program.id, row.full_name, row.department, row.abbreviation, row.max_capacity ?? null, row.coordinator_email ?? null],
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
