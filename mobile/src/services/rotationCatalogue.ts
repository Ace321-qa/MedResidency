import { queryString, request } from './client';
import type {
  ApiListResponse,
  ApiResponse,
  CatalogueRotationPayload,
  RotationCatalogueEntry,
} from '../types/api';

/**
 * The Rotations Catalogue: create, rename and delete the rotations a programme
 * can assign.
 *
 * This is the writable half of the rotation data. `services/rotations.ts` reads
 * the same rows for the master grid and the assignment forms; this module is
 * the coordinator's editing surface, where a rotation is defined once and then
 * appears everywhere else.
 *
 * Every failure arrives as an `ApiError` carrying the server's own wording —
 * "Abbreviation \"PHC\" is already used…" or "…2 resident assignments rely on
 * it" — because those sentences are the only part of a rejection a coordinator
 * can act on.
 */

export type CatalogueRotationUpdate = Partial<
  Pick<CatalogueRotationPayload, 'full_name' | 'department' | 'abbreviation'>
>;

/** `GET /rotations/catalogue?program_id=X` — every rotation in the programme. */
export async function fetchRotationCatalogue(programId: number): Promise<RotationCatalogueEntry[]> {
  const path = `/rotations/catalogue${queryString({ program_id: programId })}`;
  const response = await request<ApiListResponse<RotationCatalogueEntry>>(path);
  return response.data ?? [];
}

/** `POST /rotations/catalogue` — add one rotation by hand. */
export async function createCatalogueRotation(
  payload: CatalogueRotationPayload,
): Promise<RotationCatalogueEntry> {
  const response = await request<ApiResponse<RotationCatalogueEntry>>('/rotations/catalogue', {
    method: 'POST',
    data: payload,
  });
  return response.data;
}

/**
 * `PUT /rotations/catalogue/:id` — rename or re-department a rotation.
 *
 * Only the fields sent are changed, so a form can rename a rotation without
 * re-sending the rest of the row.
 */
export async function updateCatalogueRotation(
  id: number,
  payload: CatalogueRotationUpdate,
): Promise<RotationCatalogueEntry> {
  const response = await request<ApiResponse<RotationCatalogueEntry>>(
    `/rotations/catalogue/${id}`,
    { method: 'PUT', data: payload },
  );
  return response.data;
}

/**
 * `DELETE /rotations/catalogue/:id`.
 *
 * Rejected with a 400 while any resident assignment points at the rotation;
 * the message lists how many, so the caller can show it verbatim instead of
 * inventing a reason the deletion "failed".
 */
export async function deleteCatalogueRotation(id: number): Promise<void> {
  await request<ApiResponse<unknown>>(`/rotations/catalogue/${id}`, { method: 'DELETE' });
}
