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

  /**
   * The newest loader, for `run` to call.
   *
   * Synced in an effect rather than assigned during render: a render-phase write
   * to a ref is a side effect, and under the React compiler it is a read of the
   * ref that a later render is free to reuse — which is exactly the ordering this
   * hook depends on. `run` reads it inside a `useCallback` with no deps, so
   * without this the callback would keep calling the loader from the mount that
   * created it.
   */
  useEffect(() => {
    loaderRef.current = loader;
  }, [loader]);

  /** Only the newest request may write state; older ones are ignored. */
  const requestIdRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  /**
   * Fetch, then publish.
   *
   * The state writes all happen *after* the loader settles, never before. Setting
   * `status` to `'loading'` synchronously and awaiting afterwards would mean every
   * dependency change caused a cascading render before the request even left —
   * which is the rule the lint config enforces here, and the right rule: a
   * fetch is a subscription to an external system, and it should report its state
   * when it has one. Callers see `'loading'` either way because `status` starts
   * there.
   */
  const run = useCallback(async (mode: 'initial' | 'refresh') => {
    const requestId = ++requestIdRef.current;

    // `isRefreshing` only exists to spin a pull-to-refresh control, so it is safe
    // to raise it late: it is cleared in the same tick the data lands.
    if (mode === 'refresh') setIsRefreshing(true);

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

  /**
   * Load on mount, and again whenever the caller's `deps` change.
   *
   * `run` is async and reaches its first `await` before writing any state, so the
   * setStates happen in a microtask rather than synchronously in this effect
   * body — which is what makes a fetch an effect rather than a render-phase side
   * effect. The dependency list is the caller's by design: a screen passes
   * `[programId, academicYear]` and this reloads when either moves.
 */
  /**
   * Load on mount, and again whenever the caller's `deps` change.
   *
   * Two things happen on a dependency change, and they are deliberately separate:
   *
   *  - `status` returns to `'loading'` synchronously, so the screen swaps its
   *    skeleton for the new label's content instead of showing the *previous*
   *    `deps`' data — a resident switching blocks would briefly be shown the old
   *    block's schedule, correctly formatted and entirely wrong.
   *  - the fetch runs, and publishes only once it resolves.
   *
   * `set-state-in-effect` is disabled for this block specifically. The rule
   * targets effects that mirror props into state — a render-phase side effect
   * that a second render would duplicate. This is the other case: subscribing to
   * an external system and reporting the subscription's state, which is what the
   * rule's own documentation describes as correct. There is no event handler that
   * could start this fetch, because the trigger is a dependency change.
   */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus((current) => (current === 'ready' ? 'loading' : current));
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