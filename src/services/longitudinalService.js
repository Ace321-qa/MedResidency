const db = require('../config/db');
const {
  addMonths,
  calculateEndDateFromWeeks,
  convertMonthsToWeeks,
  describeWindow,
} = require('../utils/blockDates');
const RotationService = require('./rotationService');
const { PRIMARY_IDENTIFIER_SQL } = RotationService;
const {
  PRIMARY_CARE_DEFAULT_CLINICS,
  deriveClinicCode,
} = require('../utils/primaryCareClinics');

/**
 * Residents are listed on the CCC matrix by name only — a resident is never
 * addressed as "Dr.". Faculty, by contrast, are always prefixed with the title
 * "Dr.". These two helpers are the single place that rule is enforced, so a slot
 * saved through any path ends up with the same shape.
 *
 * The `Dr` prefix only matches when followed by a dot and/or whitespace, so a
 * resident genuinely called "Drew" or "Drakos" keeps their name intact.
 */
function stripDoctorTitle(name) {
  return String(name ?? '')
    .trim()
    .replace(/^Dr\.?\s+/i, '')
    .trim();
}

/** Faculty display name: exactly one `Dr. ` prefix, never two. */
function formatFacultyName(name) {
  const base = stripDoctorTitle(name);
  return base ? `Dr. ${base}` : null;
}

/** Resident display name: the `Dr.` title is stripped, never added. */
function formatResidentName(name) {
  const base = stripDoctorTitle(name);
  return base || null;
}

const CCC_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];

/** Shift / PGY defaults for each CCC academic day. */
function defaultShiftForDay(day) {
  return day === 'Tuesday' || day === 'Thursday' ? '07:00 - 2:00' : '10:30 - 2:00';
}

function defaultPgyForDay(day) {
  switch (day) {
    case 'Sunday':
      return 'PGY-3';
    case 'Monday':
      return 'PGY-2';
    case 'Tuesday':
      return 'FMC';
    case 'Wednesday':
      return 'PGY-1';
    default:
      return 'FMC';
  }
}

/**
 * The CCC grid's clinic columns are numbered positions — `Clinic 1`, `Clinic 2`,
 * ... — not clinic *types*. A programme starts with ten of them and a coordinator
 * can add, rename or remove columns; each column is stored in
 * `primary_care_clinic_columns` keyed by its `clinic_number`, which is also the
 * `primary_care_clinic_slots.clinic_number` it reads and writes. Named clinics
 * (WBC, ANC, ...) belong to the clinic catalog, which lives outside this grid.
 */
const DEFAULT_CLINIC_COLUMN_COUNT = 10;
const MAX_CLINIC_COLUMN_COUNT = 99;

/** The leave reasons the Leaves column can record: the `leave_type` enum set. */
const ABSENCE_LEAVE_TYPES = [
  'ANNUAL_LEAVE',
  'CASUAL_LEAVE',
  'SICK_LEAVE',
  'EMERGENCY_LEAVE',
  'HAJJ_LEAVE',
  'ACADEMIC_LEAVE',
  'STUDY_LEAVE',
  'EXAM_LEAVE',
  'OTHER_LEAVE',
];

/** Marker written into `resident_attendance_logs.notes` for rows this feature owns. */
const CCC_LEAVE_NOTE = '[CCC Leave Registry]';

/** `Date.getDay()` index for a CCC day name, or -1 when it names no CCC day. */
function cccWeekdayIndex(dayOfWeek) {
  const normalized = String(dayOfWeek ?? '').trim().toLowerCase();
  if (!normalized) return -1;
  return CCC_DAYS.findIndex((day) => {
    const full = day.toLowerCase();
    return normalized === full || normalized === full.slice(0, 3) || normalized.startsWith(full.slice(0, 3));
  });
}

/**
 * The calendar date of a weekday within the cycle's week.
 *
 * The cycle's `start_date` is the first day of the academic week; the CCC days
 * run Sunday through Thursday. Resolving the *next* occurrence on or after the
 * start date keeps the date correct whichever weekday the week opens on.
 */
