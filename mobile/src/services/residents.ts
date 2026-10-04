import { request, queryString } from './client';
import type {
  ApiListResponse,
  ApiResponse,
  OnboardResidentPayload,
  OnboardResidentResult,
  Resident,
  ResidentListItem,
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