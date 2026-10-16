import { request } from './client';
import type {
  ApiListResponse,
  ApiResponse,
  GenerateLetterPayload,
  MergedLetterResult,
  ReleaseLetter,
} from '../types/api';

/** Release-letter endpoints. The letter body is mail-merged by the server. */

export async function fetchReleaseLetters(residentId: number): Promise<ReleaseLetter[]> {
  const response = await request<ApiListResponse<ReleaseLetter>>(`/letters/resident/${residentId}`);
  return response.data ?? [];
}

/**
 * The coordinator's dispatch log: every letter merged from the programme's
 * templates, addressed to hospital department heads.
 */
export async function fetchDispatchedLetters(programId?: number): Promise<ReleaseLetter[]> {
  const path = programId ? `/letters?program_id=${programId}` : '/letters';
  const response = await request<ApiListResponse<ReleaseLetter>>(path);
  return response.data ?? [];
}

/** Run the mail merge without dispatching — the live preview box. */
export async function previewReleaseLetter(
  payload: GenerateLetterPayload,
): Promise<MergedLetterResult> {
  const response = await request<ApiResponse<MergedLetterResult>>('/letters/preview', {
    method: 'POST',
    data: payload,
  });
  return response.data;
}

/** Generate and dispatch the official release letter in one transaction. */
export async function generateReleaseLetter(
  payload: GenerateLetterPayload,
): Promise<MergedLetterResult> {
  const response = await request<ApiResponse<MergedLetterResult>>('/letters/generate', {
    method: 'POST',
    data: payload,
  });
  return response.data;
}
