import { request, queryString } from './client';
import type {
  ApiListResponse,
  ApiResponse,
  DeleteResidentOptions,
  OnboardResidentPayload,
  OnboardResidentResult,
  Resident,
  ResidentListItem,
  UpdateResidentPayload,
} from '../types/api';

/**
 * Resident endpoints. One function per backend call — screens never build a URL
 * or read a response body themselves.
 */

export async function fetchResidentList(params?: {
  programId?: number;
  limit?: number;
  offset?: number;
}): Promise<ResidentListItem[]> {
  const path = `/residents${queryString({
    program_id: params?.programId,
    limit: params?.limit,
    offset: params?.offset,
  })}`;

  const response = await request<ApiListResponse<ResidentListItem>>(path);
  return response.data ?? [];
}

export async function fetchResident(residentId: number): Promise<Resident> {
  const response = await request<ApiResponse<Resident>>(`/residents/${residentId}`);
  return response.data;
}

/** Registers a new resident. The server writes three tables in one transaction. */
export async function onboardResident(payload: OnboardResidentPayload): Promise<OnboardResidentResult> {
  const response = await request<ApiResponse<OnboardResidentResult>>('/residents/onboard', {
    method: 'POST',
    data: payload,
  });
  return response.data;
}

/**
 * Updates a resident's profile. Only the fields sent are changed, so an edit
 * form does not have to restate the whole record.
 */
export async function updateResident(
  residentId: number,
  payload: UpdateResidentPayload,
): Promise<Resident> {
  const response = await request<ApiResponse<Resident>>(`/residents/${residentId}`, {
    method: 'PUT',
    data: payload,
  });
  return response.data;
}

/**
 * Deletes a resident.
 *
 * The API refuses with a 409 while attendance, rotation, leave, letter or
 * duty-hour history exists, returning the counts in its message. Pass
 * `{ cascade: true }` to delete that history too.
 */
export async function deleteResident(
  residentId: number,
  options: DeleteResidentOptions = {},
): Promise<void> {
  const path = `/residents/${residentId}${queryString({ cascade: options.cascade ? 'true' : undefined })}`;
  await request<ApiResponse<{ id: number }>>(path, { method: 'DELETE' });
}

/**
 * Removes a resident's enrolment from a programme, leaving the person and their
 * history intact. This is the roster-safe alternative to a full delete.
 */
export async function removeResidentEnrollment(
  residentId: number,
  programId?: number,
): Promise<void> {
  const path = `/residents/${residentId}/enrollment${queryString({ program_id: programId })}`;
  await request<ApiResponse<{ resident_id: number; removed: number }>>(path, { method: 'DELETE' });
}