import { queryString, request } from './client';
import type {
  ApiListResponse,
  ApiResponse,
  CreateAssignmentPayload,
  CreateBlockPayload,
  RotationAssignment,
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
  const response = await request<ApiListResponse<RotationAssignment>>(
    `/rotations/assignments/resident/${residentId}`,
  );
  return response.data ?? [];
}

export async function createAssignment(payload: CreateAssignmentPayload): Promise<RotationAssignment> {
  const response = await request<ApiResponse<RotationAssignment>>('/rotations/assignments', {
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