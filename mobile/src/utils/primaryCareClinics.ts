/**
 * The Continuity of Care Clinics (CCC) catalog.
 *
 * The view's default chip pool is exactly the five standard clinics below. Every
 * other clinic a coordinator can pick is listed here as a pre-defined entry, and
 * anything not in this list can be typed by hand as an exact clinic name. Both
 * routes end at the same API call (`createClinicType`), which stores the clinic
 * against the programme so it persists for every coordinator.
 *
 * Only the **name** is the identity: the server derives a code and reactivates an
 * existing row by name, so this list never has to know the database's codes and
 * the two cannot drift. The day/time fields are what the matrix uses to record a
 * clinic's session and to filter the curriculum rows to the matching day; a clinic
 * with no day recorded matches every day.
 */

export interface ClinicCatalogEntry {
  /** The exact clinic name, as shown on the chip and stored in the database. */
  name: string;
  /** `longitudinal_clinic_types.default_day_of_week`, when the clinic has one. */
  defaultDay: string | null;
  /** `HH:MM` session bounds, when the clinic has fixed hours. */
  startTime: string | null;
  endTime: string | null;
  requiresReleaseLetter: boolean;
  /** True for the five standard clinics the view always offers. */
  isDefault: boolean;
}

/** The five standard clinics, in the order the view presents them. */
export const PRIMARY_CARE_DEFAULT_CLINICS: readonly ClinicCatalogEntry[] = [
  {
    name: 'Continuity of Care Clinic (CCC)',
    defaultDay: 'SUNDAY',
    startTime: '10:30',
    endTime: '14:00',
    requiresReleaseLetter: false,
    isDefault: true,
  },
  {
    name: 'Minor Procedures Clinic',
    defaultDay: 'TUESDAY',
    startTime: '07:00',
    endTime: '14:00',
    requiresReleaseLetter: true,
    isDefault: true,
  },
  {
    name: 'Well Baby Clinic (WBC)',
    defaultDay: 'WEDNESDAY',
    startTime: '10:30',
    endTime: '14:00',
    requiresReleaseLetter: true,
    isDefault: true,
  },
  {
    name: 'Antenatal Care Clinic (ANC)',
    defaultDay: 'THURSDAY',
    startTime: '07:00',
    endTime: '14:00',
    requiresReleaseLetter: true,
    isDefault: true,
  },
  {
    name: 'Chronic Disease and Non-Communicable Disease Clinic',
    defaultDay: 'MONDAY',
    startTime: '07:00',
    endTime: '14:00',
    requiresReleaseLetter: true,
    isDefault: true,
  },
];

