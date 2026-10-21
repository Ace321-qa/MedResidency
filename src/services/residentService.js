const pool = require('../config/db');

/**
 * Onboard a new resident with personal info, legal identifiers, and program enrollment
 * Executes inside an ACID transaction to guarantee complete integrity.
 */
async function onboardResident({ personal_info, identifiers, enrollment }) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 1. Insert Core Personal Information
    const [resResult] = await connection.query(
      `INSERT INTO residents 
       (first_name, middle_initial, last_name, date_of_birth, sex, nationality, citizenship_status, race_ethnicity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        personal_info.first_name,
        personal_info.middle_initial || null,
        personal_info.last_name,
        personal_info.date_of_birth,
        personal_info.sex,
        personal_info.nationality,
        personal_info.citizenship_status,
        personal_info.race_ethnicity || null,
      ]
    );

    const residentId = resResult.insertId;

    // 2. Insert Legal Identifiers (e.g., QID, Passport, Medical License)
    if (Array.isArray(identifiers) && identifiers.length > 0) {
      for (const ident of identifiers) {
        await connection.query(
          `INSERT INTO resident_identifiers 
           (resident_id, identifier_type, identifier_value, issuing_country, is_primary)
           VALUES (?, ?, ?, ?, ?)`,
          [
            residentId,
            ident.identifier_type,
            ident.identifier_value,
            ident.issuing_country || 'QA',
            ident.is_primary ? 1 : 0,
          ]
        );
      }
    }

    // 3. Insert Program Enrollment (e.g., PGY-1 in Family Medicine)
    let enrollmentId = null;
    if (enrollment && enrollment.program_id) {
      const [enrollResult] = await connection.query(
        `INSERT INTO residency_enrollments
         (resident_id, program_id, resident_status, position_type, year_in_program, 
          start_date, expected_completion_date, started_program_at_year_one, 
          previous_education_documented, prior_training_years, comments)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          residentId,
          enrollment.program_id,
          enrollment.resident_status || 'ACTIVE_FULL_TIME',
          enrollment.position_type || 'FULL_TIME',
          enrollment.year_in_program !== undefined ? enrollment.year_in_program : 1,
          enrollment.start_date || null,
          enrollment.expected_completion_date || null,
          enrollment.started_program_at_year_one !== undefined ? (enrollment.started_program_at_year_one ? 1 : 0) : 1,
          enrollment.previous_education_documented ? 1 : 0,
          enrollment.prior_training_years || null,
          enrollment.comments || 'Onboarded via MedResidency API',
        ]
      );
      enrollmentId = enrollResult.insertId;
    }

    await connection.commit();

    return {
      resident_id: residentId,
      enrollment_id: enrollmentId,
      first_name: personal_info.first_name,
      last_name: personal_info.last_name,
      status: 'ONBOARDED_SUCCESSFULLY',
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Retrieve all residents with their enrolled program details
 */
async function getAllResidents({ program_id, limit = 50, offset = 0 } = {}) {
  // Corporate id, email and mobile live on `resident_identifiers`, not on
  // `residents`. They are pulled in with a correlated subquery per type rather
  // than a JOIN, because a resident may hold several identifiers of the same
  // type and a JOIN would multiply the roster rows. These three fields are what
  // the roster search box matches on and what each roster card displays.
  let query = `
    SELECT 
      r.id AS resident_id,
      r.first_name,
      r.middle_initial,
      r.last_name,
      r.date_of_birth,
      r.sex,
      r.nationality,
      r.citizenship_status,
      re.program_id,
      p.program_code,
      p.specialty_name,
      re.year_in_program AS pgy_level,
      re.resident_status,
      r.created_at,
      (
        SELECT ri.identifier_value
        FROM resident_identifiers ri
        WHERE ri.resident_id = r.id AND ri.identifier_type = 'CORPORATE_ID'
        ORDER BY ri.is_primary DESC, ri.id ASC
        LIMIT 1
      ) AS corporate_id,
      (
        SELECT ri.identifier_value
        FROM resident_identifiers ri
        WHERE ri.resident_id = r.id AND ri.identifier_type = 'EMAIL'
        ORDER BY ri.is_primary DESC, ri.id ASC
        LIMIT 1
      ) AS email,
      (
        SELECT ri.identifier_value
        FROM resident_identifiers ri
        WHERE ri.resident_id = r.id AND ri.identifier_type = 'MOBILE'
        ORDER BY ri.is_primary DESC, ri.id ASC
        LIMIT 1
      ) AS mobile
    FROM residents r
    LEFT JOIN residency_enrollments re ON re.resident_id = r.id
    LEFT JOIN programs p ON p.id = re.program_id
  `;

  const params = [];
  if (program_id) {
    query += ` WHERE re.program_id = ? `;
    params.push(program_id);
  }

  query += ` ORDER BY r.id DESC LIMIT ? OFFSET ? `;
  params.push(Number(limit), Number(offset));

  const [rows] = await pool.query(query, params);
  return rows;
}

/**
 * Visiting / external residents: people enrolled in *another* programme who
 * hold at least one rotation assignment inside this programme's departments.
 *
 * One row per person — the grain the roster card wants — with their home
 * programme identity and an aggregate of where they rotate here: the distinct
 * department and rotation names, the assignment count, and the full date span
 * of their postings (15 Nov – 12 Dec 2026 for a single Block 6 visit).
 *
 * The home enrolment is reached through a correlated subquery rather than a
 * plain JOIN, for the same reason the grid uses one: a resident may hold
 * several enrolments, and a join would multiply the roster. A resident who
 * *also* holds an enrolment in this programme is excluded — they belong on the
 * enrolled roster, not the visiting one, and appearing on both would be a
 * double count.
 *
 * @param {object} input
 * @param {number} input.program_id - The receiving programme (required).
 * @param {number} [input.limit]
 * @param {number} [input.offset]
 */
async function getExternalResidents({ program_id, limit = 500, offset = 0 } = {}) {
  if (!program_id) {
    const error = new Error('program_id is required to list visiting residents.');
    error.statusCode = 400;
    throw error;
  }

  // The rotation-ownership test below reads `target_program_id`, which the
  // shared guard adds on first use (see utils/ensureTargetProgram).
  await ensureTargetProgramColumn();

  const query = `
    SELECT
      r.id AS resident_id,
      r.first_name,
      r.middle_initial,
      r.last_name,
      re.year_in_program AS pgy_level,
      re.resident_status,
      hp.id AS home_program_id,
      hp.program_code AS home_program_code,
      hp.program_name AS home_program_name,
      hp.specialty_name AS home_specialty_name,
      (
        SELECT ri.identifier_value
        FROM resident_identifiers ri
        WHERE ri.resident_id = r.id AND ri.identifier_type = 'CORPORATE_ID'
        ORDER BY ri.is_primary DESC, ri.id ASC
        LIMIT 1
      ) AS corporate_id,
      (
        SELECT ri.identifier_value
        FROM resident_identifiers ri
        WHERE ri.resident_id = r.id AND ri.identifier_type = 'EMAIL'
        ORDER BY ri.is_primary DESC, ri.id ASC
        LIMIT 1
      ) AS email,
      (
        SELECT ri.identifier_value
        FROM resident_identifiers ri
        WHERE ri.resident_id = r.id AND ri.identifier_type = 'MOBILE'
        ORDER BY ri.is_primary DESC, ri.id ASC
        LIMIT 1
      ) AS mobile,
      COUNT(DISTINCT rra.id) AS assignment_count,
      GROUP_CONCAT(DISTINCT rot.department_name
        ORDER BY rot.department_name SEPARATOR ' · ') AS department_names,
      GROUP_CONCAT(DISTINCT rot.rotation_name
        ORDER BY rot.rotation_name SEPARATOR ' · ') AS rotation_names,
      DATE_FORMAT(MIN(rra.start_date), '%Y-%m-%d') AS assignment_start_date,
      DATE_FORMAT(MAX(rra.end_date), '%Y-%m-%d') AS assignment_end_date
    FROM resident_rotation_assignments rra
    JOIN rotations rot ON rot.id = rra.rotation_id
    JOIN rotation_blocks rb ON rb.id = rra.rotation_block_id
    JOIN residents r ON r.id = rra.resident_id
    JOIN residency_enrollments re ON re.id = (
      SELECT re2.id FROM residency_enrollments re2
      WHERE re2.resident_id = r.id AND re2.program_id <> ?
      ORDER BY re2.created_at DESC, re2.id DESC
      LIMIT 1
    )
    JOIN programs hp ON hp.id = re.program_id
    WHERE rb.program_id = ?
      AND (rot.program_id = ? OR rot.target_program_id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM residency_enrollments re_int
        WHERE re_int.resident_id = r.id AND re_int.program_id = ?
      )
    GROUP BY
      r.id, r.first_name, r.middle_initial, r.last_name,
      re.year_in_program, re.resident_status,
      hp.id, hp.program_code, hp.program_name, hp.specialty_name
    ORDER BY r.last_name ASC, r.first_name ASC
    LIMIT ? OFFSET ?;
  `;

  const [rows] = await pool.query(query, [
    program_id,
    program_id,
    program_id,
    program_id,
    program_id,
    Number(limit),
    Number(offset),
  ]);
  return rows;
}

/**
 * Create a new visiting resident profile.
 * Only corporate_id is mandatory; first_name, last_name, mobile, email are optional.
 * All other legal fields (DOB, citizenship) must be optional/NULLable for external guests.
 */
async function createVisitingResident({ corporate_id, first_name, last_name, mobile, email, home_program_name, program_id }) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 1. Insert Core Personal Information for visiting resident
    // Allow NULL values for date_of_birth, sex, nationality, citizenship_status for external guests
    const [resResult] = await connection.query(
      `INSERT INTO residents 
       (first_name, middle_initial, last_name, date_of_birth, sex, nationality, citizenship_status, race_ethnicity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        first_name || null,
        null,
        last_name || null,
        null,  // date_of_birth - optional for visiting residents
        null,  // sex - optional for visiting residents
        null,  // nationality - optional for visiting residents
        null,  // citizenship_status - optional for visiting residents
        null,  // race_ethnicity - optional for visiting residents
      ]
    );

    const residentId = resResult.insertId;

    // 2. Insert Corporate/Guest ID identifier (MANDATORY for visiting residents)
    await connection.query(
      `INSERT INTO resident_identifiers 
       (resident_id, identifier_type, identifier_value, issuing_country, is_primary)
       VALUES (?, ?, ?, ?, ?)`,
      [
        residentId,
        'CORPORATE_ID',
        corporate_id,
        'QA',
        1,
      ]
    );

    // 3. Insert optional identifiers (mobile, email) if provided
    if (mobile) {
      await connection.query(
        `INSERT INTO resident_identifiers 
         (resident_id, identifier_type, identifier_value, issuing_country, is_primary)
         VALUES (?, ?, ?, ?, ?)`,
        [
          residentId,
          'MOBILE',
          mobile,
          'QA',
          0,
        ]
      );
    }

    if (email) {
      await connection.query(
        `INSERT INTO resident_identifiers 
         (resident_id, identifier_type, identifier_value, issuing_country, is_primary)
         VALUES (?, ?, ?, ?, ?)`,
        [
          residentId,
          'EMAIL',
          email,
          null,
          0,
        ]
      );
    }

    // 4. Insert Program Enrollment for visiting resident
    // Visiting residents are enrolled in the receiving program with a special status
    const [enrollResult] = await connection.query(
      `INSERT INTO residency_enrollments
       (resident_id, program_id, resident_status, position_type, year_in_program,
        start_date, expected_completion_date, started_program_at_year_one,
        previous_education_documented, prior_training_years, comments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        residentId,
        program_id,
        'ACTIVE_FULL_TIME',  // visiting residents default to active full-time
        'VISITING',
        null,  // year_in_program - optional for visiting
        null,  // start_date - optional
        null,  // expected_completion_date - optional
        0,     // started_program_at_year_one - 0 for visiting
        0,     // previous_education_documented - 0 for visiting
        'Onboarded as visiting resident via MedResidency API',
        null,  // prior_training_years - optional
      ]
    );

    await connection.commit();

    return {
      resident_id: residentId,
      corporate_id,
      first_name,
      last_name,
      status: 'VISITING_CREATED_SUCCESSFULLY',
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Identifier types the edit form may write, keyed by the API field that carries
 * them. Email and mobile have no columns on `residents`; they live beside the
 * corporate id in `resident_identifiers`, which is also where the onboarding
 * transaction already puts legal identifiers.
 */
const IDENTIFIER_TYPE_BY_FIELD = {
  corporate_id: 'CORPORATE_ID',
  email: 'EMAIL',
  mobile: 'MOBILE',
};

/**
 * Tables that hold a resident's history. A roster "remove" must never silently
 * take these with it: they are the evidence behind duty-hour compliance and
 * completed rotations, so the counts are reported instead.
 */
const CRITICAL_DEPENDENCIES = [
  { table: 'resident_attendance_logs', label: 'attendance log' },
  { table: 'resident_rotation_assignments', label: 'rotation assignment' },
  { table: 'resident_leave_requests', label: 'leave request' },
  { table: 'generated_release_letters', label: 'release letter' },
  { table: 'duty_hour_violations', label: 'duty-hour violation' },
];

/**
 * Update a resident's profile: core names, the programme enrollment's PGY level
 * and status, and the corporate id / email / mobile identifiers.
 *
 * Only the fields present in `input` are touched, so an edit form that changes a
 * single phone number does not have to restate (or risk clobbering) the rest.
 * The whole update runs in one transaction: a half-applied profile — a new name
 * with the old status — is worse than a rejected one.
 *
 * @returns the refreshed aggregate, or `null` when the resident does not exist.
 */
async function updateResident(residentId, input) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [existing] = await connection.query('SELECT id FROM residents WHERE id = ? FOR UPDATE', [
      residentId,
    ]);
    if (existing.length === 0) {
      await connection.rollback();
      return null;
    }

    // 1. Core name fields.
    const residentUpdates = {};
    for (const field of ['first_name', 'last_name', 'middle_initial']) {
      if (!Object.prototype.hasOwnProperty.call(input, field) || input[field] === undefined) continue;
      const value = input[field] === null ? '' : String(input[field]).trim();
      residentUpdates[field] = value === '' ? null : value;
    }
    if (Object.keys(residentUpdates).length > 0) {
      const fields = Object.keys(residentUpdates);
      const setClause = fields.map((field) => `${field} = ?`).join(', ');
      await connection.query(`UPDATE residents SET ${setClause} WHERE id = ?`, [
        ...fields.map((field) => residentUpdates[field]),
        residentId,
      ]);
    }

    // 2. Enrollment: PGY level (year_in_program) and status, scoped to a
    //    programme when the caller names one so a second enrollment is untouched.
    const enrollmentUpdates = {};
    if (input.pgy_level !== undefined && input.pgy_level !== null) {
      enrollmentUpdates.year_in_program = Number(input.pgy_level);
    }
    if (input.resident_status !== undefined && input.resident_status !== null) {
      enrollmentUpdates.resident_status = String(input.resident_status).trim().toUpperCase();
    }
    if (Object.keys(enrollmentUpdates).length > 0) {
      const fields = Object.keys(enrollmentUpdates);
      const setClause = fields.map((field) => `${field} = ?`).join(', ');
      const params = [...fields.map((field) => enrollmentUpdates[field]), residentId];
      let sql = `UPDATE residency_enrollments SET ${setClause} WHERE resident_id = ?`;
      if (input.program_id !== undefined && input.program_id !== null) {
        sql += ' AND program_id = ?';
        params.push(Number(input.program_id));
      }
      await connection.query(sql, params);
    }

    // 3. Identifiers: upsert the first row of each type, delete it when the
    //    caller clears the field, so "remove the email" is expressible.
    for (const [field, identifierType] of Object.entries(IDENTIFIER_TYPE_BY_FIELD)) {
      if (!Object.prototype.hasOwnProperty.call(input, field) || input[field] === undefined) continue;

      const value = input[field] === null ? '' : String(input[field]).trim();
      const [rows] = await connection.query(
        'SELECT id FROM resident_identifiers WHERE resident_id = ? AND identifier_type = ? ORDER BY id ASC',
        [residentId, identifierType],
      );

      if (value === '') {
        if (rows.length > 0) {
          await connection.query(
            'DELETE FROM resident_identifiers WHERE resident_id = ? AND identifier_type = ?',
            [residentId, identifierType],
          );
        }
        continue;
      }

      if (rows.length > 0) {
        await connection.query('UPDATE resident_identifiers SET identifier_value = ? WHERE id = ?', [
          value,
          rows[0].id,
        ]);
      } else {
        await connection.query(
          `INSERT INTO resident_identifiers
           (resident_id, identifier_type, identifier_value, issuing_country, is_primary)
           VALUES (?, ?, ?, ?, ?)`,
          [
            residentId,
            identifierType,
            value,
            identifierType === 'CORPORATE_ID' ? 'QA' : null,
            identifierType === 'CORPORATE_ID' ? 1 : 0,
          ],
        );
      }
    }

    await connection.commit();
    return await getResidentById(residentId);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/** Count the historical rows a delete would otherwise take with it. */
async function getResidentDependencies(residentId) {
  const dependencies = [];
  let total = 0;

  for (const dependency of CRITICAL_DEPENDENCIES) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS total FROM ${dependency.table} WHERE resident_id = ?`,
      [residentId],
    );
    const count = Number(rows[0]?.total ?? 0);
    if (count > 0) {
      dependencies.push({ table: dependency.table, label: dependency.label, count });
      total += count;
    }
  }

  return { total, dependencies };
}

/**
 * Delete a resident record. By default a resident with attendance, rotation,
 * leave, letter or duty-hour history is refused: the foreign keys cascade, so
 * an unchecked delete would erase the compliance trail as a side effect.
 * `cascade: true` is the explicit opt-in to do exactly that.
 */
async function deleteResident(residentId, { cascade = false } = {}) {
  const [existing] = await pool.query(
    'SELECT id, first_name, last_name FROM residents WHERE id = ?',
    [residentId],
  );
  if (existing.length === 0) {
    return { found: false, deleted: false, total: 0, dependencies: [] };
  }

  const { total, dependencies } = await getResidentDependencies(residentId);
  if (total > 0 && !cascade) {
    return { found: true, deleted: false, total, dependencies };
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM residents WHERE id = ?', [residentId]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return { found: true, deleted: true, total, dependencies };
}

/**
 * Remove a resident's programme enrollment, leaving the person and their history
 * intact. The roster is read through `residency_enrollments`, so this is what
 * takes a card off the list without destroying the record behind it.
 *
 * @returns `{ found, removed }` — `removed: 0` means they were not enrolled.
 */
async function removeEnrollment(residentId, programId = null) {
  const [existing] = await pool.query('SELECT id FROM residents WHERE id = ?', [residentId]);
  if (existing.length === 0) {
    return { found: false, removed: 0 };
  }

  const params = [residentId];
  let sql = 'DELETE FROM residency_enrollments WHERE resident_id = ?';
  if (programId !== null && programId !== undefined) {
    sql += ' AND program_id = ?';
    params.push(Number(programId));
  }

  const [result] = await pool.query(sql, params);
  return { found: true, removed: result.affectedRows };
}

/**
 * Retrieve a single resident by ID including their identifiers and active enrollments
 */
async function getResidentById(residentId) {
  // 1. Fetch core profile
  const [residents] = await pool.query(
    `SELECT * FROM residents WHERE id = ?`,
    [residentId]
  );

  if (residents.length === 0) {
    return null;
  }

  const resident = residents[0];

  // 2. Fetch identifiers
  const [identifiers] = await pool.query(
    `SELECT id, identifier_type, identifier_value, issuing_country, is_primary 
     FROM resident_identifiers 
     WHERE resident_id = ?`,
    [residentId]
  );

  // 3. Fetch enrollments
  const [enrollments] = await pool.query(
    `SELECT 
       re.*,
       p.program_code,
       p.specialty_name,
       p.week_start_day,
       p.standard_shift_hours
     FROM residency_enrollments re
     JOIN programs p ON p.id = re.program_id
     WHERE re.resident_id = ?`,
    [residentId]
  );

  return {
    ...resident,
    identifiers,
    enrollments,
  };
}

module.exports = {
  onboardResident,
  getAllResidents,
  getExternalResidents,
  createVisitingResident,
  getResidentById,
  updateResident,
  deleteResident,
  removeEnrollment,
};
