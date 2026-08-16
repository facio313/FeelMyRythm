import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type * as FeelMyRythmUi from '@feelmyrythm/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tunerEngine = vi.hoisted(() => ({
  setA4: vi.fn(),
  start: vi.fn<() => Promise<void>>(),
  stop: vi.fn(),
}));

vi.mock('@feelmyrythm/audio', () => ({
  TUNER_A4_PRESETS: [415, 430, 440, 442, 443],
  TunerEngine: class {
    onReading: ((reading: unknown) => void) | null = null;

    setA4 = tunerEngine.setA4;
    start = tunerEngine.start;
    stop = tunerEngine.stop;
  },
}));

vi.mock('@feelmyrythm/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof FeelMyRythmUi>();
  return {
    ...actual,
    useToast: () => ({ notify: vi.fn() }),
  };
});

import { TunerPage } from './TunerPage';

describe('TunerPage accessibility', () => {
  beforeEach(() => {
    tunerEngine.setA4.mockReset();
    tunerEngine.start.mockReset().mockResolvedValue(undefined);
    tunerEngine.stop.mockReset();
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('names the cents meter and describes its idle value', () => {
    render(<TunerPage />);

    expect(screen.getByRole('meter', { name: '튜닝 편차' })).toHaveAttribute(
      'aria-valuetext',
      '음을 기다리는 중',
    );
  });

  it('uses roving focus and arrow/Home/End keys for the A4 radio group', () => {
    render(<TunerPage />);

    const selected = screen.getByRole('radio', { name: '440' });
    const next = screen.getByRole('radio', { name: '442' });
    const first = screen.getByRole('radio', { name: '415' });
    const last = screen.getByRole('radio', { name: '443' });
    expect(selected).toHaveAttribute('tabindex', '0');
    expect(next).toHaveAttribute('tabindex', '-1');

    selected.focus();
    fireEvent.keyDown(selected, { key: 'ArrowRight' });
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute('aria-checked', 'true');
    expect(selected).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(next, { key: 'Home' });
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(first, { key: 'End' });
    expect(last).toHaveFocus();
    expect(last).toHaveAttribute('aria-checked', 'true');
  });

  it('deduplicates a pending permission request and cleans up after a late approval on unmount', async () => {
    let approveMicrophone: (() => void) | undefined;
    tunerEngine.start.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        approveMicrophone = resolve;
      }),
    );
    const { unmount } = render(<TunerPage />);
    const startButton = screen.getByRole('button', { name: '튜닝 시작' });

    fireEvent.click(startButton);
    fireEvent.click(startButton);
    expect(tunerEngine.start).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '마이크 권한 확인 중…' })).toBeDisabled();

    unmount();
    await act(async () => {
      approveMicrophone?.();
      await Promise.resolve();
    });
    expect(tunerEngine.stop).toHaveBeenCalledTimes(2);
  });
});
