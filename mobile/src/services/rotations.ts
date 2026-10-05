import { queryString, request } from './client';
import type {
  ApiListResponse,
  ApiResponse,
  CohortGridCell,
  CreateAssignmentPayload,
  CreateBlockPayload,
  RotationAssignment, RotationAssignmentDetail,
  RotationBlock,
  RotationDefinition,
} from '../types/api';

/** Rotation blocks, rotation catalogue and resident assignments. */

export async function fetchRotationBlocks(programId: number): Promise<RotationBlock[]> {
  const path = `/rotations/blocks${queryString({ program_id: programId })}`;
  const response = await request<ApiListResponse<RotationBlock>>(path);
  return response.data ?? [];
}

export async function fetchRotations(programId: number): Promise<RotationDefinition[]> {
  const path = `/rotations${queryString({ program_id: programId })}`;
  const response = await request<ApiListResponse<RotationDefinition>>(path);
  return response.data ?? [];
}

/** The rotation schedule for one resident, ordered by start date. */
export async function fetchResidentSchedule(residentId: number): Promise<RotationAssignment[]> {
  const response = await request<ApiListResponse<RotationAssignmentDetail>>(
    `/rotations/assignments/resident/${residentId}`,
  );
  return response.data ?? [];
}

export async function createAssignment(payload: CreateAssignmentPayload): Promise<RotationAssignmentDetail> {
  const response = await request<ApiResponse<RotationAssignmentDetail>>('/rotations/assignments', {
    method: 'POST',
    data: payload,
  });
  return response.data;
}

/**
 * `POST /rotations/blocks` — creates one academic block.
 *
 * The API rejects a duplicate `block_number` for the same `academic_year` with
 * a 409, and a block whose end date precedes its start date with a 400. Both
 * messages are surfaced by the client as `ApiError`, so the form can show them
 * verbatim rather than inventing its own wording.
 */
export async function createRotationBlock(payload: CreateBlockPayload): Promise<RotationBlock> {
  const response = await request<ApiResponse<RotationBlock>>('/rotations/blocks', {
    method: 'POST',
    data: payload,
  });
  return response.data;
}

/**
 * `GET /rotations/assignments/cohort` — the cohort master grid.
 *
 * One request replaces the three the grid used to make: the grid is built from
 * the block calendar on the server and LEFT JOINed to assignments, so unassigned
 * cells come back as rows rather than as holes, and the resident name, PGY level
 * and block dates are resolved in the same query instead of being joined in the
 * client from a roster that may not share the year's formatting.
 *
 * `academic_year` is normalised server-side, so the slash form this app builds
 * ("2026/2027") and the hyphenated form the column stores ("2026-2027") are the
 * same year to the API — which is exactly the comparison a client must not try
 * to make itself.
 */
export async function fetchCohortGrid(filters: {
  academic_year: string;
  pgy_level?: number;
  program_id?: number;
}): Promise<CohortGridCell[]> {
  const path = `/rotations/assignments/cohort${queryString({
    academic_year: filters.academic_year,
    pgy_level: filters.pgy_level,
    program_id: filters.program_id,
  })}`;
  const response = await request<ApiListResponse<CohortGridCell>>(path);
  return response.data ?? [];
}

export async function updateRotationBlock(blockId: number, payload: CreateBlockPayload): Promise<RotationBlock> {
  const response = await request<ApiResponse<RotationBlock>>(`/rotations/blocks/${blockId}`, {
    method: 'PUT',
    data: payload,
  });
  return response.data;
}

export async function deleteRotationBlock(blockId: number): Promise<void> {
  await request<ApiResponse<any>>(`/rotations/blocks/${blockId}`, {
    method: 'DELETE',
  });
}
