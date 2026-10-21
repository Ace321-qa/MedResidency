import { request, queryString } from './client';
import type {
  ApiListResponse,
  ApiResponse,
  CreateProgramPayload,
  DeleteProgramResult,
  Program,
  ProgramConnection,
  ProgramConnectionType,
  ResidencyNetwork,
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

/**
 * The citywide residency network: programmes, declared partnerships and the
 * cross-programme postings standing today.
 *
 * One request rather than three, because the diagram needs all three layers to
 * agree — drawing declared edges against a separately fetched set of nodes would
 * let a programme appear on an edge before it appeared on the map.
 */
export async function fetchResidencyNetwork(): Promise<ResidencyNetwork> {
  const response = await request<ApiResponse<ResidencyNetwork>>('/programs/network');
  return response.data;
}

/** The partnerships a single programme has declared. */
export async function fetchProgramConnections(programId: number): Promise<ProgramConnection[]> {
  const response = await request<ApiListResponse<ProgramConnection>>(
    `/programs/${programId}/connections`,
  );
  return response.data ?? [];
}

/** The partnership kinds the server will accept, so the form never offers a bad one. */
export async function fetchConnectionTypes(): Promise<ProgramConnectionType[]> {
  const response = await request<ApiListResponse<ProgramConnectionType>>(
    '/programs/connection-types',
  );
  return response.data ?? [];
}

/**
 * Declare a partnership between two programmes.
 *
 * The server canonicalises the pair, so calling this from either side produces a
 * single connection rather than a mirrored second one.
 */
export async function createProgramConnection(payload: {
  source_program_id: number;
  target_program_id: number;
  connection_type?: ProgramConnectionType;
}): Promise<ProgramConnection> {
  const response = await request<ApiResponse<ProgramConnection>>('/programs/connections', {
    method: 'POST',
    data: payload,
  });
  return response.data;
}

/** Withdraw a partnership. The row is deactivated, not deleted. */
export async function deleteProgramConnection(connectionId: number): Promise<void> {
  await request<ApiResponse<{ id: number }>>(`/programs/connections/${connectionId}`, {
    method: 'DELETE',
  });
}
