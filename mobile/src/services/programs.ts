import { request, queryString } from './client';
import type {
  ApiListResponse,
  ApiResponse,
  CreateProgramPayload,
  DeleteProgramResult,
  Program,
  UpdateProgramPayload,
} from '../types/api';

/**
 * Programme endpoints — the registry behind the sign-in picker and the
 * coordinator area.
 *
 * The list is no longer derived from the resident roster, so a programme with no
 * current residents (a new one, or one whose cohort graduated) still appears; the
 * enrolled count travels with each row instead of being inferred from whoever
 * happened to be in the last roster page.
 */

export async function fetchPrograms(options: { activeOnly?: boolean } = {}): Promise<Program[]> {
  const path = `/programs${queryString({ active: options.activeOnly ? 'true' : undefined })}`;
  const response = await request<ApiListResponse<Program>>(path);
  return response.data ?? [];
}

export async function createProgram(payload: CreateProgramPayload): Promise<Program> {
  const response = await request<ApiResponse<Program>>('/programs', { method: 'POST', data: payload });
  return response.data;
}

export async function updateProgram(id: number, payload: UpdateProgramPayload): Promise<Program> {
  const response = await request<ApiResponse<Program>>(`/programs/${id}`, {
    method: 'PUT',
    data: payload,
  });
  return response.data;
}

/**
 * Delete a programme.
 *
 * The API answers with whether the row was actually removed or merely
 * deactivated (it deactivates when residents are still enrolled), so the caller
 * can phrase its confirmation accordingly.
 */
export async function deleteProgram(id: number): Promise<DeleteProgramResult> {
  const response = await request<ApiResponse<DeleteProgramResult>>(`/programs/${id}`, {
    method: 'DELETE',
  });
  return response.data;
}
