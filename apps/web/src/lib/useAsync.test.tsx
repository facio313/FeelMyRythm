import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAsync } from './useAsync';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('useAsync request ownership', () => {
  it('does not expose data from the previous dependency while the next request loads or fails', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const { result, rerender } = renderHook(
      ({ resource }) =>
        useAsync(() => (resource === 'first' ? first.promise : second.promise), [resource]),
      { initialProps: { resource: 'first' } },
    );

    await act(async () => first.resolve('first data'));
    await waitFor(() => expect(result.current.data).toBe('first data'));

    rerender({ resource: 'second' });
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    await act(async () => second.reject(new Error('second failed')));
    await waitFor(() => expect(result.current.error?.message).toBe('second failed'));
    expect(result.current.data).toBeNull();
  });
});
