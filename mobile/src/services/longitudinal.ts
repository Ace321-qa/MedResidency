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

export async function fetchClinicTypes(programId: number): Promise<LongitudinalClinicType[]> {
  const path = `/longitudinal/clinic-types${queryString({ program_id: programId })}`;
  const response = await request<ApiListResponse<LongitudinalClinicType>>(path);
  return response.data ?? [];
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
