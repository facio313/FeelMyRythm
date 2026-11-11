import { StrictMode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ScoreImage } from './ScoreImage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('revokes every created URL across StrictMode, blob replacement and unmount', () => {
  const created: string[] = [];
  const revoked: string[] = [];
  class TestURL extends URL {
    static override createObjectURL() {
      const url = `blob:score-${created.length}`;
      created.push(url);
      return url;
    }
    static override revokeObjectURL(url: string) {
      revoked.push(url);
    }
  }
  vi.stubGlobal('URL', TestURL);
  const first = new Blob(['first']);
  const view = render(<ScoreImage blob={first} name="score" />, { wrapper: StrictMode });
  expect(screen.getByRole('img')).toHaveAttribute('src', created.at(-1));
  const count = created.length;
  view.rerender(<ScoreImage blob={first} name="renamed" />);
  expect(created).toHaveLength(count);
  expect(screen.getByRole('img')).toHaveAccessibleName('renamed');
  view.rerender(<ScoreImage blob={new Blob(['second'])} name="second" />);
  expect(screen.getByRole('img')).toHaveAttribute('src', created.at(-1));
  view.unmount();
  expect(revoked.sort()).toEqual(created.sort());
});
