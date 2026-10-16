import { queryString, request } from './client';
import type {
  ApiResponse,
  Notification,
  NotificationPage,
  NotificationReadAllResult,
  NotificationType,
  NotificationUnreadCount,
} from '../types/api';

/**
 * Persisted notifications.
 *
 * Rows are written by the backend when a system event happens (a duty-hour
 * breach, a leave decision, a rotation assignment) and read back here. Endpoints
 * are resident-scoped because the app's identity today is the chosen resident;
 * the server resolves that to its internal user.
 *
 * There is no websocket or push channel. Screens poll these endpoints on a
 * short interval so a decision made elsewhere shows up without a manual pull.
 */

export interface NotificationQuery {
  type?: NotificationType;
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}

/** `GET /notifications/resident/:resident_id`. */
export async function fetchNotifications(
  residentId: number,
  query: NotificationQuery = {},
): Promise<Notification[]> {
  const response = await request<NotificationPage>(
    `/notifications/resident/${residentId}${queryString({
      type: query.type,
      unread: query.unreadOnly ? '1' : undefined,
      limit: query.limit,
      offset: query.offset,
    })}`,
  );
  return response.data ?? [];
}

/** `GET /notifications/resident/:resident_id/unread-count` — the bell badge. */
export async function fetchUnreadNotificationCount(residentId: number): Promise<number> {
  const response = await request<NotificationUnreadCount>(
    `/notifications/resident/${residentId}/unread-count`,
  );
  return response.unread ?? 0;
}

/** `PATCH /notifications/:id/read` — post a read receipt for one row. */
export async function markNotificationRead(
  notificationId: number,
  residentId: number,
): Promise<Notification> {
  const response = await request<ApiResponse<Notification>>(`/notifications/${notificationId}/read`, {
    method: 'PATCH',
    data: { resident_id: residentId },
  });
  return response.data;
}

/** `PATCH /notifications/resident/:resident_id/read-all`. Returns how many changed. */
export async function markAllNotificationsRead(residentId: number): Promise<number> {
  const response = await request<NotificationReadAllResult>(
    `/notifications/resident/${residentId}/read-all`,
    { method: 'PATCH' },
  );
  return response.changed ?? 0;
}
