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

export async function fetchAllLongitudinalAssignments(programId: number): Promise<LongitudinalAssignment[]> {
  const path = `/longitudinal/assignments${queryString({ program_id: programId })}`;
  const response = await request<ApiListResponse<LongitudinalAssignment>>(path);
  return response.data ?? [];
}

export async function fetchResidentLongitudinalAssignments(residentId: number): Promise<LongitudinalAssignment[]> {
  const response = await request<ApiListResponse<LongitudinalAssignment>>(`/longitudinal/assignments/resident/${residentId}`);
  return response.data ?? [];
}

export async function fetchFacultySupervisors(programId: number): Promise<FacultySupervisor[]> {
  const path = `/longitudinal/faculty-supervisors${queryString({ program_id: programId })}`;
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
