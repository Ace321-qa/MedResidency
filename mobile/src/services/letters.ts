import { request } from './client';
import type { ApiListResponse, ApiResponse, GenerateLetterPayload, ReleaseLetter } from '../types/api';

/** Release-letter endpoints. The letter body is mail-merged by the server. */

export async function fetchReleaseLetters(residentId: number): Promise<ReleaseLetter[]> {
  const response = await request<ApiListResponse<ReleaseLetter>>(`/letters/resident/${residentId}`);
  return response.data ?? [];
}

export async function generateReleaseLetter(payload: GenerateLetterPayload): Promise<ReleaseLetter> {
  const response = await request<ApiResponse<ReleaseLetter>>('/letters/generate', {
    method: 'POST',
    data: payload,
  });
  return response.data;
}