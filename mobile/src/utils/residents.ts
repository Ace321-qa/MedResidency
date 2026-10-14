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

/**
 * The three enrolment buckets the roster's status filter offers. Every stored
 * `resident_status` maps to exactly one of these, or to `OTHER` for the
 * terminal states (graduated, withdrawn) that are neither active nor away.
 */
export type ResidentStatusGroup = 'ACTIVE' | 'OFF_CYCLE' | 'ON_LEAVE' | 'OTHER';

const STATUS_GROUP_BY_STATUS: Record<string, ResidentStatusGroup> = {
  ACTIVE_FULL_TIME: 'ACTIVE',
  ACTIVE_PART_TIME: 'ACTIVE',
  STARTED_OFF_CYCLE: 'OFF_CYCLE',
  LEAVE_OF_ABSENCE: 'ON_LEAVE',
  GRADUATED: 'OTHER',
  WITHDRAWN: 'OTHER',
};

/** Fold a stored `resident_status` into one of the roster's filter buckets. */
export function residentStatusGroup(status: string): ResidentStatusGroup {
  return STATUS_GROUP_BY_STATUS[status] ?? 'OTHER';
}

/** `ACTIVE_FULL_TIME` -> `Active`, `STARTED_OFF_CYCLE` -> `Off-Cycle`. */
export function residentStatusLabel(status: string): string {
  switch (residentStatusGroup(status)) {
    case 'ACTIVE':
      return 'Active';
    case 'OFF_CYCLE':
      return 'Off-Cycle';
    case 'ON_LEAVE':
      return 'On Leave';
    default:
      return humanizeEnum(status);
  }
}

/** The sentinel both filter chips use for "no restriction". */
export const ROSTER_FILTER_ALL = 'ALL';

export interface ResidentRosterFilters {
  /** `ROSTER_FILTER_ALL`, or a PGY level as a string (`'1'`..`'4'`). */
  pgyLevel?: string;
  /** `ROSTER_FILTER_ALL`, or a `ResidentStatusGroup`. */
  statusGroup?: string;
}

/**
 * The roster tab's combined search and filter, kept separate from
 * `filterResidents` on purpose: the list projection now carries the corporate
 * id and email, and matching on those would widen the result set of the older
 * name/programme search the insight checks depend on. This is the richer rule
 * the roster screen actually uses.
 */
export function filterResidentRoster(
  residents: ResidentListItem[],
  query: string,
  filters: ResidentRosterFilters = {},
): ResidentListItem[] {
  const needle = query.trim().toLowerCase();
  const pgy =
    filters.pgyLevel && filters.pgyLevel !== ROSTER_FILTER_ALL
      ? Number(filters.pgyLevel)
      : null;
  const group =
    filters.statusGroup && filters.statusGroup !== ROSTER_FILTER_ALL
      ? filters.statusGroup
      : null;

  return residents.filter((resident) => {
    if (pgy !== null && resident.pgy_level !== pgy) return false;
    if (group !== null && residentStatusGroup(resident.resident_status) !== group) return false;
    if (!needle) return true;

    const haystack = [
      resident.first_name,
      resident.middle_initial,
      resident.last_name,
      resident.program_code,
      resident.specialty_name,
      resident.corporate_id,
      resident.email,
      resident.pgy_level === null ? '' : `pgy-${resident.pgy_level}`,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(needle);
  });
}