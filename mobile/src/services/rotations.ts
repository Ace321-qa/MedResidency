import { queryString, request } from './client';
import type {
  ApiListResponse,
  ApiResponse,
  BlockCalendar,
  BlockCalendarWindow,
  BlockFinalizationResult,
  CalendarDateString,
  CapacityVerdict,
  CohortGridCell,
  CreateAssignmentPayload,
  CreateBlockPayload,
  GenerateBlocksResult,
  RotationAssignment, RotationAssignmentDetail,
  RotationBlock,
  RotationDefinition,
  RotationNoticeDispatchResult,
  RotationNoticePlan,
} from '../types/api';

/** Rotation blocks, rotation catalogue and resident assignments. */

export async function fetchRotationBlocks(programId: number): Promise<RotationBlock[]> {
  const path = `/rotations/blocks${queryString({ program_id: programId })}`;
  const response = await request<ApiListResponse<RotationBlock>>(path);
  return response.data ?? [];
}

/**
 * `POST /rotations/blocks/generate` — complete the active academic year to its
 * thirteen four-week blocks.
 *
 * Idempotent: a full year returns `created: []` and the server writes nothing.
 * The block list calls it as it opens, so a year that was only partly typed in
 * (production stopped at Block 7) still shows the whole calendar. Existing
 * blocks are never edited — they may carry assignments.
 */
export async function generateAcademicBlocks(programId: number): Promise<GenerateBlocksResult> {
  const response = await request<ApiResponse<GenerateBlocksResult>>('/rotations/blocks/generate', {
    method: 'POST',
    data: { program_id: programId },
  });
  return response.data;
}

export async function fetchRotations(programId: number): Promise<RotationDefinition[]> {
  const path = `/rotations${queryString({ program_id: programId })}`;
  const response = await request<ApiListResponse<RotationDefinition>>(path);
  return response.data ?? [];
}

/**
 * `PATCH /rotations/blocks/:block_id/finalized` — declare a block settled (or
 * return it to draft) so its notices may be dispatched.
 */
export async function setBlockFinalized(
  blockId: number,
  isFinalized: boolean,
): Promise<BlockFinalizationResult> {
  const response = await request<ApiResponse<BlockFinalizationResult>>(
    `/rotations/blocks/${blockId}/finalized`,
    { method: 'PATCH', data: { is_finalized: isFinalized } },
  );
  return response.data;
}

/** The confirmation summary for a notice run. Reads only; writes nothing. */
export async function previewRotationNotices(payload: {
  program_id: number;
  block_id?: number;
  start_date?: string;
  end_date?: string;
  academic_year?: string;
}): Promise<RotationNoticePlan> {
  const response = await request<ApiResponse<RotationNoticePlan>>('/rotations/grid/notices/preview', {
    method: 'POST',
    data: payload,
  });
  return response.data;
}

/** Dispatch the notices: one stored letter per assignment, plus resident notifications. */
export async function sendRotationNotices(payload: {
  program_id: number;
  block_id?: number;
  start_date?: string;
  end_date?: string;
  academic_year?: string;
  template_code?: string;
  send_to_coordinators?: boolean;
  notify_residents?: boolean;
  sent_by_user_id?: number;
  recipient_dept_head?: string;
  coordinator_name?: string;
  program_director_name?: string;
  regenerate?: boolean;
}): Promise<RotationNoticeDispatchResult> {
  const response = await request<ApiResponse<RotationNoticeDispatchResult>>(
    '/rotations/grid/send-notices',
    { method: 'POST', data: payload },
  );
  return response.data;
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
 * `POST /rotations/assignments/check-capacity` — preview a seat-limit verdict.
 *
 * The assignment modal calls this as soon as a rotation and a date window are
 * chosen, so the amber or red banner appears *before* the coordinator fills in
 * a rationale. The server runs the same engine the write runs, so the preview
 * and the enforcement cannot disagree — which is why the client asks rather
 * than re-deriving the tier table itself.
 */
export async function checkAssignmentCapacity(payload: {
  rotation_id: number;
  start_date: string;
  end_date: string;
  program_id?: number;
  /** The resident being placed, so their own existing rows do not count against them. */
  resident_id?: number;
  exclude_assignment_id?: number;
  /** The block being placed into, so occupancy is scoped to that block's date window. */
  rotation_block_id?: number;
}): Promise<CapacityVerdict> {
  const response = await request<ApiResponse<CapacityVerdict>>(
    '/rotations/assignments/check-capacity',
    { method: 'POST', data: payload },
  );
  return response.data;
}

/**
 * `GET /rotations/blocks/dates` — the block calendar, from the server.
 *
 * Two shapes, chosen by what the form has available:
 *
 *  - Without `start_date` it returns the programme's rules: which day the week
 *    starts on, which day a block therefore *ends* on, and the default length.
 *    A form needs these to label its own fields before a date is chosen.
 *  - With `start_date` it returns the derived window, so the end date on screen
 *    is the one the server will store. The API runs the identical arithmetic on
 *    write, so this is a preview rather than a client reimplementation of it.
 *
 * The client mirrors the same rules in `utils/dateCalc.ts` so the form stays
 * responsive offline; this endpoint is what keeps the two from drifting.
 */
export async function fetchBlockCalendar(programId: number): Promise<BlockCalendar> {
  const response = await request<ApiResponse<BlockCalendar>>(
    `/rotations/blocks/dates${queryString({ program_id: programId })}`,
  );
  return response.data;
}

export async function fetchBlockDates(input: {
  program_id: number;
  start_date: CalendarDateString;
  duration_weeks?: number;
  end_date?: CalendarDateString;
}): Promise<BlockCalendarWindow> {
  const response = await request<ApiResponse<BlockCalendarWindow>>(
    `/rotations/blocks/dates${queryString({ ...input })}`,
  );
  return response.data;
}

/**
 * `POST /rotations/blocks` — creates one academic block.
 *
 * The API rejects a duplicate `block_number` for the same `academic_year` with
 * a 409, and a window that does not end the day before it starts with a 400. Both
 * messages are surfaced by the client as `ApiError`, so the form can show them
 * verbatim rather than inventing its own wording.
 *
 * Send `duration_weeks` *or* `end_date`, not both: the server derives the window
 * from the programme's week-start day and rejects a contradictory pair.
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
