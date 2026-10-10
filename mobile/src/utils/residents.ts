import type { ResidentIdentifier, ResidentListItem } from '../types/api';
import { formatPgy } from './insights';

/**
 * Small derivations over resident records that more than one screen needs.
 *
 * They live here rather than inside a screen because the sign-in picker and the
 * coordinator roster must agree on how a resident is named and described.
 */

/** `Omar K Al-Nouri` — middle initial folded in when the database has one. */
export function residentFullName(resident: {
  first_name: string;
  middle_initial: string | null;
  last_name: string;
}): string {
  const middle = resident.middle_initial ? ` ${resident.middle_initial}.` : '';
  return `${resident.first_name}${middle} ${resident.last_name}`.trim();
}

/** `PGY-2 · Family Medicine` — the line under a resident's name. */
export function residentSubtitle(resident: {
  pgy_level?: number | null;
  specialty_name: string | null;
}): string {
  const parts: string[] = [];
  if (resident.pgy_level !== null && resident.pgy_level !== undefined) {
    parts.push(formatPgy(resident.pgy_level));
  }
  if (resident.specialty_name) parts.push(resident.specialty_name);
  return parts.join(' · ') || 'Programme not assigned';
}

/**
 * The first identifier of a given type, or `''`.
 *
 * Corporate id, email and mobile are all `resident_identifiers` rows rather
 * than columns on `residents`, so the edit form reads them by type. Returning
 * an empty string rather than `undefined` lets that form bind straight to a
 * controlled input.
 */
export function identifierValue(identifiers: ResidentIdentifier[], type: string): string {
  return identifiers.find((identifier) => identifier.identifier_type === type)?.identifier_value ?? '';
}

/** `ACTIVE_FULL_TIME` -> `Active full time`. */
export function humanizeEnum(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export interface ProgramOption {
  programId: number;
  programCode: string;
  programName: string;
  residentCount: number;
}

/**
 * Derive the list of programmes from the resident roster.
 *
 * There is no `GET /api/v1/programs` endpoint, and adding one is a backend
 * change. Every resident row already carries `program_id`, `program_code` and
 * `specialty_name`, so the distinct programmes can be read straight off the
 * roster instead of inventing an endpoint.
 */
export function deriveProgramsFromResidents(residents: ResidentListItem[]): ProgramOption[] {
  const programs = new Map<number, ProgramOption>();

  for (const resident of residents) {
    if (resident.program_id === null) continue;

    const existing = programs.get(resident.program_id);
    if (existing) {
      existing.residentCount += 1;
      continue;
    }

    programs.set(resident.program_id, {
      programId: resident.program_id,
      programCode: resident.program_code ?? `PROGRAM-${resident.program_id}`,
      programName: resident.specialty_name ?? 'Programme',
      residentCount: 1,
    });
  }

  return [...programs.values()].sort((a, b) => a.programId - b.programId);
}

/** Case-insensitive match across a resident's name, programme and PGY level. */
export function filterResidents(residents: ResidentListItem[], query: string): ResidentListItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return residents;

  return residents.filter((resident) => {
    const haystack = [
      resident.first_name,
      resident.middle_initial,
      resident.last_name,
      resident.program_code,
      resident.specialty_name,
      resident.pgy_level === null ? '' : `pgy-${resident.pgy_level}`,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(needle);
  });
}