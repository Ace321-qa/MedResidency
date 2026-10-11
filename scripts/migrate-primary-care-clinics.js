#!/usr/bin/env node
/**
 * One-time migration: reconcile the Primary Care Clinics catalog.
 *
 * The demo programme shipped seven clinic rows as defaults (`PGY1 Morning
 * Continuity Clinic`, the PGY evening clinics, `Summer Morning Continuity
 * Clinic`, `Minor Surgical Skills Clinic`, …). The refactored view has exactly
 * five standard defaults and offers those seven from its add-clinic catalog, so
 * this migration:
 *
 *   1. Ensures the five standard clinics exist and are active for every
 *      programme (same call the server makes at boot).
 *   2. Deactivates the seven legacy rows, where still active, so the default
 *      chip pool is the standard five. **Nothing is deleted**: the rows keep
 *      their ids and codes, so existing teaching-assignment and supervisor
 *      records that reference them still resolve, and a coordinator bringing one
 *      back from the catalog simply flips it active again.
 *
 * Idempotent — safe to run more than once. Nothing here runs at server boot, so
 * a clinic a coordinator deliberately re-adds cannot be deactivated again.
 *
 *   node scripts/migrate-primary-care-clinics.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../src/config/db');
const LongitudinalService = require('../src/services/longitudinalService');
const { LEGACY_NON_DEFAULT_CLINIC_NAMES } = require('../src/utils/primaryCareClinics');

(async () => {
  console.log('Migrating Primary Care Clinics…');

  const seeded = await LongitudinalService.ensureDefaultClinics();
  console.log(`  • ensured ${seeded.length} standard clinic record(s) across all programmes.`);

  const placeholders = LEGACY_NON_DEFAULT_CLINIC_NAMES.map(() => '?').join(', ');
  const [result] = await db.query(
    `UPDATE longitudinal_clinic_types
        SET is_active = 0, updated_at = CURRENT_TIMESTAMP
      WHERE is_active = 1 AND clinic_name IN (${placeholders})`,
    [...LEGACY_NON_DEFAULT_CLINIC_NAMES]
  );
  console.log(`  • moved ${result.affectedRows} legacy clinic(s) out of the default pool (kept on record).`);

  const [defaults] = await db.query(
    `SELECT program_id, COUNT(*) AS active
       FROM longitudinal_clinic_types
      WHERE is_active = 1
      GROUP BY program_id
      ORDER BY program_id ASC`
  );
  console.log('  • active clinic counts by programme:', JSON.stringify(defaults));

  console.log('Done.');
  process.exit(0);
})().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});