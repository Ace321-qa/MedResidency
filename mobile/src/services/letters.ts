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
 * The coordinator's two letter boxes.
 *
 * - `sent` (default) — every letter merged from the programme's own templates.
 * - `received` — the inbox: letters *other* programmes dispatched that concern
 *   this one (a partner's rotation notice for a visiting resident, or a letter
 *   about one of our residents issued elsewhere). Each row carries the
 *   dispatching programme's name so the inbox can say who it is from.
 */
export async function fetchDispatchedLetters(
  programId?: number,
  box: 'sent' | 'received' = 'sent',
): Promise<ReleaseLetter[]> {
  const params = new URLSearchParams();
  if (programId) params.set('program_id', String(programId));
  if (box !== 'sent') params.set('box', box);
  const query = params.toString();
  const response = await request<ApiListResponse<ReleaseLetter>>(
    query ? `/letters?${query}` : '/letters',
  );
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
