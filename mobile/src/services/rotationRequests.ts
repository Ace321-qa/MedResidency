import { request } from './client';
import type { ApiResponse, RotationRequest, RotationRequestStatus, RotationRequestType } from '../types/api';

/**
 * Rotation requests: the resident asks, the coordinator decides.
 *
 * The old client posted to an endpoint that answered `{ success: true }`
 * without persisting anything, which is why a submitted request never appeared
 * anywhere. Every function below maps to a real row in `rotation_requests`.
 */

export interface CreateRotationRequestBody {
  resident_id: number;
  program_id: number;
  request_type: RotationRequestType;
  department_clinic: string;
  /**
   * The catalogue rotation the resident picked, when they picked one from the
   * pick-list. Nullable so a resident can still type a free-text department
   * the catalogue has not catalogued yet, or fall back to manual entry when
   * the catalogue could not be fetched.
   */
  rotation_id?: number | null;
  start_date: string;
  end_date: string;
  reason?: string;
}

export async function createRotationRequest(
  payload: CreateRotationRequestBody,
): Promise<RotationRequest> {
  const response = await request<ApiResponse<{ request: RotationRequest }> | { request: RotationRequest } | RotationRequest>(
    '/requests/rotation',
    {
      method: 'POST',
      data: payload,
    },
  );
  const body = response as any;
  return body?.data?.request ?? body?.request ?? body;
}

export async function fetchRotationRequests(params: {
  program_id?: number;
  resident_id?: number;
  status?: RotationRequestStatus;
}): Promise<RotationRequest[]> {
  const response = await request<ApiResponse<RotationRequest[]> | { data: RotationRequest[] } | RotationRequest[]>(
    '/requests/rotation',
    { params },
  );
  const body = response as any;
  return body?.data ?? body ?? [];
}

export async function updateRotationRequest(
  requestId: number,
  payload: { status: 'APPROVED' | 'REJECTED'; decision_reason?: string },
): Promise<RotationRequest> {
  const response = await request<ApiResponse<{ request: RotationRequest }> | { request: RotationRequest } | RotationRequest>(
    `/requests/rotation/${requestId}`,
    { method: 'PATCH', data: payload },
  );
  const body = response as any;
  return body?.data?.request ?? body?.request ?? body;
}
