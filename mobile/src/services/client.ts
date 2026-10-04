import axios, { AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios';

import { API_BASE_URL, API_HOST_LABEL, REQUEST_TIMEOUT_MS } from '../config/env';
import type { ApiErrorBody } from '../types/api';

/**
 * The one place HTTP happens.
 *
 * Why a single client instead of `fetch` inside each screen:
 *  - the base address and timeout are set once,
 *  - every failure is translated into an `ApiError` carrying a *title* and a
 *    *message a resident can act on, so no screen ever has to guess what to
 *    show for a network failure,
 *  - screens receive typed payloads and never touch Axios.
 */

/** What kind of failure occurred, which decides the wording shown to the user. */
export type ApiErrorKind = 'offline' | 'timeout' | 'notFound' | 'rejected' | 'server' | 'unknown';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** HTTP status, or null when the request never reached the server. */
  readonly status: number | null;
  /** Short headline, e.g. "Cannot reach the server". */
  readonly title: string;
  /** One or two sentences telling the user what to do next. */
  readonly detail: string;
  /** Whether offering a "Try again" button makes sense. */
  readonly retryable: boolean;

  constructor(init: {
    kind: ApiErrorKind;
    status?: number | null;
    title: string;
    detail: string;
    retryable: boolean;
  }) {
    super(init.detail);
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status ?? null;
    this.title = init.title;
    this.detail = init.detail;
    this.retryable = init.retryable;
  }
}

export const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

/** True when the app is running on a simulator/web against a machine-local API. */
export const IS_LOCAL_DEVELOPMENT = /localhost|127\.0\.0\.1|10\.0\.2\.2/.test(API_BASE_URL);

/** Pull the backend's own error text out of a rejection body. */
function messageFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const candidate = body as ApiErrorBody;
  const text = candidate.error ?? candidate.message ?? candidate.details;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  // Express serves an HTML page for unrouted paths; never show markup to a user.
  if (!trimmed || trimmed.startsWith('<')) return null;
  return trimmed;
}

/**
 * Convert any rejection into an `ApiError` with user-facing wording.
 *
 * Every screen calls this, so failure copy stays consistent across the app.
 */
export function toApiError(rejection: unknown): ApiError {
  if (rejection instanceof ApiError) return rejection;

  if (axios.isAxiosError(rejection)) {
    const error = rejection as AxiosError<ApiErrorBody>;

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return new ApiError({
        kind: 'timeout',
        title: 'The server took too long',
        detail: `MedResidency did not receive a response from ${API_HOST_LABEL} within 15 seconds. The server may be busy — try again in a moment.`,
        retryable: true,
      });
    }

    if (!error.response) {
      return new ApiError({
        kind: 'offline',
        title: 'Cannot reach the server',
        detail: `MedResidency could not connect to ${API_HOST_LABEL}. Check that the API is running and that this device is on the same network, then try again.`,
        retryable: true,
      });
    }

    const status = error.response.status;
    const serverMessage = messageFromBody(error.response.data);

    if (status === 404) {
      return new ApiError({
        kind: 'notFound',
        status,
        title: 'Record not found',
        detail: serverMessage ?? 'The record you asked for no longer exists. Pull down to refresh the list.',
        retryable: true,
      });
    }

    if (status >= 500) {
      return new ApiError({
        kind: 'server',
        status,
        title: 'Server error',
        detail: serverMessage ?? 'MedResidency’s server reported a problem while handling this request. Try again shortly.',
        retryable: true,
      });
    }

    return new ApiError({
      kind: 'rejected',
      status,
      title: 'Request rejected',
      detail: serverMessage ?? 'The server refused this request. Review the details and try again.',
      retryable: false,
    });
  }

  if (rejection instanceof Error) {
    return new ApiError({
      kind: 'unknown',
      title: 'Something went wrong',
      detail: rejection.message || 'An unexpected error occurred while loading this screen.',
      retryable: true,
    });
  }

  return new ApiError({
    kind: 'unknown',
    title: 'Something went wrong',
    detail: 'An unexpected error occurred while loading this screen.',
    retryable: true,
  });
}

type RequestOptions = Omit<AxiosRequestConfig, 'baseURL' | 'url'>;

/**
 * Perform a request and return the parsed JSON body.
 *
 * Screens and services use this instead of touching the Axios instance, so the
 * error handling stays in one file.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  try {
    const response = await apiClient.request<T>({
      url: path,
      method: options.method ?? 'get',
      ...options,
    });
    return response.data;
  } catch (rejection) {
    throw toApiError(rejection);
  }
}

/** Build a query string from defined values only, so URLs stay predictable. */
export function queryString(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}