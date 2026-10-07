import { request } from './client';
import type { ApiResponse } from '../types/api';

export async function createRotationRequest(payload: any): Promise<any> {
  const response = await request<ApiResponse<any>>('/requests/rotation', { method: 'POST', data: payload });
  return response.data;
}
