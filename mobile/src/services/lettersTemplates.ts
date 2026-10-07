import { request } from './client';
import type { ApiListResponse, ApiResponse, LetterTemplate } from '../types/api';

/**
 * Release-letter templates: the coordinator's copy-and-edit library.
 *
 * The API is a plain CRUD over `release_letter_templates`, which is all this
 * screen needs — the mail-merge itself happens when a letter is generated, so
 * editing a template never rewrites letters already sent.
 */

export type LetterTemplateInput = Omit<LetterTemplate, 'id' | 'created_at' | 'updated_at'>;

export async function fetchLetterTemplates(): Promise<LetterTemplate[]> {
  const response = await request<ApiListResponse<LetterTemplate>>('/letters/templates');
  return response.data ?? [];
}

export async function createLetterTemplate(
  input: Omit<LetterTemplateInput, 'program_id'> & { program_id?: number },
): Promise<number> {
  // The controller answers `{ success, id }` rather than `{ success, data }`,
  // so both shapes are read — a screen should not break because a create
  // endpoint never grew a `data` envelope.
  const body = await request<ApiResponse<{ id: number }> & { id?: number }>('/letters/templates', {
    method: 'POST',
    data: input,
  });
  const id = body?.data?.id ?? body?.id;
  if (typeof id !== 'number') {
    throw new Error('The server did not return an id for the new template.');
  }
  return id;
}

export async function updateLetterTemplate(
  id: number,
  input: LetterTemplateInput,
): Promise<void> {
  await request<ApiResponse<unknown>>(`/letters/templates/${id}`, {
    method: 'PUT',
    data: input,
  });
}

export async function deleteLetterTemplate(id: number): Promise<void> {
  await request<ApiResponse<unknown>>(`/letters/templates/${id}`, { method: 'DELETE' });
}
