import { request } from './client';
import type {
  ApiListResponse,
  ApiResponse,
  AttendanceLog,
  LogAttendancePayload,
  LogAttendanceResult,
  LogTimesheetBatchResult,
  TimesheetRowInput,
} from '../types/api';

/**
 * Attendance endpoints.
 *
 * The server evaluates every logged shift against the program's active ACGME
 * rule set and returns `is_flagged_for_breach` together with `breach_details`.
 * Those two fields drive the most important alert in the app, so the raw result
 * is passed through untouched.
 */

export async function fetchAttendance(residentId: number): Promise<AttendanceLog[]> {
  const response = await request<ApiListResponse<AttendanceLog>>(
    `/attendance/resident/${residentId}`,
  );
  return response.data ?? [];
}

export async function logAttendance(payload: LogAttendancePayload): Promise<LogAttendanceResult> {
  const response = await request<ApiResponse<LogAttendanceResult>>('/attendance', {
    method: 'POST',
    data: payload,
  });
  return response.data;
}

/**
 * Save a whole timesheet — one row per calendar day — in a single transaction.
 *
 * Used when a logged shift crosses midnight: the client splits it into a
 * `…→ 24:00` row and a `00:00 → …` row and sends both together, so the server
 * evaluates them as the one continuous period they are instead of two short
 * shifts. A single all-in-one-day shift can still go through `logAttendance`.
 */
export async function logTimesheetBatch(
  residentId: number,
  rows: TimesheetRowInput[],
): Promise<LogTimesheetBatchResult> {
  const response = await request<ApiResponse<LogTimesheetBatchResult>>('/attendance/batch', {
    method: 'POST',
    data: { resident_id: residentId, rows },
  });
  return response.data;
}