import type { AttendanceLog, LeaveRequest, RotationAssignment } from '../types/api';
import {
  formatDateRange,
  formatShortDate,
  isOnOrAfter,
  isWithinRange,
  toCalendarDate,
  toComparableDate,
  toNumber,
} from './format';

/**
 * Read-only questions the screens ask about the data, kept out of the screens.
 *
 * These are pure functions: give them the API rows, get back a summary. Keeping
 * them here means the dashboard, the schedule and the duty-hours screen all
 * agree on what "current rotation" or "this week's hours" means, and a change of
 * definition happens in exactly one place.
 */

export type RotationPhase = 'ACTIVE' | 'UPCOMING' | 'COMPLETED';

/** Whether an assignment covers today, is still to come, or is already over. */
export function rotationPhase(assignment: RotationAssignment, today = toCalendarDate(new Date())): RotationPhase {
  if (isWithinRange(today, assignment.start_date, assignment.end_date)) return 'ACTIVE';
  if (isOnOrAfter(assignment.start_date, today)) return 'UPCOMING';
  return 'COMPLETED';
}

export interface ScheduleSummary {
  /** The rotation covering today, if the resident is on one right now. */
  current: RotationAssignment | null;
  /** The next rotation that has not started. */
  next: RotationAssignment | null;
  /** The most recent finished rotation — what the resident is doing "between". */
  last: RotationAssignment | null;
  completedCount: number;
  upcomingCount: number;
  /** Sum of `assigned_weeks`, which MySQL sends as a DECIMAL string. */
  totalWeeks: number;
}

export function summarizeSchedule(assignments: RotationAssignment[]): ScheduleSummary {
  const today = toCalendarDate(new Date());

  let current: RotationAssignment | null = null;
  let next: RotationAssignment | null = null;
  let last: RotationAssignment | null = null;
  let completedCount = 0;
  let upcomingCount = 0;
  let totalWeeks = 0;

  // The API returns assignments in ascending start-date order, so the first
  // match in each direction is the right one.
  for (const assignment of assignments) {
    totalWeeks += toNumber(assignment.assigned_weeks) ?? 0;

    switch (rotationPhase(assignment, today)) {
      case 'ACTIVE':
        current ??= assignment;
        break;
      case 'UPCOMING':
        upcomingCount += 1;
        next ??= assignment;
        break;
      case 'COMPLETED':
        completedCount += 1;
        last = assignment;
        break;
    }
  }

  return { current, next, last, completedCount, upcomingCount, totalWeeks };
}

export interface ScheduleBlock {
  blockName: string;
  phase: RotationPhase;
  assignments: RotationAssignment[];
  /** The shared date window of the block, for the group header. */
  dateRange: string;
}

/** Groups a resident's assignments by academic block, preserving API order. */
export function groupScheduleByBlock(assignments: RotationAssignment[]): ScheduleBlock[] {
  const today = toCalendarDate(new Date());
  const blocks = new Map<string, ScheduleBlock>();

  for (const assignment of assignments) {
    const existing = blocks.get(assignment.block_name);
    if (existing) {
      existing.assignments.push(assignment);
      continue;
    }

    blocks.set(assignment.block_name, {
      blockName: assignment.block_name,
      phase: rotationPhase(assignment, today),
      assignments: [assignment],
      dateRange: formatDateRange(assignment.start_date, assignment.end_date),
    });
  }

  return [...blocks.values()];
}

export const DUTY_WINDOW_DAYS = 7;

export interface DutySummary {
  /** Hours logged in the last `DUTY_WINDOW_DAYS` days. */
  windowHours: number;
  /** Shifts logged in that window. */
  windowShifts: number;
  /** Breaches in that window. */
  windowBreaches: number;
  /** Breaches across the resident's whole history. */
  totalBreaches: number;
  /** Hours per logged shift in the window, or null when nothing is logged. */
  averageShiftHours: number | null;
}

/**
 * Summarises duty hours.
 *
 * Note there is no weekly cap in this calculation: `duty_hour_rules` holds the
 * ACGME limits but the API exposes no endpoint for them, so the app reports
 * what it can actually measure and leaves the judgement to the program.
 */
export function summarizeDutyHours(logs: AttendanceLog[], today = new Date()): DutySummary {
  /**
   * Compared as calendar dates rather than as instants. A DATE column arrives
   * as UTC midnight, which in any timezone east of Greenwich lands on the
   * previous local day, so comparing instants would drop shifts that are
   * genuinely inside the window.
   */
  const todayString = toCalendarDate(today);
  const windowStart = toCalendarDate(
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - (DUTY_WINDOW_DAYS - 1)),
  );

  let windowHours = 0;
  let windowShifts = 0;
  let windowShiftsWithHours = 0;
  let windowBreaches = 0;
  let totalBreaches = 0;

  for (const log of logs) {
    const isBreach = log.is_flagged_for_breach === 1;
    if (isBreach) totalBreaches += 1;

    const shiftDate = toComparableDate(log.shift_date);
    if (!shiftDate || shiftDate < windowStart || shiftDate > todayString) continue;

    windowShifts += 1;
    if (isBreach) windowBreaches += 1;

    const hours = toNumber(log.total_hours);
    if (hours !== null) {
      windowHours += hours;
      windowShiftsWithHours += 1;
    }
  }

  return {
    windowHours,
    windowShifts,
    windowBreaches,
    totalBreaches,
    /**
     * Divided by the shifts *in the window that recorded hours*, not by the
     * total number of logged shifts — leave rows carry no hours, so including
     * them would silently understate the average.
     */
    averageShiftHours:
      windowShiftsWithHours > 0
        ? Math.round((windowHours / windowShiftsWithHours) * 100) / 100
        : null,
  };
}

export interface LeaveSummary {
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  /** Sum of `total_days` across approved requests. */
  approvedDays: number;
  /** The most recently submitted request still awaiting a decision. */
  nextPending: LeaveRequest | null;
}

export function summarizeLeaves(leaves: LeaveRequest[]): LeaveSummary {
  let pendingCount = 0;
  let approvedCount = 0;
  let rejectedCount = 0;
  let approvedDays = 0;
  let nextPending: LeaveRequest | null = null;

  for (const leave of leaves) {
    if (leave.status === 'APPROVED') {
      approvedCount += 1;
      approvedDays += leave.total_days ?? 0;
    } else if (leave.status === 'REJECTED') {
      rejectedCount += 1;
    } else if (leave.status === 'PENDING' || leave.status === 'APPROVED_BY_CHIEF') {
      pendingCount += 1;
      // The API returns newest first, so the first pending row is the latest.
      nextPending ??= leave;
    }
  }

  return { pendingCount, approvedCount, rejectedCount, approvedDays, nextPending };
}

/** `PGY-2` for a year in program, or a dash when the enrollment is missing. */
export function formatPgy(yearInProgram: number | null | undefined): string {
  return yearInProgram === null || yearInProgram === undefined ? 'PGY—' : `PGY-${yearInProgram}`;
}

/** One-line summary of a rotation, used on the dashboard and in lists. */
export function describeRotation(assignment: RotationAssignment): string {
  const department = assignment.department_name ?? 'Department not assigned';
  return `${department} · ${formatShortDate(assignment.start_date)} – ${formatShortDate(assignment.end_date)}`;
}