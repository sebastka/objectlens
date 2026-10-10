import { useEffect, useState } from 'react';

/**
 * Loads data whenever deps change. The previous value is kept while reloading, so lists can dim
 * instead of flashing empty; `loading` is derived rather than set inside the effect.
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
): { data: T | null; loading: boolean; error: Error | null } {
  const key = JSON.stringify(deps);
  const [state, setState] = useState<{ key: string | null; data: T | null; error: Error | null }>({
    key: null,
    data: null,
    error: null,
  });
  useEffect(() => {
    let cancelled = false;
    fn().then(
      (data) => !cancelled && setState({ key, data, error: null }),
      (e: Error) => !cancelled && setState((s) => ({ ...s, key, error: e })),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { data: state.data, loading: state.key !== key, error: state.key === key ? state.error : null };
}
