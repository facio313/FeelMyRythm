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
  fillStyle: '',
  font: '',
  setTransform: vi.fn(),
  stroke: vi.fn(),
};

describe('BeatVisualizer announcements', () => {
  let nextFrame: FrameRequestCallback | null;
  let boundsWidth: number;
  let boundsHeight: number;
  let reducedMotion: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    context.fillStyle = '';
    nextFrame = null;
    boundsWidth = 640;
    boundsHeight = 180;
    reducedMotion = false;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      bottom: boundsHeight,
      height: boundsHeight,
      left: 0,
      right: boundsWidth,
      top: 0,
      width: boundsWidth,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));
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
        matches: reducedMotion,
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

  it('redraws an idle frame when its responsive canvas changes size', async () => {
    const frame: BeatFrame = {
      accent: 2,
      beatCount: 4,
      beatIndex: 0,
      measureNumber: 1,
      progress: 0,
    };
    const { container } = render(<BeatVisualizer frameSource={() => frame} running={false} />);
    const firstSecondBeatX = Number(context.arc.mock.calls[1]?.[0]);

    context.arc.mockClear();
    boundsWidth = 280;
    boundsHeight = 96;
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(context.arc).toHaveBeenCalledTimes(4);
    expect(Number(context.arc.mock.calls[1]?.[0])).not.toBe(firstSecondBeatX);
    const canvas = container.querySelector('canvas');
    expect(canvas?.width).toBe(Math.round(280 * (window.devicePixelRatio || 1)));
    expect(canvas?.height).toBe(Math.round(96 * (window.devicePixelRatio || 1)));
  });

  it('scales circles and the progress track for a tall performance surface', () => {
    boundsWidth = 1_000;
    boundsHeight = 500;
    render(
      <BeatVisualizer
        frameSource={() => ({
          accent: 2,
          beatCount: 4,
          beatIndex: 0,
          measureNumber: 1,
          progress: 0.5,
        })}
        running={false}
      />,
    );

    expect(Number(context.arc.mock.calls[0]?.[2])).toBe(82);
    expect(Number(context.arc.mock.calls[1]?.[2])).toBe(72);
    expect(Number(context.fillRect.mock.calls[0]?.[3])).toBe(14);
    expect(context.fillText.mock.calls.map(([label]) => String(label))).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  it('keeps numbered beats legible on a compact phone surface', () => {
    boundsWidth = 390;
    boundsHeight = 127;
    render(
      <BeatVisualizer
        frameSource={() => ({
          accent: 1,
          beatCount: 4,
          beatIndex: 1,
          measureNumber: 1,
          progress: 0.25,
        })}
        running={false}
      />,
    );

    expect(Number(context.arc.mock.calls[2]?.[2])).toBeGreaterThan(28);
    expect(context.fillText).toHaveBeenCalledTimes(4);
    expect(context.fillText.mock.calls.map(([label]) => String(label))).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  it('keeps approximately 40px numbered beats clear of the track in a compact status surface', () => {
    boundsWidth = 390;
    boundsHeight = 64;
    render(
      <BeatVisualizer
        frameSource={() => ({
          accent: 1,
          beatCount: 4,
          beatIndex: 1,
          measureNumber: 1,
          progress: 0.25,
        })}
        running={false}
      />,
    );

    const inactiveRadius = Number(context.arc.mock.calls[0]?.[2]);
    const currentY = Number(context.arc.mock.calls[1]?.[1]);
    const currentRadius = Number(context.arc.mock.calls[1]?.[2]);
    const trackY = Number(context.fillRect.mock.calls[0]?.[1]);
    expect(inactiveRadius * 2).toBeGreaterThanOrEqual(38);
    expect(currentRadius * 2).toBeGreaterThanOrEqual(42);
    expect(currentY - currentRadius).toBeGreaterThanOrEqual(0);
    expect(trackY).toBeGreaterThanOrEqual(currentY + currentRadius);
    expect(context.fillText.mock.calls.map(([label]) => String(label))).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  it('keeps the count-in numeral inside a 64px recovery canvas', () => {
    boundsWidth = 390;
    boundsHeight = 64;
    render(
      <BeatVisualizer
        frameSource={() => ({
          accent: 2,
          beatCount: 4,
          beatIndex: 0,
          countInValue: 4,
          isCountIn: true,
          progress: 0,
        })}
        running={false}
      />,
    );

    const fontSize = Number.parseFloat(context.font.match(/([\d.]+)px/)?.[1] ?? '0');
    expect(fontSize).toBeGreaterThanOrEqual(24);
    expect(fontSize).toBeLessThanOrEqual(boundsHeight * 0.8);
    expect(context.fillText.mock.calls.at(-1)?.[0]).toBe('4');
  });

  it.each([
    { width: 256, count: 12, beatIndex: 11 },
    { width: 390, count: 16, beatIndex: 15 },
    { width: 256, count: 32, beatIndex: 31 },
  ])('windows $count beats inside a $width px canvas', ({ width, count, beatIndex }) => {
    boundsWidth = width;
    boundsHeight = 96;
    const { unmount } = render(
      <BeatVisualizer
        frameSource={() => ({
          accent: 1,
          beatCount: count,
          beatIndex,
          measureNumber: 1,
          progress: 0.75,
        })}
        running={false}
      />,
    );

    const circles = context.arc.mock.calls.map(([x, , radius]) => ({
      left: Number(x) - Number(radius),
      right: Number(x) + Number(radius),
    }));
    expect(circles.length).toBeGreaterThan(0);
    expect(circles.length).toBeLessThan(count);
    for (const circle of circles) {
      expect(circle.left).toBeGreaterThanOrEqual(0);
      expect(circle.right).toBeLessThanOrEqual(width);
    }
    const labels = context.fillText.mock.calls.map(([label]) => String(label));
    expect(labels).toContain(String(beatIndex + 1));
    expect(labels).toContain('…');
    unmount();
  });

  it.each([
    { beatIndex: -4, expectedLabel: '1' },
    { beatIndex: 99, expectedLabel: '32' },
  ])(
    'clamps an out-of-range beat index $beatIndex before choosing its visible window',
    ({ beatIndex, expectedLabel }) => {
      boundsWidth = 256;
      boundsHeight = 96;
      render(
        <BeatVisualizer
          frameSource={() => ({
            accent: 1,
            beatCount: 32,
            beatIndex,
            measureNumber: 1,
            progress: 0.75,
          })}
          running={false}
        />,
      );

      expect(context.arc.mock.calls.length).toBeGreaterThan(0);
      expect(context.fillText.mock.calls.map(([label]) => String(label))).toContain(expectedLabel);
    },
  );

  it('keeps a visible progress track while suppressing its moving fill for reduced motion', () => {
    reducedMotion = true;
    render(
      <BeatVisualizer
        frameSource={() => ({
          accent: 1,
          beatCount: 4,
          beatIndex: 1,
          measureNumber: 1,
          progress: 0.5,
        })}
        running={false}
      />,
    );

    expect(context.fillRect).toHaveBeenCalledTimes(1);
    expect(Number(context.fillRect.mock.calls[0]?.[2])).toBeGreaterThan(0);
    expect(context.fillStyle).toBe('#626a78');
  });
});
