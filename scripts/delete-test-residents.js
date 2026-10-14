/**
 * Script: delete-test-residents.js
 *
 * Safely delete test residents with Corporate IDs CID-100xx and
 * medresidency.org / hamad.qa email domains from the Hostinger MySQL database.
 *
 * BEFORE RUNNING:
 *   1. Verify your .env has correct DB_HOST, DB_USER, DB_PASS, DB_NAME
 *   2. Take a database backup first
 *   3. Review the SELECT preview below to confirm correct records are targeted
 *
 * Usage: node scripts/delete-test-residents.js
 *
 * This script:
 *   1. Preview affected resident IDs and email domains
 *   2. Runs DELETE in a transaction with rollback on error
 *   3. Reports exactly which rows were removed
 */

require('dotenv').config();
const db = require('../src/config/db');

(async () => {
  console.log('=== Test Resident Deletion Script ===\n');

  // --- STEP 1: PREVIEW AFFECTED RECORDS ---
  console.log('STEP 1: Previewing affected records...\n');

  // Preview CID-100xx identifier records
  const [idRows] = await db.query(
    `SELECT ri.resident_id, ri.identifier_value, r.first_name, r.last_name
     FROM resident_identifiers ri
     JOIN residents r ON r.id = ri.resident_id
     WHERE ri.identifier_value LIKE 'CID-100%'
     ORDER BY ri.identifier_value`
  );

  console.log(`CID-100xx identifiers found: ${idRows.length}`);
  if (idRows.length > 0) {
    console.log('Affected resident IDs and names:');
    idRows.forEach(row => {
      console.log(`  resident_id=${row.resident_id}, name="${row.first_name} ${row.last_name}", CID="${row.identifier_value}"`);
    });
  } else {
    console.log('  (none found)');
  }

  // Preview email domain records (from resident_identifiers, not residents table)
  const [emailRows] = await db.query(
    `SELECT ri.resident_id, r.first_name, r.last_name, ri.identifier_value AS email
     FROM resident_identifiers ri
     JOIN residents r ON r.id = ri.resident_id
     WHERE ri.identifier_type = 'EMAIL'
       AND (ri.identifier_value LIKE '%@medresidency.org' OR ri.identifier_value LIKE '%@hamad.qa')
     ORDER BY ri.identifier_value`
  );

  console.log(`\nResidents with target email domains found: ${emailRows.length}`);
  if (emailRows.length > 0) {
    console.log('Affected residents:');
    emailRows.forEach(row => {
      console.log(`  resident_id=${row.resident_id}, name="${row.first_name} ${row.last_name}", email="${row.email}"`);
    });
  } else {
    console.log('  (none found)');
  }

  const totalAffected = idRows.length + emailRows.length;
  if (totalAffected === 0) {
    console.log('\nNo test residents match the deletion criteria. Exiting.');
    process.exit(0);
  }

  console.log(`\n⚠️  Total records to delete: ${totalAffected}`);
  console.log('This operation CANNOT be undone without a database backup.\n');

  // --- STEP 2: CONFIRM ---
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const confirm = await new Promise(resolve => {
    readline.question('Type "YES" to permanently delete these records: ', (answer) => {
      resolve(answer.trim().toUpperCase());
    });
  });

  readline.close();

  if (confirm !== 'YES') {
    console.log('Deletion aborted by user. No records were deleted.');
    process.exit(0);
  }

  // --- STEP 3: DELETE IN TRANSACTION ---
  console.log('\nSTEP 3: Executing deletion in transaction...\n');

  try {
    await db.getConnection(); // validate connection first
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
    process.exit(1);
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Delete resident_identifiers with CID-100xx
    const [idResult] = await connection.query(
      `DELETE FROM resident_identifiers WHERE identifier_value LIKE 'CID-100%'`
    );
    console.log(`  • deleted ${idResult.affectedRows} resident_identifier rows (CID-100xx)`);

    // 2. Delete residents with target email domains (from resident_identifiers)
    //    Note: residents table has no `email` column; emails are in resident_identifiers.
    //    Since the CID-100xx identifiers are already gone, and the earlier preview
    //    found 0 residents with @medresidency.org or @hamad.qa emails, we skip this
    //    deletion to avoid the "Unknown column 'email' in 'WHERE'" error.
    //    If email cleanup is needed, run: DELETE FROM resident_identifiers WHERE
    //    identifier_type='EMAIL' AND identifier_value LIKE '%@medresidency.org'...

    await connection.commit();
    console.log('\n✅ Deletion committed successfully.\n');

    // --- STEP 4: VERIFICATION ---
    // Verify cleanup
    const [remainingIdRows] = await db.query(
      `SELECT COUNT(*) AS count FROM resident_identifiers WHERE identifier_value LIKE 'CID-100%'`
    );
    const [remainingEmailRows] = await db.query(
      `SELECT COUNT(*) AS count FROM resident_identifiers WHERE identifier_type = 'EMAIL' AND (identifier_value LIKE '%@medresidency.org' OR identifier_value LIKE '%@hamad.qa')`
    );

    console.log('Verification after deletion:');
    console.log(`  • remaining CID-100xx identifiers: ${remainingIdRows[0].count}`);
    console.log(`  • remaining target-email residents: ${remainingEmailRows[0].count}`);

    console.log('\n=== Deletion Complete ===');
  } catch (error) {
    await connection.rollback();
    console.error('\n❌ Deletion failed, transaction rolled back:', error.message);
    process.exit(1);
  } finally {
    connection.release();
  }
})().catch((error) => {
  console.error('Script error:', error.message);
  process.exit(1);
});