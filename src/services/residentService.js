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
      r.created_at
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
  getResidentById,
};
