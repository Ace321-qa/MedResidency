#!/usr/bin/env node
/**
 * Seed supervising faculty for the Continuity of Care Clinics (CCC) view.
 *
 * The `faculty_supervisors` table ships empty, which leaves every CCC drop-down
 * (clinic-slot supervisor, In-Charge lead, backup / catchup pool) with nothing
 * to choose from. This adds a small, realistic roster for a programme so the
 * view is usable end to end.
 *
 * Idempotent: a person already on record for the programme (matched by first +
 * last name, case-insensitively) is left untouched, so running it twice does not
 * duplicate anyone.
 *
 *   node scripts/seed-primary-care-faculty.js [programId=1]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../src/config/db');

const FACULTY = [
  { first_name: 'Hassan', last_name: 'Al-Hussein', title: 'Consultant, Family Medicine' },
  { first_name: 'Ahmed', last_name: 'Bawazir', title: 'Consultant, Family Medicine' },
  { first_name: 'Nashwan', last_name: 'Al-Sabri', title: 'Consultant, Family Medicine' },
  { first_name: 'Areen', last_name: 'Khalil', title: 'Senior Registrar, Family Medicine' },
  { first_name: 'Saleh', last_name: 'Al-Mutairi', title: 'Consultant, Family Medicine' },
  { first_name: 'Rasha', last_name: 'Nasser', title: 'Senior Registrar, Family Medicine' },
  { first_name: 'Hani', last_name: 'Barakat', title: 'Consultant, Family Medicine' },
];

(async () => {
  const programId = Number(process.argv[2] || 1);
  console.log(`Seeding supervising faculty for programme ${programId}…`);

  let inserted = 0;
  for (const person of FACULTY) {
    const [existing] = await db.query(
      `SELECT id FROM faculty_supervisors
        WHERE program_id = ? AND LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?)
        LIMIT 1`,
      [programId, person.first_name, person.last_name]
    );
    if (existing.length > 0) continue;

    await db.query(
      `INSERT INTO faculty_supervisors (program_id, first_name, last_name, title, is_active)
       VALUES (?, ?, ?, ?, 1)`,
      [programId, person.first_name, person.last_name, person.title]
    );
    inserted += 1;
  }

  const [count] = await db.query(
    'SELECT COUNT(*) AS total FROM faculty_supervisors WHERE program_id = ? AND is_active = 1',
    [programId]
  );
  console.log(`  • inserted ${inserted} faculty record(s); ${count[0].total} active now.`);
  console.log('Done.');
  process.exit(0);
})().catch((error) => {
  console.error('Seed failed:', error.message);
  process.exit(1);
});
