/**
 * The CCC longitudinal schedule: which academic day runs which clinic, for how
 * long, and what the matrix calls each row.
 *
 * The database holds the *shape* — `longitudinal_clinic_types` for the clinic,
 * `longitudinal_clinic_slots` for the ten weekly slots of WBC, and
 * `longitudinal_clinic_supervisor_assignments` for who is paired with whom. But
 * `longitudinal_clinic_slots` is empty in the live database, so a matrix built
 * only from it renders as an empty grid and looks broken rather than unbuilt.
 *
 * So the **rows are fixed by the curriculum** (below) and the **columns are data**
 * (the clinic's own slots, falling back to a canonical ten when none are
 * recorded). That way the grid is legible on day one and becomes slot-accurate
 * the moment a coordinator adds slots — no code change, and no fiction invented
 * for a database that has none.
 *
 * What is deliberately *not* hardcoded here: which resident sits in which slot,
 * and who supervises whom. Those are assignments, and inventing them would put
 * fictitious names into a clinical rota. Empty cells read "Unassigned" and the
 * roster column lists the residents available to fill them.
 */

import type { AcademicDayCode } from './academicYear';

/** A row of the matrix: one academic day. */
export interface CccScheduleRow {
  /** Stable key for lists and diffing. */
  key: string;
  code: AcademicDayCode;
  /** Row label, e.g. "PGY-3" or "FMC". */
  label: string;
  /** `Date.getDay()` index: Sunday = 0. */
  weekday: number;
  startTime: string;
  endTime: string;
  /** Clinic the day is spent in; `null` for the FMC days, which are not clinics. */
  clinicCode: string | null;
  clinicName: string | null;
  /** Shown under the row label, e.g. "WBC". */
  caption: string;
}

/**
 * The five weekly rows, in the order the clinic runs them.
 *
 * PGY-3 Sunday, PGY-2 Monday, FMC Tuesday and Thursday, PGY-1 Wednesday. The
 * PGY days sit inside the 10:30-14:00 session and the FMC days run the full
 * 07:00-14:00 day, which is why the times differ per row rather than being one
 * global constant.
 */
export const CCC_SCHEDULE_ROWS: readonly CccScheduleRow[] = [
  {
    key: 'pgy3-sunday',
    code: 'PGY3',
    label: 'PGY-3',
    weekday: 0,
    startTime: '10:30',
    endTime: '14:00',
    clinicCode: null,
    clinicName: null,
    caption: 'WBC',
  },
  {
    key: 'pgy2-monday',
    code: 'PGY2',
    label: 'PGY-2',
    weekday: 1,
    startTime: '10:30',
    endTime: '14:00',
    clinicCode: null,
    clinicName: null,
    caption: 'WBC',
  },
  {
    key: 'fmc-tuesday',
    code: 'FMC',
    label: 'FMC',
    weekday: 2,
    startTime: '07:00',
    endTime: '14:00',
    clinicCode: null,
    clinicName: null,
    caption: 'Foundation of Molecular Medicine',
  },
  {
    key: 'pgy1-wednesday',
    code: 'PGY1',
    label: 'PGY-1',
    weekday: 3,
    startTime: '10:30',
    endTime: '14:00',
    clinicCode: null,
    clinicName: null,
    caption: 'WBC',
  },
  {
    key: 'fmc-thursday',
    code: 'FMC',
    label: 'FMC',
    weekday: 4,
    startTime: '07:00',
    endTime: '14:00',
    clinicCode: null,
    clinicName: null,
    caption: 'Foundation of Molecular Medicine',
  },
] as const;

/** How many weekly slots WBC runs. Ten is the number the clinic publishes. */
export const CCC_WBC_SLOT_COUNT = 10;

/**
 * The ten WBC columns for a clinic that has no recorded slots.
 *
 * `slot_label` is what the cell header shows; `slot_number` is what
 * `longitudinal_clinic_slots.slot_number` holds when real slots exist, so a real
 * slot and a fallback column line up.
 */
export const CCC_FALLBACK_SLOTS: readonly { slot_number: number; slot_label: string }[] =
  Array.from({ length: CCC_WBC_SLOT_COUNT }, (_, index) => ({
    slot_number: index + 1,
    slot_label: `Clinic ${index + 1}`,
  }));

/** Human-readable day name for a `Date.getDay()` index. */
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** True when a `day_of_week` string from the database names this row's weekday. */
export function dayOfWeekMatches(dayOfWeek: string | null | undefined, weekday: number): boolean {
  if (!dayOfWeek) return false;
  const normalized = dayOfWeek.trim().toLowerCase();
  const full = WEEKDAY_NAMES[weekday].toLowerCase();
  const short = WEEKDAY_SHORT[weekday].toLowerCase();
  const first3 = full.slice(0, 3);
  return normalized === full || normalized === short || normalized === first3 || normalized.startsWith(first3);
}

/** The PGY levels that attend a row, e.g. PGY-3 attends the Sunday row. */
export function pgyLevelsForRow(row: CccScheduleRow): number[] | null {
  switch (row.code) {
    case 'PGY1':
      return [1];
    case 'PGY2':
      return [2];
    case 'PGY3':
      return [3];
    default:
      return null;
  }
}