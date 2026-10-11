/**
 * Primary Care Clinics: the standard clinic set and catalog.
 *
 * Every programme's "Primary Care Clinics" view is born with the five standard
 * clinics below. They are the contract that view is built around — the screen
 * draws its default chip pool from them — so they are defined once here and
 * seeded idempotently for every programme at server boot (`ensureDefaultClinics`
 * in `longitudinalService`).
 *
 * Anything else a coordinator adds is stored in `longitudinal_clinic_types`
 * against the programme, either resolved from the pre-defined catalog the
 * client offers ("Minor Surgical Skills Clinic", "Dermatology Clinic", …) or
 * typed by hand as an exact clinic name. The server treats both the same way:
 * a clinic that already exists for the programme — active or not — is
 * reactivated, and a genuinely new name is catalogued. Codes are derived from
 * names because the database keys on `(program_id, clinic_code)`, not on names.
 *
 * These constants stay strictly additive. No logic here ever *deactivates* a
 * clinic; moving a legacy row out of the default pool is a one-time data
 * migration (`scripts/migrate-primary-care-clinics.js`), not something repeated
 * on every boot.
 */

/** The five standard clinics every programme starts with. */
const PRIMARY_CARE_DEFAULT_CLINICS = [
  {
    code: 'CCC-CLINIC',
    clinic_name: 'Continuity of Care Clinic (CCC)',
    default_day_of_week: 'SUNDAY',
    start_time: '10:30',
    end_time: '14:00',
    requires_release_letter: 0,
  },
  {
    code: 'MINOR-PROCEDURES',
    clinic_name: 'Minor Procedures Clinic',
    default_day_of_week: 'TUESDAY',
    start_time: '07:00',
    end_time: '14:00',
    requires_release_letter: 1,
  },
  {
    code: 'WBC-CLINIC',
    clinic_name: 'Well Baby Clinic (WBC)',
    default_day_of_week: 'WEDNESDAY',
    start_time: '10:30',
    end_time: '14:00',
    requires_release_letter: 1,
  },
  {
    code: 'ANC-CLINIC',
    clinic_name: 'Antenatal Care Clinic (ANC)',
    default_day_of_week: 'THURSDAY',
    start_time: '07:00',
    end_time: '14:00',
    requires_release_letter: 1,
  },
  {
    code: 'CHRONIC-DISEASE-CLINIC',
    clinic_name: 'Chronic Disease and Non-Communicable Disease Clinic',
    default_day_of_week: 'MONDAY',
    start_time: '07:00',
    end_time: '14:00',
    requires_release_letter: 1,
  },
];

/** The seven legacy clinic names the demo programme used to ship as defaults. */
const LEGACY_NON_DEFAULT_CLINIC_NAMES = [
  'PGY1 Morning Continuity Clinic',
  'PGY2 Morning Continuity Clinic',
  'PGY3 Morning Continuity Clinic',
  'PGY2 Evening Continuity Clinic',
  'PGY3 Evening Continuity Clinic',
  'Summer Morning Continuity Clinic',
  'Minor Surgical Skills Clinic',
];

/**
 * Derive an uppercase clinic code from a clinic name.
 *
 * `(program_id, clinic_code)` is the table's unique key, so new clinics need a
 * code derived from the name a coordinator typed. Non-ASCII and punctuation are
 * stripped rather than transliterated — the code is an identifier, and a clinic
 * called "Al Noor Centre (High-Risk OB)" becoming `AL NOOR CENTRE HIGH RISK OB`
 * once, unique per programme, is all the database asks for.
 *
 * @param {string} name
 * @returns {string} `AL NOOR CENTRE HIGH RISK OB`, or `CLINIC` when empty.
 */
function deriveClinicCode(name) {
  const cleaned = String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\(|\)$/g, '')
    .slice(0, 50);
  return cleaned || 'CLINIC';
}

module.exports = {
  PRIMARY_CARE_DEFAULT_CLINICS,
  LEGACY_NON_DEFAULT_CLINIC_NAMES,
  deriveClinicCode,
};