/** The pre-defined clinics a coordinator can add beyond the standard five. */
export const PRIMARY_CARE_SECONDARY_CLINICS: readonly ClinicCatalogEntry[] = [
  {
    name: 'Minor Surgical Skills Clinic',
    defaultDay: 'MONDAY',
    startTime: '07:00',
    endTime: '14:00',
    requiresReleaseLetter: true,
    isDefault: false,
  },
  {
    name: 'PGY1 Morning Continuity Clinic',
    defaultDay: 'WEDNESDAY',
    startTime: '10:30',
    endTime: '14:00',
    requiresReleaseLetter: false,
    isDefault: false,
  },
  {
    name: 'PGY2 Morning Continuity Clinic',
    defaultDay: 'MONDAY',
    startTime: '10:30',
    endTime: '14:00',
    requiresReleaseLetter: false,
    isDefault: false,
  },
  {
    name: 'PGY3 Morning Continuity Clinic',
    defaultDay: 'SUNDAY',
    startTime: '10:30',
    endTime: '14:00',
    requiresReleaseLetter: false,
    isDefault: false,
  },
  {
    name: 'PGY1 Evening Continuity Clinic',
    defaultDay: 'WEDNESDAY',
    startTime: '16:00',
    endTime: '21:00',
    requiresReleaseLetter: false,
    isDefault: false,
  },
  {
    name: 'PGY2 Evening Continuity Clinic',
    defaultDay: 'MONDAY',
    startTime: '16:00',
    endTime: '21:00',
    requiresReleaseLetter: false,
    isDefault: false,
  },
  {
    name: 'PGY3 Evening Continuity Clinic',
    defaultDay: 'SUNDAY',
    startTime: '16:00',
    endTime: '21:00',
    requiresReleaseLetter: false,
    isDefault: false,
  },
  {
    name: 'Summer Morning Continuity Clinic',
    defaultDay: null,
    startTime: '07:00',
    endTime: '14:00',
    requiresReleaseLetter: false,
    isDefault: false,
  },
  {
    name: 'Dermatology Clinic',
    defaultDay: 'TUESDAY',
    startTime: '07:00',
    endTime: '14:00',
    requiresReleaseLetter: true,
    isDefault: false,
  },
  {
    name: 'Psychiatry Clinic',
    defaultDay: 'WEDNESDAY',
    startTime: '07:00',
    endTime: '14:00',
    requiresReleaseLetter: true,
    isDefault: false,
  },
  {
    name: 'Geriatrics Clinic',
    defaultDay: 'THURSDAY',
    startTime: '07:00',
    endTime: '14:00',
    requiresReleaseLetter: true,
    isDefault: false,
  },
  {
    name: 'High-Risk Obstetrics Clinic',
    defaultDay: 'THURSDAY',
    startTime: '07:00',
    endTime: '14:00',
    requiresReleaseLetter: true,
    isDefault: false,
  },
  {
    name: 'Child Health Clinic',
    defaultDay: 'MONDAY',
    startTime: '07:00',
    endTime: '14:00',
    requiresReleaseLetter: false,
    isDefault: false,
  },
  {
    name: 'Adolescent Health Clinic',
    defaultDay: 'TUESDAY',
    startTime: '07:00',
    endTime: '14:00',
    requiresReleaseLetter: false,
    isDefault: false,
  },
  {
    name: 'Family Planning Clinic',
    defaultDay: 'MONDAY',
    startTime: '07:00',
    endTime: '14:00',
    requiresReleaseLetter: false,
    isDefault: false,
  },
  {
    name: 'Postnatal Care Clinic',
    defaultDay: 'THURSDAY',
    startTime: '07:00',
    endTime: '14:00',
    requiresReleaseLetter: false,
    isDefault: false,
  },
  {
    name: 'Sports Medicine Clinic',
    defaultDay: 'TUESDAY',
    startTime: '07:00',
    endTime: '14:00',
    requiresReleaseLetter: false,
    isDefault: false,
  },
  {
    name: 'Ophthalmology Clinic',
    defaultDay: 'WEDNESDAY',
    startTime: '07:00',
    endTime: '14:00',
    requiresReleaseLetter: true,
    isDefault: false,
  },
  {
    name: 'ENT Clinic',
    defaultDay: 'SUNDAY',
    startTime: '07:00',
    endTime: '14:00',
    requiresReleaseLetter: true,
    isDefault: false,
  },
  {
    name: 'Orthopaedics Clinic',
    defaultDay: 'MONDAY',
    startTime: '07:00',
    endTime: '14:00',
    requiresReleaseLetter: true,
    isDefault: false,
  },
];

/** The whole catalog: the standard five first, then the pre-defined secondary clinics. */
export const PRIMARY_CARE_CLINIC_CATALOG: readonly ClinicCatalogEntry[] = [
  ...PRIMARY_CARE_DEFAULT_CLINICS,
  ...PRIMARY_CARE_SECONDARY_CLINICS,
];

/** Normalise a clinic name for comparison: case- and punctuation-insensitive. */
export function clinicNameKey(name: string | null | undefined): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
}

/** The catalog entry for a clinic name, or `null` when it is a custom name. */
export function catalogEntryFor(name: string | null | undefined): ClinicCatalogEntry | null {
  const key = clinicNameKey(name);
  if (!key) return null;
  return PRIMARY_CARE_CLINIC_CATALOG.find((entry) => clinicNameKey(entry.name) === key) ?? null;
}

/**
 * Order clinic names so the standard five lead, the rest stay alphabetical.
 *
 * The matrix draws its chip pool in this order: the five standard clinics first,
 * in their published order, then any clinic the programme has added.
 */
export function sortClinicOptions(names: readonly string[]): string[] {
  const rank = new Map(PRIMARY_CARE_DEFAULT_CLINICS.map((entry, index) => [clinicNameKey(entry.name), index]));
  return [...names].sort((a, b) => {
    const left = rank.get(clinicNameKey(a));
    const right = rank.get(clinicNameKey(b));
    if (left !== undefined && right !== undefined) return left - right;
    if (left !== undefined) return -1;
    if (right !== undefined) return 1;
    return a.localeCompare(b);
  });
}
