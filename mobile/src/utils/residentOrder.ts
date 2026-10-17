/**
 * Cohort ordering for the Master Rotation Grid.
 *
 * Coordinators read the grid top-down, so the row order is part of the artefact:
 * the senior cohort leads. This module is the single source of that order for
 * both the on-screen matrix and the exported report, so the file a coordinator
 * downloads cannot disagree with the rows they were looking at.
 */

/**
 * Rank a resident's PGY level numerically for descending cohort ordering.
 *
 * The cohort API returns `year_in_program` as a number, but PGY levels are also
 * authored and exported as strings ("PGY-5", "PGY-4", "4+"), so the level is
 * parsed rather than assumed:
 *
 *   - a number passes straight through,
 *   - a "PGY-" prefix is stripped ("PGY-3" -> 3),
 *   - a trailing "+" is worth half a year ("PGY-4+" -> 4.5), and
 *   - anything unreadable ranks 0, i.e. below PGY-1, so a record with no level
 *     sinks to the bottom instead of being promoted above a real cohort.
 */
export function pgyRank(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const match = value.match(/\d+(?:\.\d+)?/);
  if (!match) return 0;
  const base = Number(match[0]);
  return value.includes('+') ? base + 0.5 : base;
}

/** The fields the cohort comparator needs; satisfied by a `CohortGridCell`. */
export interface ResidentOrderFields {
  resident_id: number;
  first_name: string;
  last_name?: string | null;
  employee_id?: string | null;
  pgy_level: number | string | null | undefined;
}

function textKey(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Order residents senior-first: PGY-5, then PGY-4+/PGY-4, ... down to PGY-1.
 *
 * Within a level the order is alphabetical by first name, then by corporate
 * (employee) id, then last name, and finally by id so the sort is total and
 * deterministic even for two residents who share a name and an identifier.
 */
export function compareResidentsByPgy(a: ResidentOrderFields, b: ResidentOrderFields): number {
  const byPgy = pgyRank(b.pgy_level) - pgyRank(a.pgy_level);
  if (byPgy !== 0) return byPgy;

  const byFirstName = textKey(a.first_name).localeCompare(textKey(b.first_name));
  if (byFirstName !== 0) return byFirstName;

  const byEmployeeId = textKey(a.employee_id).localeCompare(textKey(b.employee_id));
  if (byEmployeeId !== 0) return byEmployeeId;

  const byLastName = textKey(a.last_name).localeCompare(textKey(b.last_name));
  if (byLastName !== 0) return byLastName;

  return a.resident_id - b.resident_id;
}

/** A new array of residents in senior-first cohort order. */
export function sortResidentsByPgy<T extends ResidentOrderFields>(residents: readonly T[]): T[] {
  return [...residents].sort(compareResidentsByPgy);
}
