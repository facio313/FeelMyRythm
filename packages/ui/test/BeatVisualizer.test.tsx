import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeatVisualizer, type BeatFrame } from '../src/BeatVisualizer';

const context = {
  arc: vi.fn(),
  beginPath: vi.fn(),
  clearRect: vi.fn(),
  fill: vi.fn(),
  fillRect: vi.fn(),
  fillText: vi.fn(),
  setTransform: vi.fn(),
  stroke: vi.fn(),
};

describe('BeatVisualizer announcements', () => {
  let nextFrame: FrameRequestCallback | null;

  beforeEach(() => {
    nextFrame = null;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 180,
      height: 180,
      left: 0,
      right: 640,
      top: 0,
      width: 640,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        nextFrame = callback;
        return 1;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: false,
        media: '',
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function advance() {
    const callback = nextFrame;
    expect(callback).not.toBeNull();
    nextFrame = null;
    act(() => callback?.(performance.now()));
  }

  it('announces measure starts but stays silent on ordinary beats and subdivisions', () => {
    let frame: BeatFrame = {
      accent: 2,
      beatCount: 4,
      beatIndex: 0,
      measureNumber: 1,
      progress: 0,
    };
    render(<BeatVisualizer frameSource={() => frame} running />);

    expect(screen.getByText('1마디 시작').closest('[aria-live]')).toHaveAttribute(
      'aria-live',
      'polite',
    );

    frame = { ...frame, accent: 0, beatIndex: 1, progress: 0.2 };
    advance();
    expect(screen.queryByText('1마디 2박')).not.toBeInTheDocument();
    expect(screen.getByText('1마디 시작')).toBeInTheDocument();

    frame = { ...frame, beatIndex: 0, isSubdivision: true, progress: 0.5 };
    advance();
    expect(screen.getByText('1마디 시작')).toBeInTheDocument();

    frame = {
      accent: 2,
      beatCount: 4,
      beatIndex: 0,
      measureNumber: 2,
      progress: 0,
    };
    advance();
    expect(screen.getByText('2마디 시작')).toBeInTheDocument();
    expect(screen.queryByText('1마디 시작')).not.toBeInTheDocument();
    const firstSecondMeasureAnnouncement = screen.getByText('2마디 시작');

    frame = { ...frame, beatIndex: 1, progress: 0.4 };
    advance();
    frame = { ...frame, beatIndex: 0, progress: 0 };
    advance();
    expect(screen.getByText('2마디 시작')).not.toBe(firstSecondMeasureAnnouncement);
  });

  it('announces changed count-in values without repeating the same value', () => {
    let frame: BeatFrame = {
      accent: 1,
      beatCount: 4,
      beatIndex: 0,
      countInValue: 4,
      isCountIn: true,
      progress: 0,
    };
    render(<BeatVisualizer frameSource={() => frame} running />);

    expect(screen.getByText('예비박 4')).toBeInTheDocument();
    frame = { ...frame, beatIndex: 1, progress: 0.3 };
    advance();
    expect(screen.getByText('예비박 4')).toBeInTheDocument();

    frame = { ...frame, countInValue: 3, progress: 0 };
    advance();
    expect(screen.getByText('예비박 3')).toBeInTheDocument();
  });

  it('does not announce an idle frame and resets the boundary for the next run', () => {
    const frame: BeatFrame = {
      accent: 2,
      beatCount: 4,
      beatIndex: 0,
      measureNumber: 1,
      progress: 0,
    };
    const { rerender } = render(<BeatVisualizer frameSource={() => frame} running={false} />);
    expect(screen.queryByText('1마디 시작')).not.toBeInTheDocument();

    rerender(<BeatVisualizer frameSource={() => frame} running />);
    expect(screen.getByText('1마디 시작')).toBeInTheDocument();
  });
});
