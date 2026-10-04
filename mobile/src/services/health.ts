import { request } from './client';
import type { HealthStatus } from '../types/api';

/**
 * Health probe.
 *
 * Used by Settings to show the API address and confirm the database connection,
 * and by the app's error states to distinguish "the server is down" from "this
 * record is missing".
 */
export async function fetchHealth(): Promise<HealthStatus> {
  return request<HealthStatus>('/health');
}