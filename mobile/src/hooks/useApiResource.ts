import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, toApiError } from '../services/client';

/**
 * One hook for "fetch this from the API and show the result".
 *
 * Every data screen needs the same four things — load on mount, expose loading
 * and error states, support pull-to-refresh, allow a mutation to patch the data
 * in place. Writing that by hand is how screens drift apart, so it lives here
 * once.
 *
 * The loader is passed in rather than described with a URL, so screens depend on
 * the service modules and never on HTTP details.
 */

export type ResourceStatus = 'loading' | 'ready' | 'error';

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  status: ResourceStatus;
  /** Full-screen spinner state — true on first load only. */
  isLoading: boolean;
  /** Pull-to-refresh state. */
  isRefreshing: boolean;
  /** Called by pull-to-refresh and by retry buttons. */
  refresh: () => void;
  /** Replace the data locally, e.g. after a successful form submission. */
  setData: (next: T | ((current: T | null) => T | null)) => void;
}

export function useApiResource<T>(loader: () => Promise<T>, deps: readonly unknown[] = []): Resource<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState<ResourceStatus>('loading');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  /** Only the newest request may write state; older ones are ignored. */
  const requestIdRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const run = useCallback(async (mode: 'initial' | 'refresh') => {
    const requestId = ++requestIdRef.current;

    if (mode === 'refresh') setIsRefreshing(true);
    else setStatus('loading');

    try {
      const result = await loaderRef.current();
      if (!isMountedRef.current || requestId !== requestIdRef.current) return;

      setDataState(result);
      setError(null);
      setStatus('ready');
    } catch (rejection) {
      if (!isMountedRef.current || requestId !== requestIdRef.current) return;

      setError(toApiError(rejection));
      setStatus('error');
    } finally {
      if (isMountedRef.current && requestId === requestIdRef.current) {
        setIsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void run('initial');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const refresh = useCallback(() => {
    void run('refresh');
  }, [run]);

  const setData = useCallback((next: T | ((current: T | null) => T | null)) => {
    setDataState((current) =>
      typeof next === 'function' ? (next as (current: T | null) => T | null)(current) : next,
    );
  }, []);

  return {
    data,
    error,
    status,
    isLoading: status === 'loading',
    isRefreshing,
    refresh,
    setData,
  };
}