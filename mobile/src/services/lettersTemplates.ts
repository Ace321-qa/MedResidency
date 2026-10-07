import { request } from './client';
import type { ApiListResponse } from '../types/api';

export async function fetchLetterTemplates(): Promise<any[]> {
  const response = await request<ApiListResponse<any>>('/letters/templates');
  return response.data ?? [];
}
