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

/**
 * The `Date.getDay()` index (0 = Sunday) a `day_of_week` string names, or -1.
 *
 * The seven-day twin of `dayOfWeekMatches`, used to sort a cycle's day rows and
 * locate the Week Start Date's weekday when the sequence rotates off Sunday.
 */
export function weekdayIndex(dayOfWeek: string | null | undefined): number {
  if (!dayOfWeek) return -1;
  for (let index = 0; index < WEEKDAY_NAMES.length; index += 1) {
    if (dayOfWeekMatches(dayOfWeek, index)) return index;
  }
  return -1;
}

/** The canonical day name (e.g. 'Monday') a `day_of_week` string names, or null. */
export function weekdayName(dayOfWeek: string | null | undefined): (typeof WEEKDAY_NAMES)[number] | null {
  const index = weekdayIndex(dayOfWeek);
  return index < 0 ? null : WEEKDAY_NAMES[index];
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

/**
 * The numeric training level a day's context names, e.g. "PGY-3" -> 3.
 *
 * A day on the CCC grid carries a PGY level or a mixed-session context. When it
 * names a single level ([1-9]), the slot dropdowns draw only from residents
 * enrolled at exactly that level. A mixed context — "FMC", "ALL", a blank or
 * anything unrecognised — is not a single level, so this returns `null` and the
 * caller leaves the list open rather than filtering it wrongly.
 */
export function pgyLevelFromLabel(label: string | null | undefined): number | null {
  if (!label) return null;
  const match = /PGY[\s._-]*(\d{1,2})/i.exec(String(label).trim());
  if (!match) return null;
  const level = Number(match[1]);
  return Number.isInteger(level) && level >= 1 && level <= 9 ? level : null;
}

/* ------------------------------------------------------------------ *
 * Cycle & schedule metadata banner.
 *
 * The matrix header bar reads as one sentence so a coordinator can see
 * which cycle/week they are looking at, when it starts and which session
 * it runs before touching a single cell. The values are stored in the
 * shapes the database already holds — "Cycle 1", "10:30 – 2:00" — so the
 * helpers below normalise both the labels and the human-readable banner.
 * ------------------------------------------------------------------ */

/** A clock time parsed into its 24-hour parts. */
interface ClockParts {
  hours: number;
  minutes: number;
}

/**
 * The first run of digits in a stored label, e.g. `"Cycle 3"` -> `"3"`.
 *
 * The cycle and week numbers are stored as free text ("Cycle 1", "Week 2"),
 * so the picker has to read the number back out of whatever spelling is on
 * record rather than assume a bare digit.
 */
export function numericLabelValue(value: string | null | undefined): string {
  const match = /\d+/.exec(String(value ?? ''));
  return match ? match[0] : '';
}

/** Parse `HH:MM` (24-hour) out of a clock string, or null when it is unusable. */
function parseClock(value: string | null | undefined): ClockParts | null {
  const match = /(\d{1,2})\s*:\s*(\d{2})/.exec(String(value ?? ''));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `14:00` -> `"02:00 PM"`, `10:30` -> `"10:30 AM"`. Returns `''` when unusable. */
export function formatClock12Hour(value: string | null | undefined): string {
  const clock = parseClock(value);
  if (!clock) return '';
  const period = clock.hours >= 12 ? 'PM' : 'AM';
  const hours = clock.hours % 12 === 0 ? 12 : clock.hours % 12;
  return `${pad2(hours)}:${pad2(clock.minutes)} ${period}`;
}

/**
 * Split a stored shift string into its start and end clock times.
 *
 * Accepts the en dash the curriculum writes (`"10:30 – 2:00"`) and a plain
 * hyphen, and tolerates surrounding spaces.
 */
export function splitShiftRange(value: string | null | undefined): [string, string] | null {
  if (!value) return null;
  const parts = String(value)
    .split(/\s*[–—-]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  return [parts[0], parts[1]];
}

/**
 * `"10:30 – 2:00"` -> `"10:30 AM - 02:00 PM"`, the form the banner prints.
 *
 * A session ends after it starts, so an end written the short way (`"2:00"`
 * after a `"10:30"` start) is read as the afternoon — otherwise a 10:30-14:00
 * clinic would render as ending before it began.
 */
export function formatShiftRange(value: string | null | undefined): string {
  const range = splitShiftRange(value);
  if (!range) return '';
  const [rawStart, rawEnd] = range;
  const start = parseClock(rawStart);
  const end = parseClock(rawEnd);
  if (!start || !end) return '';

  let endHours = end.hours;
  if (endHours < 12 && endHours <= start.hours && !/am|pm/i.test(rawEnd)) {
    endHours += 12;
  }
  return `${formatClock12Hour(rawStart)} - ${formatClock12Hour(`${endHours}:${pad2(end.minutes)}`)}`;
}

/** `Sunday, 28/06/2026` — the day name and DD/MM/YYYY date the banner shows. */
export function formatDayDate(
  day: string | null | undefined,
  isoDate: string | null | undefined,
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate ?? ''));
  if (!match) return day ? String(day) : '';
  const label = day ? `${day}, ` : '';
  return `${label}${match[3]}/${match[2]}/${match[1]}`;
}

export interface CycleMetadataBannerInput {
  cycleNumber: string | null | undefined;
  weekNumber: string | null | undefined;
  /** The week's first day, e.g. `"Sunday"`. */
  startsOn: string | null | undefined;
  /** `YYYY-MM-DD`. */
  startDate: string | null | undefined;
  /** The first session's stored shift, e.g. `"10:30 – 2:00"`. */
  shiftTime: string | null | undefined;
  pgyLevel: string | null | undefined;
}

/**
 * The human-readable matrix header bar:
 *
 *     Cycle 1 · Week 1 | Starts: Sunday, 28/06/2026 | Shift: 10:30 AM - 02:00 PM (PGY-3)
 *
 * Sections whose data is missing are dropped rather than printed empty, so a
 * fresh cycle still reads as a sentence while it is being set up.
 */
export function formatCycleMetadataBanner(input: CycleMetadataBannerInput): string {
  const cycle = numericLabelValue(input.cycleNumber) || '1';
  const week = numericLabelValue(input.weekNumber) || '1';
  const sections = [`Cycle ${cycle} · Week ${week}`];

  const starts = formatDayDate(input.startsOn, input.startDate);
  if (starts) sections.push(`Starts: ${starts}`);

  const shift = formatShiftRange(input.shiftTime);
  if (shift) {
    const context = input.pgyLevel ? ` (${input.pgyLevel})` : '';
    sections.push(`Shift: ${shift}${context}`);
  }

  return sections.join(' | ');
}
