import { request } from './client';
import type { ApiListResponse, ApiResponse, AttendanceLog, LogAttendancePayload, LogAttendanceResult } from '../types/api';

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