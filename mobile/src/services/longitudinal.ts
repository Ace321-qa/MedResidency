import { queryString, request } from './client';
import type {
  ApiListResponse,
  ApiResponse,
  LongitudinalClinicType,
  LongitudinalAssignment,
  FacultySupervisor,
  LongitudinalClinicSlot,
  LongitudinalSupervisorAssignment,
} from '../types/api';

export async function fetchClinicTypes(
  programId: number,
  options: { includeInactive?: boolean } = {},
): Promise<LongitudinalClinicType[]> {
  const params: Record<string, string | number> = { program_id: programId };
  if (options.includeInactive) params.include_inactive = '1';
  const path = `/longitudinal/clinic-types${queryString(params)}`;
  const response = await request<ApiListResponse<LongitudinalClinicType>>(path);
  return response.data ?? [];
}

/**
 * Add a clinic to the programme's Primary Care Clinics catalog.
 *
 * The name is the identity; an existing clinic — active or not — is reactivated
 * server-side, so this is also how a clinic brought back from the catalog returns
 * with its original row, code and teaching history. A brand-new name is
 * catalogued against the programme and persists for every coordinator.
 */
export async function createClinicType(payload: {
  program_id: number;
  clinic_name: string;
  clinic_code?: string;
  default_day_of_week?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  requires_release_letter?: number;
}): Promise<LongitudinalClinicType> {
  const response = await request<ApiResponse<LongitudinalClinicType>>('/longitudinal/clinic-types', {
    method: 'POST',
    data: payload,
  });
  return response.data;
}

/**
 * `PUT /longitudinal/clinic-types/:id` — rename (or otherwise edit) a clinic.
 *
 * The id and code never change, so slots, supervisor pairings and assignment
 * history that reference the clinic keep resolving; only the label updates. The
 * chip pool, filter labels and header subtitle all derive from this row, so
 * patching it back into local state updates them without a refresh.
 */
export async function updateClinicType(
  id: number,
  payload: {
    program_id: number;
    clinic_name?: string;
    default_day_of_week?: string | null;
    start_time?: string | null;
    end_time?: string | null;
    requires_release_letter?: number;
  },
): Promise<LongitudinalClinicType> {
  const response = await request<ApiResponse<LongitudinalClinicType>>(`/longitudinal/clinic-types/${id}`, {
    method: 'PUT',
    data: payload,
  });
  return response.data;
}

/**
 * `DELETE /longitudinal/clinic-types/:id` — soft-delete a clinic.
 *
 * The server flips `is_active` to 0 instead of removing the row, so historical
 * schedule records and resident assignments stay intact and resolvable. The
 * chip is gone from the active selection pool until the clinic is re-added.
 */
export async function deleteClinicType(id: number, programId: number): Promise<void> {
  const path = `/longitudinal/clinic-types/${id}${queryString({ program_id: programId })}`;
  await request<ApiResponse<unknown>>(path, { method: 'DELETE' });
}

/**
 * Longitudinal assignments for a programme.
 *
 * `academicYear` is optional and *filters by overlap*, not by an equality on a
 * column: `resident_longitudinal_assignments` has no `academic_year`, so the
 * server resolves the year to the programme's block window and keeps assignments
 * that cover it. Omit it for a resident's own record, which spans years.
 */
export async function fetchAllLongitudinalAssignments(
  programId: number,
  academicYear?: string | null,
): Promise<LongitudinalAssignment[]> {
  const params: Record<string, string | number> = { program_id: programId };
  if (academicYear) params.academic_year = academicYear;
  const path = `/longitudinal/assignments${queryString(params)}`;
  const response = await request<ApiListResponse<LongitudinalAssignment>>(path);
  return response.data ?? [];
}

export async function fetchResidentLongitudinalAssignments(residentId: number): Promise<LongitudinalAssignment[]> {
  const response = await request<ApiListResponse<LongitudinalAssignment>>(`/longitudinal/assignments/resident/${residentId}`);
  return response.data ?? [];
}

/**
 * Faculty who can supervise a longitudinal clinic.
 *
 * `includeInactive` is a *server* filter and defaults to off, which is right for
 * a picker that should only offer people currently employed. A screen that wants
 * to show departed faculty — to let a coordinator find the supervisor on a
 * posting that already ran — has to ask for them explicitly, or the client's
 * "show inactive" control is decorative.
 */
export async function fetchFacultySupervisors(
  programId: number,
  options: { includeInactive?: boolean; clinicTypeId?: number } = {},
): Promise<FacultySupervisor[]> {
  const params: Record<string, string | number> = { program_id: programId };
  if (options.includeInactive) params.include_inactive = '1';
  if (options.clinicTypeId) params.clinic_type_id = options.clinicTypeId;

  const path = `/longitudinal/faculty-supervisors${queryString(params)}`;
  const response = await request<ApiListResponse<FacultySupervisor>>(path);
  return response.data ?? [];
}

export async function fetchClinicSlots(clinicTypeId: number): Promise<LongitudinalClinicSlot[]> {
  const path = `/longitudinal/clinic-slots${queryString({ clinic_type_id: clinicTypeId })}`;
  const response = await request<ApiListResponse<LongitudinalClinicSlot>>(path);
  return response.data ?? [];
}

export async function fetchSupervisorAssignments(programId: number, clinicTypeId?: number): Promise<LongitudinalSupervisorAssignment[]> {
  const params: any = { program_id: programId };
  if (clinicTypeId) params.clinic_type_id = clinicTypeId;
  const path = `/longitudinal/supervisor-assignments${queryString(params)}`;
  const response = await request<ApiListResponse<LongitudinalSupervisorAssignment>>(path);
  return response.data ?? [];
}

export async function createSupervisorAssignment(payload: any): Promise<LongitudinalSupervisorAssignment> {
  const response = await request<ApiResponse<LongitudinalSupervisorAssignment>>('/longitudinal/supervisor-assignments', {
    method: 'POST',
    data: payload,
  });
  return response.data;
}

export async function rotateSupervisor(assignmentId: number, payload: any): Promise<void> {
  await request<ApiResponse<any>>(`/longitudinal/supervisor-assignments/${assignmentId}/rotate`, {
    method: 'PATCH',
    data: payload,
  });
}