function dateForWeekday(startDate, weekdayIndex) {
  const base = toCalendarDate(startDate);
  if (!base || weekdayIndex < 0) return null;
  const date = new Date(`${base}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  const delta = (weekdayIndex - date.getDay() + 7) % 7;
  date.setDate(date.getDate() + delta);
  return toCalendarDate(date);
}

/**
 * Normalise a MySQL DATE (returned as a JS `Date` at local midnight) to a plain
 * `YYYY-MM-DD` calendar string.
 *
 * `Date.toISOString()` cannot be used here: the server runs east of UTC, so a
 * local-midnight `Date` serialises to the *previous* day. Reading the local
 * components keeps the calendar date the calendar has.
 */
function toCalendarDate(value) {
  if (!value) return value;
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

class LongitudinalService {
  /**
   * Bring the CCC tables up to the shape this feature needs.
   *
   * Two additive, idempotent changes, safe to call on every request:
   *
   *  - `longitudinal_clinic_types.display_order` gives every clinic a stable
   *    matrix column position. Renaming a clinic never moves its column, and
   *    deleting one never re-numbers the rest — which matters because a column's
   *    slot data is stored by `primary_care_clinic_slots.clinic_number`.
   *  - `primary_care_absences` is the leave registry the Leaves column writes to:
   *    one row per person (resident or faculty) absent on a CCC day.
   */
  static async ensureSchema() {
    if (this._schemaReady) return;

    const [orderColumn] = await db.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'longitudinal_clinic_types'
          AND COLUMN_NAME = 'display_order'`
    );
    if (orderColumn.length === 0) {
      await db.query(
        'ALTER TABLE longitudinal_clinic_types ADD COLUMN display_order INT NULL AFTER clinic_name'
      );
    }

    // Ensure faculty_supervisors has the new objective fields.
    // These are additive; existing rows get NULL until populated.
    const [ftitle] = await db.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'faculty_supervisors'
          AND COLUMN_NAME = 'clinical_title'`
    );
    if (ftitle.length === 0) {
      await db.query(
        'ALTER TABLE faculty_supervisors ADD COLUMN clinical_title VARCHAR(50) NULL AFTER specialty'
      );
    }
    const [fappointment] = await db.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'faculty_supervisors'
          AND COLUMN_NAME = 'faculty_appointment'`
    );
    if (fappointment.length === 0) {
      await db.query(
        'ALTER TABLE faculty_supervisors ADD COLUMN faculty_appointment VARCHAR(50) NULL AFTER clinical_title'
      );
    }
    const [fadmin] = await db.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'faculty_supervisors'
          AND COLUMN_NAME = 'administrative_role'`
    );
    if (fadmin.length === 0) {
      await db.query(
        'ALTER TABLE faculty_supervisors ADD COLUMN administrative_role VARCHAR(50) NULL AFTER faculty_appointment'
      );
    }

    // Backfill a position for any clinic that has none yet, per programme, in
    // creation order so the seeded defaults keep their published order.
    const [unordered] = await db.query(
      'SELECT id, program_id FROM longitudinal_clinic_types WHERE display_order IS NULL ORDER BY program_id ASC, id ASC'
    );
    const nextByProgram = new Map();
    for (const row of unordered) {
      const program = Number(row.program_id);
      if (!nextByProgram.has(program)) {
        const [maxRows] = await db.query(
          'SELECT COALESCE(MAX(display_order), 0) AS max_order FROM longitudinal_clinic_types WHERE program_id = ?',
          [program]
        );
        nextByProgram.set(program, Number(maxRows[0]?.max_order) || 0);
      }
      const next = nextByProgram.get(program) + 1;
      await db.query('UPDATE longitudinal_clinic_types SET display_order = ? WHERE id = ?', [next, row.id]);
      nextByProgram.set(program, next);
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS primary_care_absences (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        program_id BIGINT UNSIGNED NOT NULL,
        cycle_id BIGINT UNSIGNED NULL,
        daily_header_id BIGINT UNSIGNED NULL,
        day_of_week VARCHAR(20) NOT NULL,
        absence_date DATE NULL,
        person_type ENUM('RESIDENT','FACULTY') NOT NULL,
        resident_id BIGINT UNSIGNED NULL,
        faculty_id BIGINT UNSIGNED NULL,
        person_name VARCHAR(200) NOT NULL,
        leave_type VARCHAR(40) NOT NULL DEFAULT 'OTHER_LEAVE',
        coverage_notes VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_primary_care_absences_program_day (program_id, day_of_week),
        KEY idx_primary_care_absences_header (daily_header_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // The numbered clinic columns of the CCC grid. A row per column position,
    // with `clinic_number` doubling as the slot key. `label` may be null, in
    // which case the column renders as "Clinic N". A hidden sentinel row at
    // clinic_number 0 marks a programme whose defaults have been materialised,
    // so removing a default column is never undone by a later read.
    await db.query(`
      CREATE TABLE IF NOT EXISTS primary_care_clinic_columns (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        program_id BIGINT UNSIGNED NOT NULL,
        clinic_number INT NOT NULL,
        label VARCHAR(120) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_primary_care_clinic_columns_program_number (program_id, clinic_number)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // The CCC cycle now owns its rotation window: `rotation_window_months`
    // (4 weeks per month), the derived `total_weeks` and the inclusive
    // `end_date` (`start_date + total_weeks * 7 - 1` days). All three are
    // additive, so older databases get the columns on the next read.
    const cycleColumns = [
      ['rotation_window_months', 'INT NULL'],
      ['total_weeks', 'INT NULL'],
      ['end_date', 'DATE NULL'],
    ];
    for (const [column, definition] of cycleColumns) {
      const [existingColumn] = await db.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'primary_care_cycles'
            AND COLUMN_NAME = ?`,
        [column]
      );
      if (existingColumn.length === 0) {
        await db.query(`ALTER TABLE primary_care_cycles ADD COLUMN ${column} ${definition}`);
      }
    }

    this._schemaReady = true;
  }

  static async getClinicTypes(programId, { includeInactive = false } = {}) {
    await this.ensureSchema();
    let query = `
      SELECT id, program_id, clinic_code, clinic_name, display_order, default_day_of_week, start_time, end_time, requires_release_letter, is_active
      FROM longitudinal_clinic_types
      WHERE program_id = ?
    `;
    const params = [programId];
    if (!includeInactive) {
      query += ' AND is_active = 1';
    }
    query += ' ORDER BY (display_order IS NULL) ASC, display_order ASC, clinic_name ASC';
    const [rows] = await db.query(query, params);
    return rows;
  }

  /**
   * Add a clinic to a programme's catalog, or bring an existing one back.
   *
   * The Continuity of Care Clinics (CCC) view grows its chip pool from `longitudinal_clinic_types`,
   * so "add a clinic" ends here. The name is the identity a coordinator sees, but the
   * table keys on `(program_id, clinic_code)`; a clinic that is already on record —
   * active or not — is therefore found by name (case-insensitively, via the column
   * collation) and **reactivated**, so a clinic removed from the default pool still
   * comes back with the same row, code and assignment history. A genuinely new name
   * gets a code derived from it, made unique per programme, and is inserted active —
   * which is exactly what makes a hand-typed custom clinic persist for the programme.
   *
   * Only fields the caller actually sent are written: re-adding a clinic never clobbers
   * its recorded day or times.
   *
   * @param {object} data
   * @param {number} data.program_id
   * @param {string} data.clinic_name
   * @param {string} [data.clinic_code]
   * @param {string} [data.default_day_of_week]
   * @param {string} [data.start_time]
   * @param {string} [data.end_time]
   * @param {number} [data.requires_release_letter]
   */
  static async createClinicType(data) {
    const programId = Number(data.program_id);
    const clinicName = String(data.clinic_name ?? '').trim();
    if (!programId || !clinicName) {
      const error = new Error('program_id and a non-empty clinic_name are required.');
      error.statusCode = 400;
      throw error;
    }

    // Settable columns, in the order `getClinicTypes` selects them.
    const fields = {
      clinic_code: data.clinic_code ? String(data.clinic_code).trim() : undefined,
      clinic_name: clinicName,
      default_day_of_week: data.default_day_of_week || undefined,
      start_time: data.start_time ? String(data.start_time).slice(0, 5) : undefined,
      end_time: data.end_time ? String(data.end_time).slice(0, 5) : undefined,
      requires_release_letter:
        data.requires_release_letter !== undefined ? (data.requires_release_letter ? 1 : 0) : undefined,
    };

    const [matches] = await db.query(
      'SELECT id FROM longitudinal_clinic_types WHERE program_id = ? AND clinic_name = ? ORDER BY id ASC LIMIT 1',
      [programId, clinicName]
    );
    const existing = matches[0];

    let clinicId;
    if (existing) {
      clinicId = existing.id;
      const sets = ['updated_at = CURRENT_TIMESTAMP'];
      const params = [];
      for (const [column, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        sets.push(`${column} = ?`);
        params.push(value);
      }
      sets.push('is_active = 1');
      params.push(clinicId);
      await db.query(`UPDATE longitudinal_clinic_types SET ${sets.join(', ')} WHERE id = ?`, params);
    } else {
      const baseCode = deriveClinicCode(fields.clinic_code || clinicName);
      const code = await this.ensureUniqueClinicCode(programId, baseCode);
      // A new clinic takes the next free column position, so it is appended to
      // the matrix rather than landing in the middle of the existing columns.
      const [maxRows] = await db.query(
        'SELECT COALESCE(MAX(display_order), 0) AS max_order FROM longitudinal_clinic_types WHERE program_id = ?',
        [programId]
      );
      const displayOrder = (Number(maxRows[0]?.max_order) || 0) + 1;
      const [result] = await db.query(
        `INSERT INTO longitudinal_clinic_types
           (program_id, clinic_code, clinic_name, display_order, default_day_of_week, start_time, end_time, requires_release_letter, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          programId,
          code,
          fields.clinic_name,
          displayOrder,
          fields.default_day_of_week || null,
          fields.start_time || null,
          fields.end_time || null,
          fields.requires_release_letter ?? 0,
        ]
      );
      clinicId = result.insertId;
    }

    const [rows] = await db.query(
      `SELECT id, program_id, clinic_code, clinic_name, display_order, default_day_of_week, start_time, end_time, requires_release_letter, is_active
       FROM longitudinal_clinic_types WHERE id = ?`,
      [clinicId]
    );
    return rows[0];
  }

  /** The first `baseCode`, `baseCode 2`, … `baseCode N` not taken in this programme. */
  static async ensureUniqueClinicCode(programId, baseCode) {
    let candidate = baseCode;
    let suffix = 2;
    for (;;) {
      const [rows] = await db.query(
        'SELECT id FROM longitudinal_clinic_types WHERE program_id = ? AND clinic_code = ? LIMIT 1',
        [programId, candidate]
      );
      if (rows.length === 0) return candidate;
      candidate = `${String(baseCode).slice(0, 47)} ${suffix}`;
      suffix += 1;
    }
  }

  /** The `longitudinal_clinic_types` row for an id, scoped to one programme. */
  static async findClinicType(clinicTypeId, programId) {
    const [rows] = await db.query(
      `SELECT id, program_id, clinic_code, clinic_name, display_order, default_day_of_week, start_time, end_time, requires_release_letter, is_active
       FROM longitudinal_clinic_types
       WHERE id = ? AND program_id = ?`,
      [clinicTypeId, programId]
    );
    return rows[0] || null;
  }

  /**
   * Rename (or otherwise edit) one of the programme's clinics.
   *
   * The row keeps its `id` and `clinic_code`, so the rename is transparent to
   * everything that already references the clinic by id — slots, supervisor
   * pairings and resident assignments all keep working; only the label every
   * screen displays changes. Only fields the caller actually sent are written,
   * matching `createClinicType`.
   *
   * A rename is rejected when the new name already belongs to another row of
   * the same programme, active or not: the client finds clinics by name, and
   * two rows answering to the same name would make the chip pool ambiguous.
   *
   * @param {number} clinicTypeId
   * @param {number} programId
   * @param {object} data
   * @param {string} [data.clinic_name]
   * @param {string} [data.default_day_of_week]
   * @param {string} [data.start_time]
   * @param {string} [data.end_time]
   * @param {number} [data.requires_release_letter]
   */
  static async updateClinicType(clinicTypeId, programId, data = {}) {
    const id = Number(clinicTypeId);
    if (!Number.isInteger(id) || id <= 0) {
      const error = new Error('A numeric clinic id is required.');
      error.statusCode = 400;
      throw error;
    }
    const program = Number(programId);
    if (!Number.isInteger(program) || program <= 0) {
      const error = new Error('program_id is required.');
      error.statusCode = 400;
      throw error;
    }

    const existing = await this.findClinicType(id, program);
    if (!existing) {
      const error = new Error(`Clinic ${id} was not found for this programme.`);
      error.statusCode = 404;
      throw error;
    }

    const fields = {};
    if (data.clinic_name !== undefined) {
      const clinicName = String(data.clinic_name ?? '').trim();
      if (!clinicName) {
        const error = new Error('clinic_name cannot be empty.');
        error.statusCode = 400;
        throw error;
      }
      fields.clinic_name = clinicName;

      const [dupes] = await db.query(
        `SELECT id FROM longitudinal_clinic_types
          WHERE program_id = ? AND clinic_name = ? AND id <> ?
          ORDER BY id ASC LIMIT 1`,
        [program, clinicName, id]
      );
      if (dupes.length > 0) {
        const error = new Error(`A clinic named "${clinicName}" already exists for this programme.`);
        error.statusCode = 409;
        throw error;
      }
    }
    if (data.default_day_of_week !== undefined) {
      fields.default_day_of_week = data.default_day_of_week || null;
    }
    if (data.start_time !== undefined) {
      fields.start_time = data.start_time ? String(data.start_time).slice(0, 5) : null;
    }
    if (data.end_time !== undefined) {
      fields.end_time = data.end_time ? String(data.end_time).slice(0, 5) : null;
    }
    if (data.requires_release_letter !== undefined) {
      fields.requires_release_letter = data.requires_release_letter ? 1 : 0;
    }

    if (Object.keys(fields).length === 0) {
      const error = new Error('Nothing to update. Provide at least one field to change.');
      error.statusCode = 400;
      throw error;
    }

    const sets = [...Object.keys(fields).map((column) => `${column} = ?`), 'updated_at = CURRENT_TIMESTAMP'];
    await db.query(
      `UPDATE longitudinal_clinic_types SET ${sets.join(', ')} WHERE id = ? AND program_id = ?`,
      [...Object.values(fields), id, program]
    );

    return this.findClinicType(id, program);
  }

  /**
   * Soft-delete a clinic from the programme's available pool.
   *
   * The row is deactivated (`is_active = 0`) rather than removed, so the slots,
   * supervisor pairings and resident assignments that reference it keep their
   * ids and stay resolvable — historical data is preserved, which is the point
   * of the confirmation copy the client shows before calling this. A clinic
   * brought back later (via `createClinicType`) is reactivated with the same
   * row and code.
   *
   * @returns {Promise<{id: number, clinic_name: string, is_active: number}>}
   */
  static async deleteClinicType(clinicTypeId, programId) {
    const id = Number(clinicTypeId);
    if (!Number.isInteger(id) || id <= 0) {
      const error = new Error('A numeric clinic id is required.');
      error.statusCode = 400;
      throw error;
    }
    const program = Number(programId);
    if (!Number.isInteger(program) || program <= 0) {
      const error = new Error('program_id is required.');
      error.statusCode = 400;
      throw error;
    }

    const existing = await this.findClinicType(id, program);
    if (!existing) {
      const error = new Error(`Clinic ${id} was not found for this programme.`);
      error.statusCode = 404;
      throw error;
    }

    await db.query(
      'UPDATE longitudinal_clinic_types SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND program_id = ?',
      [id, program]
    );

    return { id, clinic_name: existing.clinic_name, clinic_code: existing.clinic_code, is_active: 0 };
  }

  /**
   * Seed the five standard Continuity of Care Clinics (CCC) for every programme.
   *
   * Called at server boot and idempotent by construction: existing rows are
   * matched by name and reactivated (never duplicated, never anything removed),
   * and programmes that have no clinic records yet get the standard five. This is
   * the only place new programmes receive their default pool; everything else a
   * coordinator adds flows through `createClinicType`.
   *
   * @returns {Promise<object[]>} The seeded clinics.
   */
  static async ensureDefaultClinics() {
    const [programs] = await db.query('SELECT id FROM programs ORDER BY id ASC');
    const seeded = [];
    for (const program of programs) {
      for (const clinic of PRIMARY_CARE_DEFAULT_CLINICS) {
        const row = await this.createClinicType({
          program_id: program.id,
          clinic_name: clinic.clinic_name,
          clinic_code: clinic.code,
          default_day_of_week: clinic.default_day_of_week,
          start_time: clinic.start_time,
          end_time: clinic.end_time,
          requires_release_letter: clinic.requires_release_letter,
        });
        seeded.push(row);
      }
    }
    return seeded;
  }

  static async getResidentLongitudinalAssignments(residentId) {
    const query = `
      SELECT
        rla.id AS longitudinal_assignment_id,
        rla.resident_id,
        rla.clinic_type_id,
        lct.clinic_code,
        lct.clinic_name,
        rla.site_name,
        rla.supervisor_name,
        rla.faculty_supervisor_id,
        rla.day_of_week,
        rla.start_time,
        rla.end_time,
        rla.start_date,
        rla.end_date,
        rla.is_active,
        rla.requires_release_letter,
        rla.release_letter_generated,
        rla.notes
      FROM resident_longitudinal_assignments rla
      JOIN longitudinal_clinic_types lct ON lct.id = rla.clinic_type_id
      WHERE rla.resident_id = ?
      ORDER BY rla.start_date ASC
    `;
    const [rows] = await db.query(query, [residentId]);
    return rows;
  }

  /**
   * Every longitudinal assignment in a programme, optionally scoped to a year.
   *
   * `longitudinal_assignments` carries no `academic_year` column, so a year has to
   * be resolved through the date window the assignment actually covers — the same
   * overlap test `getLongitudinalMatrix` uses, against the programme's rotation
   * blocks for that year. Omitting `academicYear` keeps the unfiltered behaviour,
   * which is what the resident's own profile needs: a resident wants their whole
   * longitudinal record, not the slice for the year currently selected.
   */
  static async getAllLongitudinalAssignments(programId, academicYear = null) {
    let query = `
      SELECT
        rla.id AS longitudinal_assignment_id,
        rla.resident_id,
        CONCAT(r.first_name, ' ', r.last_name) AS resident_name,
        rla.clinic_type_id,
        lct.clinic_code,
        lct.clinic_name,
        rla.site_name,
        rla.supervisor_name,
        rla.faculty_supervisor_id,
        rla.day_of_week,
        rla.start_time,
        rla.end_time,
        rla.start_date,
        rla.end_date,
        rla.is_active,
        re.year_in_program AS pgy_level
      FROM resident_longitudinal_assignments rla
      JOIN longitudinal_clinic_types lct ON lct.id = rla.clinic_type_id
      JOIN residents r ON r.id = rla.resident_id
      LEFT JOIN residency_enrollments re ON re.resident_id = r.id
      WHERE lct.program_id = ?
    `;
    const params = [programId];

    if (academicYear) {
      const scopes = await RotationService.getAcademicYearScopes(academicYear, programId);
      if (scopes.length === 0) return [];

      // One scope per program; the programme is already pinned, so the first is
      // the whole window. The overlap test is deliberately permissive: an
      // assignment with open-ended dates belongs to every year it touches.
      const scope = scopes[0];
      query += ` AND (rla.start_date IS NULL OR rla.start_date <= ?)
                AND (rla.end_date IS NULL OR rla.end_date >= ?)`;
      params.push(scope.window_end, scope.window_start);
    }

    query += ' ORDER BY lct.clinic_name ASC, rla.day_of_week ASC';

    const [rows] = await db.query(query, params);
    return rows;
  }

  /**
   * Faculty who can supervise a longitudinal clinic.
   *
   * The supervisor form could never offer a selection because this list came back
   * empty: `getFacultySupervisors` matched on `program_id` alone and the table
   * carries rows for every department in the hospital, most of them not supervising
   * this programme — and, before this change, departed faculty as well. It now
   * filters to active faculty registered against the programme, which is what
   * "supervising faculty" means in a supervision assignment, and reports which
   * of the programme's clinics each person already supervises so the assignment
   * screen can label an option.
   *
   * Departed faculty stay reachable with `includeInactive`, because a record of a
   * posting that has already ended must still be editable.
   *
   * The CCC matrix needs faculty names already carrying the institutional `Dr.`
   * title, so `display_name` is concatenated on the server — one spelling of the
   * rule rather than one per screen.
   *
   * @param {number} programId
   * @param {object} [options]
   * @param {boolean} [options.includeInactive=false]
   * @param {number} [options.clinicTypeId] - Also report covered clinic types.
   */
  static async getFacultySupervisors(programId, { includeInactive = false, clinicTypeId } = {}) {
    let query = `
      SELECT id, program_id, first_name, last_name, title, clinical_title, faculty_appointment, administrative_role, email, phone, specialty, is_active,
             CONCAT('Dr. ', first_name, ' ', last_name) AS display_name
      FROM faculty_supervisors
      WHERE program_id = ?
    `;
    const params = [programId];
    if (!includeInactive) {
      query += ' AND is_active = 1';
    }
    query += ' ORDER BY last_name ASC, first_name ASC';

    const [rows] = await db.query(query, params);
    if (!clinicTypeId || rows.length === 0) return rows;

    // Which clinics each of these faculty already supervise, for the option label.
    const placeholders = rows.map(() => '?').join(', ');
    const [links] = await db.query(
      `SELECT faculty_supervisor_id, clinic_type_id
       FROM longitudinal_clinic_supervisor_assignments
       WHERE clinic_type_id = ? AND faculty_supervisor_id IN (${placeholders}) AND is_active = 1`,
      [clinicTypeId, ...rows.map((row) => row.id)]
    );

    const byFaculty = new Map();
    for (const link of links) {
      const list = byFaculty.get(link.faculty_supervisor_id) ?? [];
      list.push(link.clinic_type_id);
      byFaculty.set(link.faculty_supervisor_id, list);
    }

    return rows.map((row) => ({ ...row, clinic_type_ids: byFaculty.get(row.id) ?? [] }));
  }

  static async getClinicSlots(clinicTypeId) {
    const query = `
      SELECT
        id,
        clinic_type_id,
        slot_number,
        slot_label,
        day_of_week,
        TIME_FORMAT(start_time, '%H:%i') AS start_time,
        TIME_FORMAT(end_time, '%H:%i') AS end_time,
        site_name,
        notes,
        is_active
      FROM longitudinal_clinic_slots
      WHERE clinic_type_id = ?
      ORDER BY slot_number ASC
    `;
    const [rows] = await db.query(query, [clinicTypeId]);
    return rows;
  }

  static async getSupervisorAssignments(programId, clinicTypeId = null) {
    let query = `
      SELECT
        lsa.id,
        lsa.program_id,
        lsa.clinic_type_id,
        lct.clinic_code,
        lct.clinic_name,
        lsa.longitudinal_assignment_id,
        lsa.longitudinal_clinic_slot_id,
        lsa.faculty_supervisor_id,
        CONCAT('Dr. ', fs.first_name, ' ', fs.last_name) AS faculty_supervisor_name,
        fs.title AS faculty_title,
        fs.is_active AS faculty_is_active,
        lsa.resident_id,
        CONCAT(r.first_name, ' ', r.last_name) AS resident_name,
        lsa.start_date,
        lsa.end_date,
        DATE_FORMAT(lsa.start_date, '%Y-%m-%d') AS start_date_iso,
        DATE_FORMAT(lsa.end_date, '%Y-%m-%d') AS end_date_iso,
        lsa.rotation_period_months,
        lsa.is_primary,
        lsa.is_active,
        lsa.notes,
        lcs.slot_number,
        lcs.slot_label,
        lcs.day_of_week AS slot_day_of_week,
        lcs.site_name AS slot_site_name
      FROM longitudinal_clinic_supervisor_assignments lsa
      JOIN faculty_supervisors fs ON fs.id = lsa.faculty_supervisor_id
      JOIN longitudinal_clinic_types lct ON lct.id = lsa.clinic_type_id
      LEFT JOIN residents r ON r.id = lsa.resident_id
      LEFT JOIN longitudinal_clinic_slots lcs ON lcs.id = lsa.longitudinal_clinic_slot_id
      WHERE lsa.program_id = ?
    `;
    const params = [programId];
    if (clinicTypeId) {
      query += ' AND lsa.clinic_type_id = ?';
      params.push(clinicTypeId);
    }
    query += ' ORDER BY lsa.start_date DESC';
    const [rows] = await db.query(query, params);
    return rows;
  }

  /**
   * Create a faculty supervision assignment.
   *
   * The end date is the *evaluation* end date: a supervision posting runs for
   * `rotation_period_months` (three by default) from the start date, so the end
   * is derived rather than typed. A coordinator who sets a start date and an end
   * date that disagrees with the three-month period is asking for one of them to
   * be wrong, so an explicit mismatch is rejected with the derived date in the
   * message instead of being silently overwritten.
   */
  static async createSupervisorAssignment(data) {
    const {
      program_id,
      clinic_type_id,
      longitudinal_assignment_id,
      longitudinal_clinic_slot_id,
      faculty_supervisor_id,
      resident_id,
      start_date,
      end_date,
      is_primary,
      rotation_period_months,
      notes,
    } = data;

    const months = Number(rotation_period_months) > 0 ? Number(rotation_period_months) : 3;
    const derivedEnd = addMonths(start_date, months);

    if (!derivedEnd) {
      const error = new Error('start_date must be a real date in YYYY-MM-DD form.');
      error.statusCode = 400;
      throw error;
    }

    if (end_date && String(end_date).slice(0, 10) !== derivedEnd) {
      const error = new Error(
        `A ${months}-month supervision period starting ${String(start_date).slice(0, 10)} ends on ${derivedEnd}, not ${String(end_date).slice(0, 10)}.`
      );
      error.statusCode = 400;
      throw error;
    }

    const query = `
      INSERT INTO longitudinal_clinic_supervisor_assignments
        (program_id, clinic_type_id, longitudinal_assignment_id, longitudinal_clinic_slot_id, faculty_supervisor_id, resident_id,
         start_date, end_date, is_primary, rotation_period_months, notes, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `;
    const [result] = await db.query(query, [
      program_id,
      clinic_type_id,
      longitudinal_assignment_id || null,
      longitudinal_clinic_slot_id || null,
      faculty_supervisor_id,
      resident_id || null,
      String(start_date).slice(0, 10),
      derivedEnd,
      is_primary !== undefined ? (is_primary ? 1 : 0) : 1,
      months,
      notes || null,
    ]);

    return {
      id: result.insertId,
      ...data,
      start_date: String(start_date).slice(0, 10),
      end_date: derivedEnd,
      rotation_period_months: months,
      period_label: `${months} month${months === 1 ? '' : 's'} · ${describeWindow(String(start_date).slice(0, 10), derivedEnd)}`,
    };
  }

  static async rotateSupervisor(assignmentId, newSupervisorId, newStartDate, newEndDate, notes) {
    const query = `
      UPDATE longitudinal_clinic_supervisor_assignments
      SET faculty_supervisor_id = ?, start_date = ?, end_date = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;
    const [result] = await db.query(query, [newSupervisorId, newStartDate, newEndDate, notes || null, assignmentId]);
    return { affectedRows: result.affectedRows };
  }

  /**
   * Longitudinal Matrix: one row per resident per longitudinal clinic type.
   *
   * Longitudials run the whole year rather than sitting inside a rotation
   * block, so the academic year is resolved through rotation_blocks to get the
   * program(s) and the calendar window (see
   * RotationService.getAcademicYearScopes). An assignment counts as covering
   * that year when it overlaps the window -- which includes it, rather than
   * being fully contained by it, because a clinic running the full academic
   * year extends past both ends of the block calendar.
   *
   * LEFT JOINs keep unassigned cells visible, so the matrix doubles as the
   * clinic coverage report the coordinator needs to spot gaps.
   *
   * Row grain is one resident/clinic/assignment; `assignment_count` reports how
   * many assignments share that cell.
   *
   * @param {object} filters
   * @param {string} filters.academic_year - Required. Accepts "2026/2027" or "2026-2027".
   * @param {number} [filters.program_id]
   * @param {number} [filters.pgy_level]
   * @param {string} [filters.resident_status]
   */
  static async getLongitudinalMatrix(filters = {}) {
    const { pgy_level, resident_status } = filters;
    // `getAcademicYearScopes` matches both the hyphenated and slash spellings of
    // the year, so it is handed whatever the caller sent.
    const academicYear = filters.academic_year;
    const programId = filters.program_id || null;

    const scopes = await RotationService.getAcademicYearScopes(academicYear, programId);
    if (scopes.length === 0) return [];

    const placeholders = scopes.map(() => '?').join(', ');
    const windowConditions = scopes
      .map(
        () =>
          `(
            (rla.start_date IS NULL OR rla.start_date <= ?) AND
            (rla.end_date IS NULL OR rla.end_date >= ?)
          )`
      )
      .join(' OR ');

    // Placeholders bind in SQL text order: the window conditions live in the
    // LEFT JOIN ON clause, which is emitted before the WHERE clause.
    const windowParams = [];
    for (const scope of scopes) {
      windowParams.push(scope.window_end, scope.window_start);
    }
    const params = [...windowParams, ...scopes.map((scope) => scope.program_id)];

    let query = `
      SELECT
        re.resident_id,
        CONCAT(r.first_name, ' ', COALESCE(r.middle_initial, ''), ' ', r.last_name) AS resident_name,
        ${PRIMARY_IDENTIFIER_SQL} AS employee_id,
        re.year_in_program AS pgy_level,
        re.resident_status,
        re.program_id,
        p.program_code,
        lct.id AS clinic_type_id,
        lct.clinic_code,
        lct.clinic_name,
        lct.default_day_of_week,
        lct.start_time AS default_start_time,
        lct.end_time AS default_end_time,
        lct.requires_release_letter,
        lct.is_active AS clinic_type_is_active,
        rla.id AS longitudinal_assignment_id,
        rla.site_name,
        rla.site_id,
        rla.day_of_week,
        rla.start_time,
        rla.end_time,
        rla.start_date,
        rla.end_date,
        rla.faculty_supervisor_id,
        CONCAT('Dr. ', fs.first_name, ' ', fs.last_name) AS faculty_supervisor_name,
        rla.supervisor_name,
        rla.is_active,
        rla.requires_release_letter AS assignment_requires_release_letter,
        rla.release_letter_generated,
        rla.notes,
        (rla.id IS NOT NULL) AS is_assigned,
        (
          SELECT COUNT(*)
          FROM resident_longitudinal_assignments cell_rla
          WHERE cell_rla.resident_id = re.resident_id
            AND cell_rla.clinic_type_id = lct.id
        ) AS assignment_count
      FROM longitudinal_clinic_types lct
      JOIN programs p ON p.id = lct.program_id
      JOIN residency_enrollments re ON re.program_id = lct.program_id
      JOIN residents r ON r.id = re.resident_id
      LEFT JOIN resident_longitudinal_assignments rla
        ON rla.resident_id = re.resident_id
       AND rla.clinic_type_id = lct.id
       AND (${windowConditions})
      LEFT JOIN faculty_supervisors fs ON fs.id = rla.faculty_supervisor_id
      WHERE lct.program_id IN (${placeholders})
    `;

    if (pgy_level) { query += ' AND re.year_in_program = ?'; params.push(pgy_level); }
    if (resident_status) { query += ' AND re.resident_status = ?'; params.push(resident_status); }
    query +=
      ' ORDER BY re.year_in_program ASC, r.last_name ASC, r.first_name ASC, lct.clinic_name ASC';

    const [rows] = await db.query(query, params);
    return rows;
  }

  /**
   * Every CCC cycle a programme has, oldest first.
   *
   * Cycles carry no `academic_year` column — the year falls out of the
   * `start_date` — so the week navigator builds its academic-year filter from
   * these start dates rather than a stored value.
   *
   * @param {number} programId
   */
  static async getCycles(programId) {
    const [rows] = await db.query(
      'SELECT * FROM primary_care_cycles WHERE program_id = ? ORDER BY start_date ASC, id ASC',
      [programId]
    );
    return rows.map((row) => ({ ...row, start_date: toCalendarDate(row.start_date) }));
  }

  /**
   * The CCC cycle-schedule matrix: one header row per academic day, the clinic
   * slots attached to it, the In-Charge faculty lead, and the backup pools.
   *
   * The cycle header is created on first read rather than requiring a separate
   * call, and every day is guaranteed to have its twelve fixed columns (ten
   * clinics plus WBC and Leaves) so the grid is legible before a coordinator has
   * entered anything.
   *
   * @param {number} programId
   * @param {object} [options]
   * @param {number|string} [options.cycleId] - Defaults to the latest cycle.
   */
  /**
   * The numbered clinic columns of the CCC grid, e.g. `Clinic 1` .. `Clinic 12`.
   *
   * A programme with no columns yet gets the default ten on first read. Columns
   * are never renumbered: `clinic_number` is the stable slot key, so renaming a
   * column never moves its slot data and adding or deleting one never shifts the
   * others.
   */
  static async getMatrixColumns(programId) {
    await this.ensureClinicColumns(programId);
    const [rows] = await db.query(
      `SELECT clinic_number, label FROM primary_care_clinic_columns
        WHERE program_id = ? AND clinic_number > 0
        ORDER BY clinic_number ASC`,
      [programId]
    );
    return rows;
  }

  /**
   * Materialise the default `Clinic 1..N` columns once per programme.
   *
   * Guarded by a sentinel row at `clinic_number = 0`, so the defaults are created
   * exactly once — deleting one later stays deleted rather than being resurrected
   * on the next read.
   */
  static async ensureClinicColumns(programId) {
    const [flag] = await db.query(
      'SELECT 1 FROM primary_care_clinic_columns WHERE program_id = ? AND clinic_number = 0 LIMIT 1',
      [programId]
    );
    if (flag.length > 0) return;
    const params = [];
    const values = [];
    for (let number = 0; number <= DEFAULT_CLINIC_COLUMN_COUNT; number += 1) {
      params.push(programId, number);
      values.push('(?, ?)');
    }
    await db.query(
      `INSERT IGNORE INTO primary_care_clinic_columns (program_id, clinic_number) VALUES ${values.join(', ')}`,
      params
    );
  }

  /**
   * Append a new column (`Clinic N+1`) at the end of the grid.
   *
   * Returns the full column list afterwards so the caller can refresh its grid
   * from one response.
   */
  static async addClinicColumn(programId) {
    await this.ensureClinicColumns(programId);
    const [maxRows] = await db.query(
      'SELECT MAX(clinic_number) AS max_number FROM primary_care_clinic_columns WHERE program_id = ?',
      [programId]
    );
    const next = (Number(maxRows[0]?.max_number) || DEFAULT_CLINIC_COLUMN_COUNT) + 1;
    if (next > MAX_CLINIC_COLUMN_COUNT) {
      const error = new Error(`A CCC grid can hold at most ${MAX_CLINIC_COLUMN_COUNT} clinic columns.`);
      error.statusCode = 400;
      throw error;
    }
    await db.query(
      'INSERT INTO primary_care_clinic_columns (program_id, clinic_number) VALUES (?, ?)',
      [programId, next]
    );
    return this.getMatrixColumns(programId);
  }

  /** Rename a clinic column's label. An empty label reverts to "Clinic N". */
  static async renameClinicColumn(programId, clinicNumber, label) {
    const number = Number(clinicNumber);
    if (!Number.isInteger(number) || number < 1 || number > MAX_CLINIC_COLUMN_COUNT) {
      const error = new Error('clinic_number must be a whole number between 1 and 99.');
      error.statusCode = 400;
      throw error;
    }
    const [rows] = await db.query(
      'SELECT 1 FROM primary_care_clinic_columns WHERE program_id = ? AND clinic_number = ? AND clinic_number > 0 LIMIT 1',
      [programId, number]
    );
    if (rows.length === 0) {
      const error = new Error('clinic column not found.');
      error.statusCode = 404;
      throw error;
    }
    const clean = String(label ?? '').trim().slice(0, 120) || null;
    await db.query(
      'UPDATE primary_care_clinic_columns SET label = ? WHERE program_id = ? AND clinic_number = ?',
      [clean, programId, number]
    );
    return this.getMatrixColumns(programId);
  }

  /** Remove a clinic column from the grid. Its historical slot rows are kept. */
  static async deleteClinicColumn(programId, clinicNumber) {
    const number = Number(clinicNumber);
    if (!Number.isInteger(number) || number < 1 || number > MAX_CLINIC_COLUMN_COUNT) {
      const error = new Error('clinic_number must be a whole number between 1 and 99.');
      error.statusCode = 400;
      throw error;
    }
    await db.query(
      'DELETE FROM primary_care_clinic_columns WHERE program_id = ? AND clinic_number = ?',
      [programId, number]
    );
    return this.getMatrixColumns(programId);
  }

  static async getCycleSchedule(programId, options = {}) {
    await this.ensureSchema();
    const { cycleId } = options;
    let cycle = null;
    if (cycleId) {
      const [cycles] = await db.query('SELECT * FROM primary_care_cycles WHERE id = ? AND program_id = ?', [cycleId, programId]);
      cycle = cycles[0] || null;
    } else {
      const [cycles] = await db.query('SELECT * FROM primary_care_cycles WHERE program_id = ? ORDER BY id DESC LIMIT 1', [programId]);
      cycle = cycles[0] || null;
    }

    // A programme with no cycle yet gets one now. Materialising it here (rather
    // than returning a cycle with a null id) keeps every later read and write
    // anchored to a real row.
    if (!cycle) {
      const [res] = await db.query(
        'INSERT INTO primary_care_cycles (program_id, cycle_number, week_number, start_date) VALUES (?, ?, ?, ?)',
        [programId, 'Cycle 1', 'Week 1', new Date().toISOString().split('T')[0]]
      );
      const [rows] = await db.query('SELECT * FROM primary_care_cycles WHERE id = ?', [res.insertId]);
      cycle = rows[0];
    }

    cycle = { ...cycle, start_date: toCalendarDate(cycle.start_date) };

    for (const day of CCC_DAYS) {
      const [existing] = await db.query(
        'SELECT id FROM primary_care_daily_headers WHERE cycle_id = ? AND day_of_week = ? LIMIT 1',
        [cycle.id, day]
      );
      if (existing.length === 0) {
        await db.query(
          'INSERT INTO primary_care_daily_headers (cycle_id, day_of_week, shift_time, pgy_level) VALUES (?, ?, ?, ?)',
          [cycle.id, day, defaultShiftForDay(day), defaultPgyForDay(day)]
        );
      }
    }

    const [headers] = await db.query(
      'SELECT * FROM primary_care_daily_headers WHERE cycle_id = ? ORDER BY FIELD(day_of_week, ?, ?, ?, ?, ?)',
      [cycle.id, ...CCC_DAYS]
    );

    // The grid needs a slot for every clinic column, so a programme that has
    // added columns beyond the defaults still gets a cell to write into. Leaves
    // is not a slot, so the count is the columns themselves.
    const columns = await this.getMatrixColumns(programId);
    const maxClinicNumber = columns.reduce(
      (highest, column) => Math.max(highest, column.clinic_number),
      0
    );
    const requiredSlotCount = Math.max(DEFAULT_CLINIC_COLUMN_COUNT, maxClinicNumber);

    const allSlots = [];
    const headerIds = [];
    for (const header of headers) {
      headerIds.push(header.id);
      const [slots] = await db.query(
        'SELECT * FROM primary_care_clinic_slots WHERE daily_header_id = ? ORDER BY clinic_number',
        [header.id]
      );
      if (slots.length < requiredSlotCount) {
        const inserts = [];
        const existingNumbers = new Set(slots.map((slot) => slot.clinic_number));
        for (let i = 1; i <= requiredSlotCount; i += 1) {
          if (!existingNumbers.has(i)) inserts.push([header.id, i, null, null, null, null]);
        }
        if (inserts.length > 0) {
          await db.query(
            'INSERT INTO primary_care_clinic_slots (daily_header_id, clinic_number, resident_1_name, resident_2_name, faculty_name, faculty_id) VALUES ?',
            [inserts]
          );
        }
        const [slots2] = await db.query(
          'SELECT * FROM primary_care_clinic_slots WHERE daily_header_id = ? ORDER BY clinic_number',
          [header.id]
        );
        allSlots.push(...slots2);
      } else {
        allSlots.push(...slots);
      }
    }

    const [backups] = await db.query(
      'SELECT * FROM primary_care_backup_faculty WHERE daily_header_id IN (?) ORDER BY priority_order ASC',
      [headerIds.length > 0 ? headerIds : [0]]
    );
    const backupsByDay = {};
    for (const backup of backups) {
      if (!backupsByDay[backup.day_of_week]) backupsByDay[backup.day_of_week] = [];
      backupsByDay[backup.day_of_week].push(backup);
    }

    // The Leaves column reads its badge summary from the absence registry; the
    // rows are returned with the rest of the cycle schedule so the grid needs a
    // single request.
    const [absenceRows] = await db.query(
      `SELECT * FROM primary_care_absences
        WHERE program_id = ? AND (cycle_id = ? OR cycle_id IS NULL)
        ORDER BY day_of_week ASC, person_type ASC, person_name ASC`,
      [programId, cycle.id]
    );
    const absences = absenceRows.map((row) => ({ ...row, absence_date: toCalendarDate(row.absence_date) }));

    return { cycle, dailyHeaders: headers, slots: allSlots, backups: backupsByDay, absences, columns };
  }

  /**
   * The absence / leave registry for a programme's CCC week.
   *
   * One row per person absent on a day, resident or faculty. Scoping by cycle
   * keeps two weeks' absences apart; `cycleId` may be omitted for a programme-wide
   * read.
   */
  static async getCycleAbsences(programId, cycleId = null) {
    await this.ensureSchema();
    const params = [programId];
    let query = 'SELECT * FROM primary_care_absences WHERE program_id = ?';
    if (cycleId) {
      query += ' AND (cycle_id = ? OR cycle_id IS NULL)';
      params.push(cycleId);
    }
    query += ' ORDER BY day_of_week ASC, person_type ASC, person_name ASC';
    const [rows] = await db.query(query, params);
    return rows.map((row) => ({ ...row, absence_date: toCalendarDate(row.absence_date) }));
  }

  /**
   * Replace one CCC day's absences — the write behind the Leaves column.
   *
   * The whole day is rewritten (delete-then-insert) so the modal's selection is
   * exactly what is stored: removing a name drops it, adding one records it, and
   * the leave reason applies to the batch. Resident absences are also mirrored
   * into `resident_attendance_logs` (marked with {@link CCC_LEAVE_NOTE}), which is
   * the canonical attendance record; faculty have no such table, so their rows
   * live only in the registry.
   *
   * @param {number} programId
   * @param {object} data
   * @param {number} [data.cycle_id]
   * @param {string} data.day_of_week
   * @param {string} [data.leave_type]
   * @param {string} [data.coverage_notes]
   * @param {{resident_id?:number, resident_name?:string, leave_type?:string}[]} [data.residents]
   * @param {{faculty_id?:number, faculty_name?:string, leave_type?:string}[]} [data.faculty]
   */
  static async updateDayAbsences(programId, data = {}) {
    await this.ensureSchema();
    const program = Number(programId);
    if (!Number.isInteger(program) || program <= 0) {
      const error = new Error('program_id is required.');
      error.statusCode = 400;
      throw error;
    }
    const dayOfWeek = String(data.day_of_week ?? '').trim();
    if (!dayOfWeek) {
      const error = new Error('day_of_week is required.');
      error.statusCode = 400;
      throw error;
    }

    const cycleId = data.cycle_id ? Number(data.cycle_id) : null;
    const defaultType = ABSENCE_LEAVE_TYPES.includes(data.leave_type) ? data.leave_type : 'OTHER_LEAVE';
    const coverageNotes = data.coverage_notes ? String(data.coverage_notes).slice(0, 255) : null;
    const residents = Array.isArray(data.residents) ? data.residents : [];
    const faculty = Array.isArray(data.faculty) ? data.faculty : [];

    const header = await this.resolveDailyHeader(program, cycleId, dayOfWeek);
    const resolvedCycleId = header?.cycle_id ?? cycleId;

    // The day's calendar date, for the attendance mirror. The CCC week starts on
    // the cycle's `start_date`; the CCC days run Sunday..Thursday.
    let absenceDate = null;
    if (resolvedCycleId) {
      const [cycleRows] = await db.query('SELECT start_date FROM primary_care_cycles WHERE id = ?', [resolvedCycleId]);
      absenceDate = dateForWeekday(cycleRows[0]?.start_date, cccWeekdayIndex(dayOfWeek));
    }

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      if (resolvedCycleId) {
        await connection.query(
          'DELETE FROM primary_care_absences WHERE program_id = ? AND cycle_id = ? AND day_of_week = ?',
          [program, resolvedCycleId, dayOfWeek]
        );
      } else {
        await connection.query(
          'DELETE FROM primary_care_absences WHERE program_id = ? AND cycle_id IS NULL AND day_of_week = ?',
          [program, dayOfWeek]
        );
      }

      for (const person of residents) {
        const name = formatResidentName(person.resident_name ?? person.name);
        if (!name) continue;
        const leaveType = ABSENCE_LEAVE_TYPES.includes(person.leave_type) ? person.leave_type : defaultType;
        const residentId = person.resident_id ? Number(person.resident_id) : null;
        await connection.query(
          `INSERT INTO primary_care_absences
             (program_id, cycle_id, daily_header_id, day_of_week, absence_date, person_type, resident_id, person_name, leave_type, coverage_notes)
           VALUES (?, ?, ?, ?, ?, 'RESIDENT', ?, ?, ?, ?)`,
          [program, resolvedCycleId, header?.id ?? null, dayOfWeek, absenceDate, residentId, name, leaveType, coverageNotes]
        );

        // Mirror into the canonical attendance log. Only rows this feature owns
        // are replaced, so a manually logged shift is never touched.
        if (residentId && absenceDate) {
          await connection.query(
            'DELETE FROM resident_attendance_logs WHERE resident_id = ? AND shift_date = ? AND notes = ?',
            [residentId, absenceDate, CCC_LEAVE_NOTE]
          );
          await connection.query(
            `INSERT INTO resident_attendance_logs
               (resident_id, shift_date, attendance_status, other_leave_specify, approval_status, notes)
             VALUES (?, ?, ?, ?, 'APPROVED', ?)`,
            [residentId, absenceDate, leaveType, coverageNotes, CCC_LEAVE_NOTE]
          );
        }
      }

      for (const person of faculty) {
        const name = formatFacultyName(person.faculty_name ?? person.name);
        if (!name) continue;
        const leaveType = ABSENCE_LEAVE_TYPES.includes(person.leave_type) ? person.leave_type : defaultType;
        const facultyId = person.faculty_id ? Number(person.faculty_id) : null;
        await connection.query(
          `INSERT INTO primary_care_absences
             (program_id, cycle_id, daily_header_id, day_of_week, absence_date, person_type, faculty_id, person_name, leave_type, coverage_notes)
           VALUES (?, ?, ?, ?, ?, 'FACULTY', ?, ?, ?, ?)`,
          [program, resolvedCycleId, header?.id ?? null, dayOfWeek, absenceDate, facultyId, name, leaveType, coverageNotes]
        );
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    return this.getCycleAbsences(program, resolvedCycleId);
  }

  /**
   * Update the cycle metadata and every day's shift / PGY / In-Charge lead.
   *
   * The In-Charge faculty value is normalised to a single `Dr.` prefix on write,
   * so the matrix never renders `Dr. Dr. Areen` after a coordinator types the
   * title themselves.
   */
  static async updateCycleHeader(programId, data = {}) {
    let cycleId = data.cycle_id;
    if (!cycleId) {
      const [cycles] = await db.query('SELECT * FROM primary_care_cycles WHERE program_id = ? ORDER BY id DESC LIMIT 1', [programId]);
      if (cycles.length > 0) cycleId = cycles[0].id;
      else {
        const [res] = await db.query(
          'INSERT INTO primary_care_cycles (program_id, cycle_number, week_number, start_date) VALUES (?, ?, ?, ?)',
          [programId, data.cycle_number || 'Cycle 1', data.week_number || 'Week 1', data.start_date || new Date().toISOString().split('T')[0]]
        );
        cycleId = res.insertId;
      }
    }

    const [currentRows] = await db.query('SELECT * FROM primary_care_cycles WHERE id = ?', [cycleId]);
    const current = currentRows[0];
    if (!current) {
      const e = new Error('Cycle not found.');
      e.statusCode = 404;
      throw e;
    }

    const cycleSets = [];
    const cycleParams = [];
    if (data.cycle_number !== undefined) { cycleSets.push('cycle_number = ?'); cycleParams.push(data.cycle_number); }
    if (data.week_number !== undefined) { cycleSets.push('week_number = ?'); cycleParams.push(data.week_number); }

    // The rotation window is the source of truth for the cycle's length: it is
    // converted at `months * 4` weeks, and the inclusive end date is
    // `start + (total_weeks * 7 - 1)` days. The server re-derives both so the
    // stored values can never disagree with the date the coordinator picked.
    if (data.start_date !== undefined) { cycleSets.push('start_date = ?'); cycleParams.push(data.start_date); }

    const monthsProvided = data.rotation_window_months !== undefined;
    const months = monthsProvided
      ? Number(data.rotation_window_months)
      : current.rotation_window_months != null
        ? Number(current.rotation_window_months)
        : NaN;
    if (monthsProvided && (!Number.isFinite(months) || months <= 0)) {
      const e = new Error('rotation_window_months must be a positive number of months.');
      e.statusCode = 400;
      throw e;
    }

    const effectiveStart = data.start_date !== undefined ? data.start_date : current.start_date;
    const weeks = Number.isFinite(months) && months > 0 ? convertMonthsToWeeks(months) : NaN;

    if (monthsProvided) {
      cycleSets.push('rotation_window_months = ?');
      cycleParams.push(months);
      if (Number.isFinite(weeks)) {
        cycleSets.push('total_weeks = ?');
        cycleParams.push(Math.round(weeks));
      }
    }
    if (Number.isFinite(weeks) && effectiveStart) {
      const endDate = calculateEndDateFromWeeks(effectiveStart, weeks);
      if (endDate) {
        cycleSets.push('end_date = ?');
        cycleParams.push(endDate);
      }
    }

    if (cycleSets.length > 0) {
      cycleParams.push(cycleId, programId);
      await db.query(`UPDATE primary_care_cycles SET ${cycleSets.join(', ')} WHERE id = ? AND program_id = ?`, cycleParams);
    }

    if (Array.isArray(data.dailyHeaders)) {
      for (const header of data.dailyHeaders) {
        const sets = [];
        const params = [];
        if (header.day_of_week !== undefined) {
          const day = String(header.day_of_week ?? '').trim();
          if (day) {
            // Two headers sharing a day would make the matrix ambiguous, since a
            // row is resolved by its day. Reject rather than silently duplicate.
            const [clash] = await db.query(
              'SELECT id FROM primary_care_daily_headers WHERE cycle_id = ? AND day_of_week = ? AND id <> ? LIMIT 1',
              [cycleId, day, header.id]
            );
            if (clash.length > 0) {
              const error = new Error(`The ${day} day already exists on this cycle. Choose a different day.`);
              error.statusCode = 409;
              throw error;
            }
            sets.push('day_of_week = ?');
            params.push(day);
          }
        }
        if (header.shift_time !== undefined) { sets.push('shift_time = ?'); params.push(header.shift_time); }
        if (header.pgy_level !== undefined) { sets.push('pgy_level = ?'); params.push(header.pgy_level); }
        if (header.in_charge_faculty_name !== undefined) {
          sets.push('in_charge_faculty_name = ?');
          params.push(formatFacultyName(header.in_charge_faculty_name));
        }
        if (header.in_charge_faculty_id !== undefined) {
          sets.push('in_charge_faculty_id = ?');
          params.push(header.in_charge_faculty_id || null);
        }
        if (sets.length > 0 && header.id) {
          params.push(header.id);
          await db.query(`UPDATE primary_care_daily_headers SET ${sets.join(', ')} WHERE id = ?`, params);
        }
      }
    }

    const [cycles] = await db.query('SELECT * FROM primary_care_cycles WHERE id = ?', [cycleId]);
    const updated = cycles[0];
    return updated ? { ...updated, start_date: toCalendarDate(updated.start_date) } : updated;
  }

  /**
   * Update one clinic slot's residents, supervising faculty, day or clinic number.
   *
   * Naming rules are enforced here, once: residents are stored without the `Dr.`
   * title and faculty are stored with exactly one, so the rule cannot drift
   * between the web grid, the mobile grid and any future importer.
   *
   * A slot can also be moved to another day header (`daily_header_id`) or clinic
   * number. The move is validated up front: the destination day must belong to
   * the same programme, the destination clinic number must be free on that day,
   * a resident can never sit in two clinics of the same day, and the same
   * resident cannot be listed twice within one slot. A faculty member covering
   * several clinic groups in one session is legitimate, so cross-slot faculty
   * overlaps come back as `warnings` rather than rejections.
   *
   * @param {number} slotId
   * @param {object} data
   * @param {string} [data.resident_1_name]
   * @param {string} [data.resident_2_name]
   * @param {string} [data.faculty_name]
   * @param {number} [data.faculty_id]
   * @param {number} [data.daily_header_id] - Move the session to another day of the cycle.
   * @param {number} [data.clinic_number] - Re-number the clinic (1..99).
   * @param {number} [data.program_id] - Optional; re-checks the destination's programme.
   * @returns {Promise<{slot: object, warnings: string[]}>}
   */
  static async updateCycleSlot(slotId, data = {}) {
    if (!slotId) {
      const e = new Error('slotId required');
      e.statusCode = 400;
      throw e;
    }
    const [existing] = await db.query('SELECT * FROM primary_care_clinic_slots WHERE id = ?', [slotId]);
    const slot = existing[0];
    if (!slot) {
      const e = new Error('Clinic slot not found.');
      e.statusCode = 404;
      throw e;
    }

    const targetHeaderId =
      data.daily_header_id !== undefined ? Number(data.daily_header_id) : slot.daily_header_id;
    if (!Number.isInteger(targetHeaderId) || targetHeaderId <= 0) {
      const e = new Error('daily_header_id must be a positive integer.');
      e.statusCode = 400;
      throw e;
    }

    // A slot can move between days, so the destination is always re-validated.
    // The header pins its cycle, and the cycle pins its programme: a coordinator
    // must not hand a session to another programme's day.
    const [headers] = await db.query(
      `SELECT h.id, h.cycle_id, c.program_id AS cycle_program_id
         FROM primary_care_daily_headers h
         JOIN primary_care_cycles c ON c.id = h.cycle_id
        WHERE h.id = ?`,
      [targetHeaderId]
    );
    const header = headers[0];
    if (!header) {
      const e = new Error('The destination day does not exist on this schedule.');
      e.statusCode = 404;
      throw e;
    }
    if (data.program_id !== undefined && Number(data.program_id) !== Number(header.cycle_program_id)) {
      const e = new Error('The destination day belongs to a different programme.');
      e.statusCode = 404;
      throw e;
    }

    const nextResident1 =
      data.resident_1_name !== undefined ? formatResidentName(data.resident_1_name) : slot.resident_1_name;
    const nextResident2 =
      data.resident_2_name !== undefined ? formatResidentName(data.resident_2_name) : slot.resident_2_name;
    const nextFaculty =
      data.faculty_name !== undefined ? formatFacultyName(data.faculty_name) : slot.faculty_name;
    const nextFacultyId =
      data.faculty_id !== undefined ? data.faculty_id || null : slot.faculty_id;
    const nextClinicNumber =
      data.clinic_number !== undefined ? Number(data.clinic_number) : slot.clinic_number;
    if (!Number.isInteger(nextClinicNumber) || nextClinicNumber < 1 || nextClinicNumber > 99) {
      const e = new Error('clinic_number must be a whole number between 1 and 99.');
      e.statusCode = 400;
      throw e;
    }

    // A resident can never be listed twice inside one slot.
    if (nextResident1 && nextResident1 === nextResident2) {
      const e = new Error(`${nextResident1} is already the first resident of this clinic. A resident cannot appear twice in one session.`);
      e.statusCode = 409;
      throw e;
    }

    const [sameDay] = await db.query(
      `SELECT id, clinic_number, resident_1_name, resident_2_name, faculty_name, faculty_id
         FROM primary_care_clinic_slots
        WHERE daily_header_id = ? AND id <> ?`,
      [targetHeaderId, slotId]
    );

    // A clinic number is used exactly once per day.
    const clinicTaken = sameDay.find((other) => other.clinic_number === nextClinicNumber);
    if (clinicTaken) {
      const e = new Error(`Clinic ${nextClinicNumber} already has a session on this day. Give the moved session a different clinic number, or clear the other slot first.`);
      e.statusCode = 409;
      throw e;
    }

    // A resident can never sit in two clinics on the same day.
    let clashName = null;
    const residentClash = sameDay.find((other) => {
      if (nextResident1 && (other.resident_1_name === nextResident1 || other.resident_2_name === nextResident1)) {
        clashName = nextResident1;
        return true;
      }
      if (nextResident2 && (other.resident_1_name === nextResident2 || other.resident_2_name === nextResident2)) {
        clashName = nextResident2;
        return true;
      }
      return false;
    });
    if (residentClash && clashName) {
      const e = new Error(`${clashName} is already assigned to Clinic ${residentClash.clinic_number} on this day. A resident can cover only one clinic per day.`);
      e.statusCode = 409;
      throw e;
    }

    // Faculty supervising several clinic groups in one session is normal, so a
    // cross-slot faculty repeat is surfaced as a warning, not a rejection.
    const warnings = [];
    if (nextFaculty) {
      const facultyClash = sameDay.find((other) => {
        if (!other.faculty_name) return false;
        const sameId =
          nextFacultyId && other.faculty_id && Number(other.faculty_id) === Number(nextFacultyId);
        return sameId || other.faculty_name === nextFaculty;
      });
      if (facultyClash) {
        warnings.push(`${nextFaculty} also supervises Clinic ${facultyClash.clinic_number} at the same time on this day.`);
      }
    }

    const sets = [];
    const params = [];
    if (data.resident_1_name !== undefined) {
      sets.push('resident_1_name = ?');
      params.push(formatResidentName(data.resident_1_name));
    }
    if (data.resident_2_name !== undefined) {
      sets.push('resident_2_name = ?');
      params.push(formatResidentName(data.resident_2_name));
    }
    if (data.faculty_name !== undefined) {
      sets.push('faculty_name = ?');
      params.push(formatFacultyName(data.faculty_name));
    }
    if (data.faculty_id !== undefined) {
      sets.push('faculty_id = ?');
      params.push(data.faculty_id || null);
    }
    if (data.daily_header_id !== undefined) {
      sets.push('daily_header_id = ?');
      params.push(targetHeaderId);
    }
    if (data.clinic_number !== undefined) {
      sets.push('clinic_number = ?');
      params.push(nextClinicNumber);
    }
    if (sets.length === 0) {
      const e = new Error('Nothing to update');
      e.statusCode = 400;
      throw e;
    }
    params.push(slotId);
    await db.query(`UPDATE primary_care_clinic_slots SET ${sets.join(', ')} WHERE id = ?`, params);

    const [rows] = await db.query('SELECT * FROM primary_care_clinic_slots WHERE id = ?', [slotId]);
    return { slot: rows[0], warnings };
  }

  /** Resolve (creating if necessary) the day header a backup pool belongs to. */
  static async resolveDailyHeader(programId, cycleId, dayOfWeek) {
    let resolvedCycleId = cycleId;
    if (!resolvedCycleId) {
      const [cycles] = await db.query('SELECT * FROM primary_care_cycles WHERE program_id = ? ORDER BY id DESC LIMIT 1', [programId]);
      if (cycles.length === 0) {
        const [res] = await db.query(
          'INSERT INTO primary_care_cycles (program_id, cycle_number, week_number, start_date) VALUES (?, ?, ?, ?)',
          [programId, 'Cycle 1', 'Week 1', new Date().toISOString().split('T')[0]]
        );
        resolvedCycleId = res.insertId;
      } else {
        resolvedCycleId = cycles[0].id;
      }
    }

    const [headers] = await db.query(
      'SELECT * FROM primary_care_daily_headers WHERE cycle_id = ? AND day_of_week = ?',
      [resolvedCycleId, dayOfWeek]
    );
    if (headers[0]) return headers[0];

    await db.query(
      'INSERT INTO primary_care_daily_headers (cycle_id, day_of_week, shift_time, pgy_level) VALUES (?, ?, ?, ?)',
      [resolvedCycleId, dayOfWeek, defaultShiftForDay(dayOfWeek), defaultPgyForDay(dayOfWeek)]
    );
    const [created] = await db.query(
      'SELECT * FROM primary_care_daily_headers WHERE cycle_id = ? AND day_of_week = ?',
      [resolvedCycleId, dayOfWeek]
    );
    return created[0];
  }

  /**
   * Replace a day's backup / catchup faculty pool.
   *
   * The pool is exactly what the caller sends — a delete-then-insert keyed on
   * `priority_order` — so reordering, removing and adding are all the same call.
   * Names are normalised to the `Dr.` prefix like every other faculty field.
   */
  static async updateBackupFaculty(programId, data = {}) {
    const { cycle_id, day_of_week, faculty_list = [] } = data;
    if (!day_of_week) { const e = new Error('day_of_week required'); e.statusCode = 400; throw e; }

    const dailyHeader = await this.resolveDailyHeader(programId, cycle_id, day_of_week);
    const dailyHeaderId = dailyHeader.id;

    await db.query('DELETE FROM primary_care_backup_faculty WHERE daily_header_id = ? AND day_of_week = ?', [dailyHeaderId, day_of_week]);

    const inserts = [];
    faculty_list.forEach((faculty, index) => {
      const name = formatFacultyName(faculty.faculty_name || faculty.name);
      if (!name) return;
      inserts.push([dailyHeaderId, day_of_week, name, faculty.faculty_id || null, index + 1]);
    });
    if (inserts.length > 0) {
      await db.query(
        'INSERT INTO primary_care_backup_faculty (daily_header_id, day_of_week, faculty_name, faculty_id, priority_order) VALUES ?',
        [inserts]
      );
    }

    const [rows] = await db.query(
      'SELECT * FROM primary_care_backup_faculty WHERE daily_header_id = ? AND day_of_week = ? ORDER BY priority_order ASC',
      [dailyHeaderId, day_of_week]
    );
    return rows;
  }

  /**
   * Randomisation / rotation engine for supervising faculty.
   *
   * Reassigns the supervising faculty across the day's resident-bearing clinic
   * slots from the available faculty pool (or, when a day already has named
   * supervisors, from that day's own pool so an existing rotation is shuffled
   * rather than replaced). Every reassignment is written to
   * `primary_care_rotation_audit` with its rationale, so a coordinator can
   * explain later why a resident's supervisor changed. Passing
   * `rotationMonths` records the intended rotation window (three months by
   * default).
   *
   * @param {number} programId
   * @param {object} options
   * @param {number} [options.cycleId]
   * @param {string} [options.dayOfWeek] - Restrict to one day; otherwise all days.
   * @param {number} [options.rotationMonths=3]
   * @param {boolean} [options.randomize=true] - Shuffle, or rotate in order.
   * @param {string} [options.rationale]
   */
  static async randomizeSupervisors(programId, options = {}) {
    const {
      cycleId,
      dayOfWeek = null,
      rotationMonths = 3,
      randomize = true,
      rationale = null,
    } = options;

    const [faculty] = await db.query(
      'SELECT id, first_name, last_name, specialty, CONCAT(\'Dr. \', first_name, \' \', last_name) AS display_name FROM faculty_supervisors WHERE program_id = ? AND is_active = 1 ORDER BY id ASC',
      [programId]
    );
    if (faculty.length === 0) return { updated: 0, days: [], reason: 'no_active_faculty' };

    const [cycle] = cycleId
      ? await db.query('SELECT * FROM primary_care_cycles WHERE id = ? AND program_id = ?', [cycleId, programId])
      : await db.query('SELECT * FROM primary_care_cycles WHERE program_id = ? ORDER BY id DESC LIMIT 1', [programId]);
    if (!cycle[0]) return { updated: 0, days: [], reason: 'no_cycle' };

    let headerQuery = 'SELECT * FROM primary_care_daily_headers WHERE cycle_id = ?';
    const headerParams = [cycle[0].id];
    if (dayOfWeek) { headerQuery += ' AND day_of_week = ?'; headerParams.push(dayOfWeek); }
    const [headers] = await db.query(headerQuery, headerParams);

    let updated = 0;
    const days = [];

    for (const header of headers) {
      const [slots] = await db.query(
        'SELECT * FROM primary_care_clinic_slots WHERE daily_header_id = ? ORDER BY clinic_number',
        [header.id]
      );
      const targetSlots = slots.filter((slot) => slot.resident_1_name || slot.resident_2_name);
      if (targetSlots.length === 0) continue;

      // Prefer a day's own named supervisors so an existing rotation is shuffled;
      // fall back to the whole active faculty pool for an unassigned day.
      const named = [...new Set(targetSlots.map((slot) => slot.faculty_name).filter(Boolean))];
      const poolSource = named.length >= 2
        ? named.map((name) => ({ id: null, display_name: name }))
        : faculty;

      const pool = poolSource
        .map((person) => ({ ...person }))
        .sort(() => (randomize ? Math.random() - 0.5 : 0));

      for (let index = 0; index < targetSlots.length; index += 1) {
        const slot = targetSlots[index];
        const chosen = pool[index % pool.length];
        await db.query(
          'UPDATE primary_care_clinic_slots SET faculty_name = ?, faculty_id = ? WHERE id = ?',
          [chosen.display_name, chosen.id || null, slot.id]
        );
        await this.recordRotationAudit({
          programId,
          cycleId: cycle[0].id,
          dailyHeaderId: header.id,
          clinicSlotId: slot.id,
          previousFacultyName: slot.faculty_name || null,
          newFacultyId: chosen.id || null,
          newFacultyName: chosen.display_name,
          rationale,
          rotationMonths,
        });
        updated += 1;
      }

      days.push({
        day_of_week: header.day_of_week,
        reassigned: targetSlots.length,
      });
    }

    return { updated, days, rationale, rotation_months: Number(rotationMonths) || 3 };
  }

  /**
   * Append one reassignment to the rotation audit trail.
   *
   * The audit table is created on demand and the insert is best-effort: a
   * deployment without the table must still be able to randomise supervisors,
   * so a failure here is swallowed rather than aborting the reassignment.
   */

  static async createFacultySupervisor(data = {}) {
    const programId = Number(data.program_id);
    const firstName = String(data.first_name ?? '').trim();
    const lastName = String(data.last_name ?? '').trim();
    if (!programId || !firstName || !lastName) {
      const error = new Error('program_id, first_name and last_name are required.');
      error.statusCode = 400;
      throw error;
    }
    const [result] = await db.query(
      `INSERT INTO faculty_supervisors (program_id, first_name, last_name, title, clinical_title, faculty_appointment, administrative_role, email, phone, specialty, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [programId, firstName, lastName, data.title ? String(data.title).trim() : null, data.clinical_title ? String(data.clinical_title).trim() : null, data.faculty_appointment ? String(data.faculty_appointment).trim() : null, data.administrative_role ? String(data.administrative_role).trim() : null, data.email ? String(data.email).trim() : null, data.phone ? String(data.phone).trim() : null, data.specialty ? String(data.specialty).trim() : null, data.is_active !== undefined ? (Number(data.is_active) ? 1 : 0) : 1]
    );
    const [rows] = await db.query('SELECT * FROM faculty_supervisors WHERE id = ?', [result.insertId]);
    return rows[0];
  }

  static async updateFacultySupervisor(id, programId, data = {}) {
    const fid = Number(id);
    const pid = Number(programId);
    if (!Number.isInteger(fid) || fid <= 0 || !Number.isInteger(pid) || pid <= 0) {
      const error = new Error('Invalid faculty supervisor id or program_id.');
      error.statusCode = 400;
      throw error;
    }
    const [existing] = await db.query('SELECT id FROM faculty_supervisors WHERE id = ? AND program_id = ?', [fid, pid]);
    if (existing.length === 0) {
      const error = new Error('Faculty supervisor not found.');
      error.statusCode = 404;
      throw error;
    }
    const sets = [];
    const params = [];
    if (data.first_name !== undefined) {
      const v = String(data.first_name).trim();
      if (!v) { const err = new Error('first_name cannot be empty.'); err.statusCode = 400; throw err; }
      sets.push('first_name = ?'); params.push(v);
    }
    if (data.last_name !== undefined) {
      const v = String(data.last_name).trim();
      if (!v) { const err = new Error('last_name cannot be empty.'); err.statusCode = 400; throw err; }
      sets.push('last_name = ?'); params.push(v);
    }
    if (data.title !== undefined) { sets.push('title = ?'); params.push(String(data.title).trim() || null); }
    if (data.clinical_title !== undefined) { sets.push('clinical_title = ?'); params.push(String(data.clinical_title).trim() || null); }
    if (data.faculty_appointment !== undefined) { sets.push('faculty_appointment = ?'); params.push(String(data.faculty_appointment).trim() || null); }
    if (data.administrative_role !== undefined) { sets.push('administrative_role = ?'); params.push(String(data.administrative_role).trim() || null); }
    if (data.email !== undefined) { sets.push('email = ?'); params.push(String(data.email).trim() || null); }
    if (data.phone !== undefined) { sets.push('phone = ?'); params.push(String(data.phone).trim() || null); }
    if (data.specialty !== undefined) { sets.push('specialty = ?'); params.push(String(data.specialty).trim() || null); }
    if (data.is_active !== undefined) { sets.push('is_active = ?'); params.push(Number(data.is_active) ? 1 : 0); }
    if (sets.length === 0) { const err = new Error('Nothing to update.'); err.statusCode = 400; throw err; }
    sets.push('updated_at = CURRENT_TIMESTAMP');
    await db.query(`UPDATE faculty_supervisors SET ${sets.join(', ')} WHERE id = ? AND program_id = ?`, [...params, fid, pid]);
    const [rows] = await db.query('SELECT * FROM faculty_supervisors WHERE id = ? AND program_id = ?', [fid, pid]);
    return rows[0];
  }

  static async deleteFacultySupervisor(id, programId) {
    const fid = Number(id);
    const pid = Number(programId);
    if (!Number.isInteger(fid) || fid <= 0 || !Number.isInteger(pid) || pid <= 0) {
      const error = new Error('Invalid faculty supervisor id or program_id.');
      error.statusCode = 400;
      throw error;
    }
    const [existing] = await db.query('SELECT id FROM faculty_supervisors WHERE id = ? AND program_id = ?', [fid, pid]);
    if (existing.length === 0) {
      const error = new Error('Faculty supervisor not found.');
      error.statusCode = 404;
      throw error;
    }
    await db.query('UPDATE faculty_supervisors SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND program_id = ?', [fid, pid]);
    return { id: fid, is_active: 0 };
  }

  static async recordRotationAudit(entry) {
    try {
      if (!LongitudinalService.auditTableReady) {
        await db.query(`
          CREATE TABLE IF NOT EXISTS primary_care_rotation_audit (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            program_id BIGINT UNSIGNED NOT NULL,
            cycle_id BIGINT UNSIGNED NULL,
            daily_header_id BIGINT UNSIGNED NULL,
            clinic_slot_id BIGINT UNSIGNED NULL,
            previous_faculty_name VARCHAR(200) NULL,
            new_faculty_id BIGINT UNSIGNED NULL,
            new_faculty_name VARCHAR(200) NULL,
            rationale VARCHAR(500) NULL,
            rotation_months INT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        LongitudinalService.auditTableReady = true;
      }
      await db.query(
        `INSERT INTO primary_care_rotation_audit
           (program_id, cycle_id, daily_header_id, clinic_slot_id, previous_faculty_name, new_faculty_id, new_faculty_name, rationale, rotation_months)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.programId,
          entry.cycleId || null,
          entry.dailyHeaderId || null,
          entry.clinicSlotId || null,
          entry.previousFacultyName || null,
          entry.newFacultyId || null,
          entry.newFacultyName || null,
          entry.rationale || null,
          Number(entry.rotationMonths) || null,
        ]
      );
    } catch (error) {
      // Audit is best-effort; never let it fail a reassignment.
    }
  }
}

module.exports = LongitudinalService;