import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/**
 * Load something from the API, with the three states every screen needs.
 *
 * Deliberately small — no cache, no deduplication, no stale-while-revalidate.
 * A library like React Query earns its weight once several screens share data
 * and need it kept in step; here each screen reads one endpoint and the user
 * pulls to refresh. Adding the dependency now would be more machinery than the
 * problem has.
 *
 * `path` doubles as the identity of the request: passing a new path refetches.
 * Pass `null` to hold off entirely, which is how screens wait for a parameter
 * they do not have yet (the active portfolio, usually).
 */
export interface Fetched<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** True while a pull-to-refresh is in flight, as opposed to a first load. */
  refreshing: boolean;
  reload: () => void;
}

export function useFetch<T>(path: string | null): Fetched<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [refreshing, setRefreshing] = useState(false);

  // Guards against a slow response from a previous path overwriting a newer
  // one — the classic out-of-order fetch bug, which on a list screen shows the
  // wrong symbol's data under the right symbol's heading.
  const requestId = useRef(0);

  const run = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (path === null) {
        setData(null);
        setLoading(false);
        return;
      }

      const id = ++requestId.current;
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);

      try {
        const result = await api<T>(path);
        if (id !== requestId.current) return;
        setData(result);
        setError(null);
      } catch (caught) {
        if (id !== requestId.current) return;
        setError(caught instanceof Error ? caught.message : 'Something went wrong');
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [path],
  );

  useEffect(() => {
    void run('initial');
  }, [run]);

  const reload = useCallback(() => void run('refresh'), [run]);

  return { data, error, loading, refreshing, reload };
}
