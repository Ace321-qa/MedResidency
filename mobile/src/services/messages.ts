import { queryString, request } from './client';
import type {
  ApiResponse,
  CreateResidentMessagePayload,
  ResidentMessage,
  ResidentMessageBoxes,
  ResidentMessageCategory,
} from '../types/api';

/**
 * Resident messages — the resident's own mailbox.
 *
 * Everything here maps to a row in `resident_messages`. The three folders are
 * returned together by one endpoint because the screen shows a count for each
 * of them in the same header: asking three times would mean the counts could
 * disagree with the list below them.
 */

/**
 * `GET /messages?resident_id=N` — the inbox, the drafts and the sent items.
 *
 * A folder that cannot be read is an empty list rather than an error: a
 * resident whose messages table is not yet migrated should still be able to
 * read the letters issued to them.
 */
export async function fetchResidentMessages(residentId: number): Promise<ResidentMessageBoxes> {
  const path = `/messages${queryString({ resident_id: residentId })}`;
  const response = await request<ApiResponse<ResidentMessageBoxes>>(path);
  const boxes = response?.data;
  return {
    inbox: boxes?.inbox ?? [],
    drafts: boxes?.drafts ?? [],
    sent: boxes?.sent ?? [],
  };
}

/**
 * `POST /messages` — save a draft, or send to the programme office.
 *
 * The folder decides which: a draft stays with the resident, a sent message is
 * the programme office's to read.
 */
export async function createResidentMessage(
  payload: CreateResidentMessagePayload,
): Promise<ResidentMessage> {
  const response = await request<ApiResponse<{ message: ResidentMessage }>>('/messages', {
    method: 'POST',
    data: payload,
  });
  return response?.data?.message;
}

/**
 * `PATCH /messages/:id` — edit a draft, send it, or mark an inbox message read.
 *
 * `resident_id` is part of the body rather than inferred: the message id alone
 * is not authority to read or rewrite somebody else's mail, and the server
 * checks the two against each other.
 */
export async function updateResidentMessage(
  id: number,
  payload: {
    resident_id: number;
    subject?: string;
    body?: string;
    category?: ResidentMessageCategory;
    recipient_department?: string | null;
    folder?: 'DRAFT' | 'SENT';
    is_read?: boolean;
  },
): Promise<ResidentMessage> {
  const response = await request<ApiResponse<{ message: ResidentMessage }>>(`/messages/${id}`, {
    method: 'PATCH',
    data: payload,
  });
  return response?.data?.message;
}

/** `DELETE /messages/:id` — remove a draft. A sent message cannot be removed. */
export async function deleteResidentMessage(id: number, residentId: number): Promise<void> {
  await request<ApiResponse<{ id: number }>>(
    `/messages/${id}${queryString({ resident_id: residentId })}`,
    { method: 'DELETE' },
  );
}

/**
 * `GET /messages/program/:program_id` — the programme office's queue of the
 * issues residents have raised against it.
 *
 * The other side of the same rows a resident sees in their Sent box, so a
 * coordinator reads exactly what the resident wrote.
 */
export async function fetchProgramIssues(programId: number): Promise<ResidentMessage[]> {
  const response = await request<ApiResponse<ResidentMessage[]>>(`/messages/program/${programId}`);
  return response?.data ?? [];
}
