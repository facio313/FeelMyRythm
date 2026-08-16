import { useCallback, useEffect, useMemo, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

export function useAsync<T>(
  loader: () => Promise<T>,
  dependencies: readonly unknown[],
): AsyncState<T> {
  const [state, setState] = useState<{
    data: T | null;
    error: Error | null;
    requestKey: object | null;
  }>({ data: null, error: null, requestKey: null });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((current) => current + 1), []);
  // The caller owns dependency stability, mirroring useEffect's contract.
  // eslint-disable-next-line react-hooks/use-memo, react-hooks/exhaustive-deps
  const requestKey = useMemo(() => ({}), [...dependencies, revision]);

  useEffect(() => {
    const controller = new AbortController();
    void loader()
      .then((value) => {
        if (!controller.signal.aborted) {
          setState({ data: value, error: null, requestKey });
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            data: null,
            error: reason instanceof Error ? reason : new Error(String(reason)),
            requestKey,
          });
        }
      });
    return () => controller.abort();
    // The caller owns dependency stability.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  return {
    data: state.requestKey === requestKey ? state.data : null,
    error: state.requestKey === requestKey ? state.error : null,
    loading: state.requestKey !== requestKey,
    reload,
  };
}
