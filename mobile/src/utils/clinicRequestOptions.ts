import type { LongitudinalClinicType, RotationCatalogueEntry } from '../types/api';
import { PRIMARY_CARE_DEFAULT_CLINICS, clinicNameKey } from './primaryCareClinics';

/**
 * The clinic pick-list for a resident's clinic-rotation request.
 *
 * Three sources feed it, in priority order:
 *
 *  1. **The standard primary-care clinics** — the five published clinics the
 *     programme always runs. They are constants, not API data, so the field is
 *     never empty: a resident can always ask for the ANC even when the
 *     programme's clinic catalogue is unreachable or has not been set up.
 *  2. **The programme's active clinic catalogue** (`longitudinal_clinic_types`)
 *     — every clinic a coordinator has added to the CCC matrix.
 *  3. **The Rotations Catalogue** — the active rotations a resident can ask to
 *     join as a clinic. Entries carry their `rotation_id` so the coordinator's
 *     approval resolves the exact rotation instead of matching a typed string.
 *
 * Deduplication is by normalised name, and the first source wins. A clinic the
 * programme catalogued therefore never appears twice just because the same name
 * is also one of the standard five — and the duplicate never carries a
 * `rotation_id` it does not need.
 */

/** What every pick-list row carries besides its label. */
export interface ClinicRequestOption {
  /**
   * Stable select value. Namespaced by source because a clinic name and a
   * rotation id live in different id spaces: `clinic:<normalised name>` or
   * `rotation:<id>`.
   */
  value: string;
  /** `Antenatal Care Clinic (ANC) — Primary Care`; `SheetSelectField` filters on this. */
  label: string;
  /** Stored as `department_clinic` on the request. */
  clinicName: string;
  /** Set only for a Rotations Catalogue entry — what approval places. */
  rotationId: number | null;
}

/** The department every CCC / primary-care clinic is catalogued under. */
const PRIMARY_CARE_DEPARTMENT = 'Primary Care';

export interface ClinicRequestSources {
  /** `GET /longitudinal/clinic-types?program_id=X` rows. */
  clinicTypes?: readonly Pick<
    LongitudinalClinicType,
    'id' | 'clinic_name' | 'is_active' | 'display_order'
  >[];
  /** `GET /rotations/catalogue?program_id=X` rows. */
  catalogue?: readonly Pick<
    RotationCatalogueEntry,
    'id' | 'full_name' | 'abbreviation' | 'department' | 'is_active'
  >[];
}

/** The label a catalogue rotation shows: name, abbreviation, hospital department. */
export function rotationCatalogueLabel(
  entry: Pick<RotationCatalogueEntry, 'full_name' | 'abbreviation' | 'department'>,
): string {
  const name = entry.abbreviation?.trim()
    ? `${entry.full_name} (${entry.abbreviation})`
    : entry.full_name;
  return entry.department?.trim() ? `${name} — ${entry.department}` : name;
}

export function buildClinicRequestOptions(sources: ClinicRequestSources): ClinicRequestOption[] {
  const seen = new Set<string>();
  const options: ClinicRequestOption[] = [];

  /** Add a name-based clinic, ignoring blanks, duplicates and repeated names. */
  function addClinic(name: string | null | undefined) {
    const trimmed = (name ?? '').trim();
    const key = clinicNameKey(trimmed).trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    options.push({
      value: `clinic:${key}`,
      label: `${trimmed} — ${PRIMARY_CARE_DEPARTMENT}`,
      clinicName: trimmed,
      rotationId: null,
    });
  }

  // 1. The standard five, in their published order.
  for (const clinic of PRIMARY_CARE_DEFAULT_CLINICS) addClinic(clinic.name);

  // 2. Programme clinics, by the matrix's own column order so the pick-list
  //    reads in the same order as the screen the coordinator maintains.
  const clinicTypes = [...(sources.clinicTypes ?? [])].sort(
    (left, right) =>
      (left.display_order ?? Number.MAX_SAFE_INTEGER) - (right.display_order ?? Number.MAX_SAFE_INTEGER) ||
      left.clinic_name.localeCompare(right.clinic_name),
  );
  for (const clinic of clinicTypes) {
    if (clinic.is_active !== 1) continue;
    addClinic(clinic.clinic_name);
  }

  // 3. Catalogue rotations, alphabetically — they are the fallback tail of the
  //    list, not the clinics a resident usually wants.
  const rotations = [...(sources.catalogue ?? [])]
    .filter((entry) => entry.is_active === 1)
    .sort((left, right) => left.full_name.localeCompare(right.full_name));
  for (const entry of rotations) {
    const key = clinicNameKey(entry.full_name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    options.push({
      value: `rotation:${entry.id}`,
      label: rotationCatalogueLabel(entry),
      // The same rule the hospital form uses: the department is what the queue
      // reads, the rotation name is the fallback when no department is set.
      clinicName: entry.department?.trim() || entry.full_name.trim(),
      rotationId: entry.id,
    });
  }

  return options;
}
