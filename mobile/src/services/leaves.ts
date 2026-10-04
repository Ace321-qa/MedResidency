import { request } from './client';
import type {
  ApiListResponse,
  ApiResponse,
  LeaveRequest,
  LeaveRequestPayload,
  LeaveStatusPayload,
} from '../types/api';

/**
 * Statutory leave endpoints.
 *
 * Leave types and statuses are MySQL enums. `LEAVE_TYPES` in `types/api.ts`
 * mirrors the column exactly, so the form can only ever submit a legal value.
 */

export async function fetchLeaves(residentId: number): Promise<LeaveRequest[]> {
  const response = await request<ApiListResponse<LeaveRequest>>(`/leaves/resident/${residentId}`);
  return response.data ?? [];
}

export async function submitLeaveRequest(payload: LeaveRequestPayload): Promise<LeaveRequest> {
  const response = await request<ApiResponse<LeaveRequest>>('/leaves/request', {
    method: 'POST',
    data: payload,
  });
  return response.data;
}

/**
 * Records a review decision. The server enforces the approval workflow and
 * answers 409 when a transition is not allowed.
 */
export async function updateLeaveStatus(
  requestId: number,
  payload: LeaveStatusPayload,
): Promise<LeaveRequest> {
  const response = await request<ApiResponse<LeaveRequest>>(`/leaves/${requestId}/status`, {
    method: 'PATCH',
    data: payload,
  });
  return response.data;
}