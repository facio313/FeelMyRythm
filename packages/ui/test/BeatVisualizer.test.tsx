import { act, cleanup, render, screen } from '@testing-library/react';
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
  globalAlpha: 1,
  measureText: vi.fn<(value: string) => TextMetrics>(),
  setTransform: vi.fn(),
  stroke: vi.fn(),
  textAlign: 'center' as CanvasTextAlign,
  textBaseline: 'middle' as CanvasTextBaseline,
};

function measureText(value: string): TextMetrics {
  const size = Number(context.font.match(/([\d.]+)px/)?.[1]);
  const width =
    Array.from(value).reduce(
      (total, character) => total + (character === '1' ? 0.36 : character === '/' ? 0.3 : 0.6),
      0,
    ) * size;
  const alignOffset = context.textAlign === 'center' ? width / 2 : 0;
  const baselineOffset = context.textBaseline === 'middle' ? size * 0.28 : 0;
  return {
    actualBoundingBoxAscent: size * 0.72 - baselineOffset,
    actualBoundingBoxDescent: size * 0.02 + baselineOffset,
    actualBoundingBoxLeft: alignOffset - size * 0.02,
    actualBoundingBoxRight: width - alignOffset - size * 0.01,
    alphabeticBaseline: baselineOffset,
    emHeightAscent: size * 0.8 - baselineOffset,
    emHeightDescent: size * 0.2 + baselineOffset,
    fontBoundingBoxAscent: size * 0.8 - baselineOffset,
    fontBoundingBoxDescent: size * 0.2 + baselineOffset,
    hangingBaseline: size * 0.6 - baselineOffset,
    ideographicBaseline: -size * 0.2 - baselineOffset,
    width,
  };
}

function captureTextDraws() {
  const draws: {
    label: string;
    x: number;
    fontSize: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
    alpha: number;
    color: string;
  }[] = [];
  context.fillText.mockImplementation((label: string, x: number, y: number) => {
    const metrics = measureText(label);
    draws.push({
      label,
      x,
      fontSize: Number(context.font.match(/([\d.]+)px/)?.[1]),
      left: x - metrics.actualBoundingBoxLeft,
      right: x + metrics.actualBoundingBoxRight,
      top: y - metrics.actualBoundingBoxAscent,
      bottom: y + metrics.actualBoundingBoxDescent,
      alpha: context.globalAlpha,
      color: context.fillStyle,
    });
  });
  return draws;
}

describe('BeatVisualizer announcements', () => {
  let nextFrame: FrameRequestCallback | null;
  let boundsWidth: number;
  let boundsHeight: number;
  let reducedMotion: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    context.fillRect.mockReset();
    context.fillText.mockReset();
    context.measureText.mockImplementation(measureText);
    context.fillStyle = '';
    context.globalAlpha = 1;
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
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function advance() {
    const callback = nextFrame;
    expect(callback).not.toBeNull();
    nextFrame = null;
    act(() => callback?.(performance.now()));
  }

  it.each(['number', 'progress'] as const)(
    'respects canvas progress color and opacity overrides in the %s variant',
    (variant) => {
      const fills: { alpha: number; color: string }[] = [];
      context.fillRect.mockImplementation(() => {
        fills.push({ alpha: context.globalAlpha, color: context.fillStyle });
      });
      const { container } = render(
        <BeatVisualizer
          variant={variant}
          progressStyle="background"
          frameSource={() => ({ accent: 1, beatCount: 4, beatIndex: 1, progress: 0.5 })}
          showProgress
          running
        />,
      );
      const canvas = container.querySelector('canvas')!;
      canvas.style.setProperty('--fmr-progress-color', '#f47a24');
      canvas.style.setProperty('--fmr-progress-opacity', '.3');
      advance();
      expect(fills.at(-1)).toEqual({ color: '#f47a24', alpha: 0.3 });
      expect(context.globalAlpha).toBe(1);

      canvas.style.setProperty('--fmr-progress-color', '#ffcc88');
      canvas.style.setProperty('--fmr-progress-opacity', 'invalid');
      advance();
      expect(fills.at(-1)).toEqual({ color: '#ffcc88', alpha: 0.16 });
    },
  );

  it.each([
    { progressStyle: 'background' as const, meterLabel: '' },
    { progressStyle: 'background' as const, meterLabel: '4/4' },
    { progressStyle: 'bar' as const, meterLabel: '' },
  ])(
    'scales only the number font with $progressStyle and meter "$meterLabel"',
    ({ progressStyle, meterLabel }) => {
      boundsWidth = 390;
      boundsHeight = 500;
      const frameSource = () => ({ accent: 1 as const, beatCount: 4, beatIndex: 1, progress: 0.5 });
      const draws = captureTextDraws();
      const { container, rerender } = render(
        <BeatVisualizer
          variant="number"
          progressStyle={progressStyle}
          meterLabel={meterLabel}
          frameSource={frameSource}
          showProgress={false}
          running={false}
        />,
      );
      const originalNumber = draws[0]!;
      const originalMeter = draws[1];
      const canvas = container.querySelector('canvas')!;
      const originalSize = { width: canvas.width, height: canvas.height };
      draws.length = 0;
      rerender(
        <BeatVisualizer
          variant="number"
          progressStyle={progressStyle}
          meterLabel={meterLabel}
          numberScale={0.8}
          frameSource={frameSource}
          showProgress={false}
          running={false}
        />,
      );
      const scaledNumber = draws[0]!;
      expect(scaledNumber.fontSize).toBeCloseTo(originalNumber.fontSize * 0.8);
      expect(scaledNumber.x).toBe(boundsWidth / 2);
      expect({ width: canvas.width, height: canvas.height }).toEqual(originalSize);
      if (progressStyle === 'background') {
        expect((scaledNumber.top + scaledNumber.bottom) / 2).toBeCloseTo(boundsHeight / 2);
      }
      if (originalMeter) {
        expect(draws[1]?.fontSize).toBeCloseTo(originalMeter.fontSize);
        expect(draws[1]?.x).toBeCloseTo(originalMeter.x);
      }
      expect(context.fillRect).not.toHaveBeenCalled();
    },
  );

  it.each([
    { width: 390, height: 64 },
    { width: 256, height: 84 },
    { width: 390, height: 180 },
  ])('centers bar-free circles in the $width×$height canvas', ({ width, height }) => {
    boundsWidth = width;
    boundsHeight = height;
    let frame: BeatFrame = { accent: 2, beatCount: 4, beatIndex: 0, progress: 0.5 };
    render(<BeatVisualizer frameSource={() => frame} showProgress={false} running />);
    const firstPositions = context.arc.mock.calls.map(([x]) => Number(x));
    expect((firstPositions[0]! + firstPositions.at(-1)!) / 2).toBeCloseTo(width / 2);
    for (const [, y, radius] of context.arc.mock.calls) {
      expect(Number(y)).toBe(height / 2);
      expect(Number(y) - Number(radius)).toBeGreaterThanOrEqual(0);
      expect(Number(y) + Number(radius)).toBeLessThanOrEqual(height);
    }
    context.arc.mockClear();
    frame = { ...frame, beatIndex: 3 };
    advance();
    expect(context.arc.mock.calls.map(([x]) => Number(x))).toEqual(firstPositions);
    expect(context.arc.mock.calls.map(([, y]) => Number(y))).toEqual([
      height / 2,
      height / 2,
      height / 2,
      height / 2,
    ]);
    expect(context.fillRect).not.toHaveBeenCalled();
  });

  it('renders only decorative full-surface progress from audio frames', () => {
    boundsWidth = 390;
    boundsHeight = 844;
    let frame: BeatFrame = { accent: 2, beatCount: 4, beatIndex: 0, progress: 0.25 };
    const fills: { alpha: number; color: string }[] = [];
    context.fillRect.mockImplementation(() => {
      fills.push({ alpha: context.globalAlpha, color: context.fillStyle });
    });
    const { container } = render(
      <BeatVisualizer
        variant="progress"
        frameSource={() => frame}
        label="숨겨야 하는 장식 레이어"
        showProgress
        running
      />,
    );
    expect(context.fillRect).toHaveBeenCalledExactlyOnceWith(0, 0, 97.5, 844);
    expect(fills[0]).toEqual({ alpha: 0.16, color: '#d4a853' });
    expect(context.globalAlpha).toBe(1);
    const canvas = container.querySelector('canvas');
    expect(canvas).toHaveAttribute('aria-hidden', 'true');
    expect(canvas).not.toHaveAttribute('role');
    expect(canvas).not.toHaveAttribute('aria-label');
    expect(container.querySelector('[aria-live]')).toBeNull();

    frame = { ...frame, isCountIn: true, countInValue: 3, progress: 0.75 };
    advance();
    expect(context.fillRect).toHaveBeenLastCalledWith(0, 0, 292.5, 844);
    expect(context.fillRect).toHaveBeenCalledTimes(2);
    expect(context.arc).not.toHaveBeenCalled();
    expect(context.stroke).not.toHaveBeenCalled();
    expect(context.fillText).not.toHaveBeenCalled();
    expect(context.measureText).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-live]')).toBeNull();
  });

  it.each(['stopped', 'waiting', 'reduced-motion', 'hidden'] as const)(
    'leaves the decorative progress layer blank when %s',
    (state) => {
      reducedMotion = state === 'reduced-motion';
      render(
        <BeatVisualizer
          variant="progress"
          frameSource={() => ({
            accent: 2,
            beatCount: 4,
            beatIndex: 0,
            progress: 0.5,
            isWaiting: state === 'waiting',
          })}
          showProgress={state !== 'hidden'}
          running={state !== 'stopped'}
        />,
      );
      expect(context.clearRect).toHaveBeenCalledWith(0, 0, boundsWidth, boundsHeight);
      expect(context.fillRect).not.toHaveBeenCalled();
      expect(context.arc).not.toHaveBeenCalled();
      expect(context.fillText).not.toHaveBeenCalled();
    },
  );

  it('resizes decorative progress while playing and clears it on stop and idle resize', () => {
    boundsWidth = 390;
    boundsHeight = 844;
    const frameSource = () => ({ accent: 1 as const, beatCount: 4, beatIndex: 1, progress: 0.5 });
    const { container, rerender } = render(
      <BeatVisualizer variant="progress" frameSource={frameSource} showProgress running />,
    );
    boundsWidth = 844;
    boundsHeight = 390;
    advance();
    expect(context.fillRect).toHaveBeenLastCalledWith(0, 0, 422, 390);
    const canvas = container.querySelector('canvas');
    expect(canvas?.width).toBe(Math.round(844 * (window.devicePixelRatio || 1)));
    expect(canvas?.height).toBe(Math.round(390 * (window.devicePixelRatio || 1)));

    context.fillRect.mockClear();
    rerender(
      <BeatVisualizer variant="progress" frameSource={frameSource} showProgress running={false} />,
    );
    expect(context.fillRect).not.toHaveBeenCalled();
    expect(cancelAnimationFrame).toHaveBeenCalled();
    boundsWidth = 256;
    boundsHeight = 480;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(context.clearRect).toHaveBeenLastCalledWith(0, 0, 256, 480);
    expect(context.fillRect).not.toHaveBeenCalled();
    expect(canvas?.width).toBe(Math.round(256 * (window.devicePixelRatio || 1)));
    expect(canvas?.height).toBe(Math.round(480 * (window.devicePixelRatio || 1)));
  });

  it('draws full-height progress behind the number from each audio frame', () => {
    boundsWidth = 390;
    boundsHeight = 500;
    let frame: BeatFrame = { accent: 1, beatCount: 4, beatIndex: 0, progress: 0.25 };
    const fills: { alpha: number; color: string }[] = [];
    context.fillRect.mockImplementation(() => {
      fills.push({ alpha: context.globalAlpha, color: context.fillStyle });
    });
    const draws = captureTextDraws();
    render(
      <BeatVisualizer
        frameSource={() => frame}
        variant="number"
        progressStyle="background"
        showProgress
        running
      />,
    );
    expect(context.fillRect).toHaveBeenCalledExactlyOnceWith(
      0,
      0,
      boundsWidth * 0.25,
      boundsHeight,
    );
    expect(context.fillRect.mock.invocationCallOrder[0]).toBeLessThan(
      context.fillText.mock.invocationCallOrder[0]!,
    );
    expect(fills[0]).toEqual({ alpha: 0.16, color: '#d4a853' });
    expect(draws[0]?.alpha).toBeCloseTo(0.6 + 0.4 * 0.75 ** 3);
    expect(draws[0]?.color).toBe('#f4f1e8');
    expect(context.globalAlpha).toBe(1);

    frame = { ...frame, progress: 0.75 };
    advance();
    expect(context.fillRect).toHaveBeenLastCalledWith(0, 0, boundsWidth * 0.75, boundsHeight);
    frame = { ...frame, isSubdivision: true, progress: 0.4 };
    advance();
    expect(context.fillRect).toHaveBeenLastCalledWith(0, 0, boundsWidth * 0.4, boundsHeight);
    expect(draws.at(-1)?.alpha).toBe(0.6);
    frame = { ...frame, isCountIn: true, countInValue: 12, isSubdivision: false, progress: 0.5 };
    advance();
    expect(draws.at(-1)?.label).toBe('12');
    expect(context.fillRect).toHaveBeenCalledTimes(4);
    expect(context.fillRect).toHaveBeenLastCalledWith(0, 0, boundsWidth * 0.5, boundsHeight);
    expect(context.arc).not.toHaveBeenCalled();
  });

  it.each(['stopped', 'waiting', 'reduced-motion', 'hidden'] as const)(
    'omits the number background fill when %s',
    (state) => {
      reducedMotion = state === 'reduced-motion';
      const draws = captureTextDraws();
      render(
        <BeatVisualizer
          frameSource={() => ({
            accent: 1,
            beatCount: 4,
            beatIndex: 0,
            progress: 0.75,
            isWaiting: state === 'waiting',
          })}
          variant="number"
          progressStyle="background"
          showProgress={state !== 'hidden'}
          running={state !== 'stopped'}
        />,
      );
      expect(context.fillRect).not.toHaveBeenCalled();
      expect(draws).toHaveLength(1);
      expect(draws[0]?.label).toBe(state === 'waiting' ? '—' : '1');
      if (state !== 'hidden') expect(draws[0]?.alpha).toBe(1);
    },
  );

  it.each([
    { width: 390, height: 500, beatCount: 4 },
    { width: 256, height: 120, beatCount: 12 },
    { width: 256, height: 52, beatCount: 4 },
  ])(
    'fits stable background-mode numbers in the whole $width×$height area without a meter',
    ({ width, height, beatCount }) => {
      boundsWidth = width;
      boundsHeight = height;
      let frame: BeatFrame = { accent: 1, beatCount, beatIndex: 0, progress: 0.5 };
      const draws = captureTextDraws();
      render(
        <BeatVisualizer
          frameSource={() => frame}
          variant="number"
          progressStyle="background"
          showProgress
          running
        />,
      );
      const fontSize = draws[0]!.fontSize;
      if (height === 500) expect(fontSize).toBeGreaterThan(200);
      for (let beatIndex = 0; beatIndex < beatCount; beatIndex += 1) {
        if (beatIndex > 0) {
          frame = { ...frame, beatIndex };
          advance();
        }
        const number = draws.at(-1)!;
        expect(number.x).toBe(width / 2);
        expect((number.top + number.bottom) / 2).toBeCloseTo(height / 2);
        expect(number.fontSize).toBeCloseTo(fontSize);
        expect(number.left).toBeGreaterThanOrEqual(0);
        expect(number.right).toBeLessThanOrEqual(width);
        expect(number.top).toBeGreaterThanOrEqual(0);
        expect(number.bottom).toBeLessThanOrEqual(height);
      }
      expect(draws).toHaveLength(beatCount);
    },
  );

  it('preserves the beats progress bar when given the number-only background style', () => {
    render(
      <BeatVisualizer
        frameSource={() => ({ accent: 1, beatCount: 4, beatIndex: 0, progress: 0.5 })}
        progressStyle="background"
        running
      />,
    );
    expect(context.arc).toHaveBeenCalledTimes(4);
    expect(context.fillRect).toHaveBeenCalledTimes(2);
    expect(Number(context.fillRect.mock.calls[0]?.[3])).toBeLessThan(boundsHeight);
    expect(Number(context.fillRect.mock.calls[1]?.[2])).toBeCloseTo(
      Number(context.fillRect.mock.calls[0]?.[2]) / 2,
    );
  });

  it.each([
    { width: 256, height: 180, meter: '4/4', countIn: 0, progress: true },
    { width: 390, height: 260, meter: '6/8', countIn: 0, progress: false },
    { width: 256, height: 52, meter: '4/4', countIn: 0, progress: true },
    { width: 256, height: 180, meter: '12/8', countIn: 12, progress: true },
    { width: 390, height: 180, meter: '3+2+2+3/16', countIn: 0, progress: true },
  ])(
    'centers the number with a separate meter at $width×$height, $meter, count-in $countIn',
    ({ width, height, meter, countIn, progress }) => {
      boundsWidth = width;
      boundsHeight = height;
      const draws = captureTextDraws();
      render(
        <BeatVisualizer
          variant="number"
          meterLabel={meter}
          showProgress={progress}
          running
          frameSource={() => ({
            accent: 1,
            beatCount: 4,
            beatIndex: 0,
            progress: 0.5,
            isCountIn: countIn > 0,
            countInValue: countIn,
          })}
        />,
      );
      expect(draws).toHaveLength(2);
      const [number, label] = draws;
      expect(number?.label).toBe(countIn ? String(countIn) : '1');
      expect(number?.x).toBe(width / 2);
      expect(label?.label).toBe(meter);
      expect(label?.fontSize).toBeLessThan(number!.fontSize);
      expect(label?.left).toBeGreaterThan(number!.right);
      expect((label!.top + label!.bottom) / 2).toBeCloseTo((number!.top + number!.bottom) / 2);
      const contentBottom = progress ? Number(context.fillRect.mock.calls[0]?.[1]) : height;
      expect((number!.top + number!.bottom) / 2).toBeCloseTo(
        (contentBottom - (progress ? 8 : 0)) / 2,
      );
      for (const draw of draws) {
        expect(draw.left).toBeGreaterThanOrEqual(0);
        expect(draw.right).toBeLessThanOrEqual(width);
        expect(draw.top).toBeGreaterThanOrEqual(0);
        expect(draw.bottom).toBeLessThan(contentBottom);
      }
      expect(context.arc).not.toHaveBeenCalled();
    },
  );

  it('enlarges a metered number beyond 200px while preserving the unmetered size', () => {
    boundsWidth = 960;
    boundsHeight = 480;
    const frameSource = () => ({ accent: 1 as const, beatCount: 4, beatIndex: 1, progress: 0 });
    const draws = captureTextDraws();
    const { rerender } = render(
      <BeatVisualizer frameSource={frameSource} variant="number" running={false} />,
    );
    expect(draws.at(-1)?.fontSize).toBe(200);
    draws.length = 0;
    rerender(
      <BeatVisualizer
        frameSource={frameSource}
        variant="number"
        meterLabel="4/4"
        running={false}
      />,
    );
    expect(draws).toHaveLength(2);
    expect(draws[0]?.fontSize).toBeGreaterThan(200);
    expect(draws[0]?.x).toBe(boundsWidth / 2);
    expect(draws[0]?.top).toBeGreaterThanOrEqual(0);
    expect(draws[0]?.bottom).toBeLessThanOrEqual(boundsHeight);
  });

  it('keeps the meter steady while the number pulses and changes between digit widths', () => {
    let frame: BeatFrame = { accent: 1, beatCount: 12, beatIndex: 0, progress: 0 };
    const draws = captureTextDraws();
    render(<BeatVisualizer frameSource={() => frame} variant="number" meterLabel="12/8" running />);
    expect(draws[0]?.alpha).toBe(1);
    expect(draws[1]).toMatchObject({ label: '12/8', alpha: 1, color: '#a8adb8' });
    frame = { ...frame, progress: 0.95 };
    advance();
    expect(draws.at(-2)?.alpha).toBeLessThan(0.7);
    expect(draws.at(-1)).toMatchObject({ label: '12/8', alpha: 1, color: '#a8adb8' });
    frame = { ...frame, beatIndex: 11, progress: 0 };
    advance();
    expect(draws.at(-2)).toMatchObject({ label: '12', x: boundsWidth / 2, alpha: 1 });
    expect(draws.at(-1)?.left).toBeGreaterThan(draws.at(-2)!.right);
  });

  it.each([4, 12])(
    'holds one font size and meter position across all %s normal beats',
    (beatCount) => {
      boundsWidth = 390;
      boundsHeight = 500;
      let frame: BeatFrame = { accent: 1, beatCount, beatIndex: 0, progress: 0 };
      const draws = captureTextDraws();
      render(
        <BeatVisualizer
          frameSource={() => frame}
          variant="number"
          meterLabel={`${beatCount}/4`}
          showProgress
          running
        />,
      );
      const initialNumberSize = draws[0]!.fontSize;
      const initialMeter = draws[1]!;
      for (let beatIndex = 1; beatIndex < beatCount; beatIndex += 1) {
        frame = { ...frame, beatIndex };
        advance();
        const number = draws.at(-2)!;
        const meter = draws.at(-1)!;
        expect(number.x).toBe(boundsWidth / 2);
        expect(number.fontSize).toBeCloseTo(initialNumberSize);
        expect(meter.x).toBeCloseTo(initialMeter.x);
        expect(meter.fontSize).toBeCloseTo(initialMeter.fontSize);
        expect(meter.left).toBeGreaterThan(number.right);
        expect(meter.right).toBeLessThanOrEqual(boundsWidth);
      }

      frame = { ...frame, isCountIn: true, countInValue: 1 };
      advance();
      expect(draws.at(-2)?.label).toBe('1');
      expect(draws.at(-2)?.fontSize).toBeGreaterThan(initialNumberSize);
    },
  );

  it.each(['waiting', 'reduced-motion'] as const)(
    'keeps the metered number and progress track steady during %s',
    (state) => {
      reducedMotion = state === 'reduced-motion';
      const draws = captureTextDraws();
      render(
        <BeatVisualizer
          frameSource={() => ({
            accent: 1,
            beatCount: 4,
            beatIndex: 0,
            progress: 0.9,
            isWaiting: state === 'waiting',
          })}
          variant="number"
          meterLabel="4/4"
          showProgress
          running
        />,
      );
      expect(draws[0]).toMatchObject({
        label: state === 'waiting' ? '—' : '1',
        x: boundsWidth / 2,
        alpha: 1,
      });
      expect(draws[1]).toMatchObject({ label: '4/4', alpha: 1 });
      expect(context.fillRect).toHaveBeenCalledTimes(1);
    },
  );

  it('ignores the number-only meter label in the beats variant', () => {
    render(
      <BeatVisualizer
        frameSource={() => ({ accent: 1, beatCount: 4, beatIndex: 0, progress: 0 })}
        meterLabel="4/4"
        running={false}
      />,
    );
    expect(context.fillText.mock.calls.map(([label]) => String(label))).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  it('draws only the current number and pulses once per main beat from the audio frame', () => {
    let frame: BeatFrame = {
      accent: 2,
      beatCount: 4,
      beatIndex: 0,
      measureNumber: 1,
      progress: 0,
    };
    const draws: { label: string; alpha: number }[] = [];
    context.fillText.mockImplementation((label: string) => {
      draws.push({ label, alpha: context.globalAlpha });
    });
    const { container } = render(
      <BeatVisualizer frameSource={() => frame} variant="number" running />,
    );
    expect(draws.at(-1)).toEqual({ label: '1', alpha: 1 });
    expect(context.arc).not.toHaveBeenCalled();
    expect(context.fillRect).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-live]')).toBeNull();

    frame = { ...frame, progress: 0.95 };
    advance();
    expect(draws.at(-1)?.alpha).toBeLessThan(0.7);
    frame = { ...frame, isSubdivision: true, progress: 0 };
    advance();
    expect(draws.at(-1)).toEqual({ label: '1', alpha: 0.6 });
    frame = { ...frame, beatIndex: 1, isSubdivision: false, progress: 0 };
    advance();
    expect(draws.at(-1)).toEqual({ label: '2', alpha: 1 });
    expect(context.globalAlpha).toBe(1);
  });

  it.each(['stopped', 'waiting', 'reduced-motion'] as const)(
    'keeps the number steady when %s',
    (state) => {
      reducedMotion = state === 'reduced-motion';
      let drawnAlpha = 0;
      context.fillText.mockImplementation(() => {
        drawnAlpha = context.globalAlpha;
      });
      render(
        <BeatVisualizer
          frameSource={() => ({
            accent: 1,
            beatCount: 4,
            beatIndex: 2,
            progress: 0.9,
            isWaiting: state === 'waiting',
          })}
          variant="number"
          running={state !== 'stopped'}
        />,
      );
      expect(drawnAlpha).toBe(1);
      expect(context.fillText).toHaveBeenLastCalledWith(
        state === 'waiting' ? '—' : '3',
        boundsWidth / 2,
        boundsHeight / 2,
      );
    },
  );

  it('uses the count-in number before switching to the first beat', () => {
    let frame: BeatFrame = {
      accent: 1,
      beatCount: 3,
      beatIndex: 0,
      isCountIn: true,
      countInValue: 2,
      progress: 0,
    };
    render(<BeatVisualizer frameSource={() => frame} variant="number" running />);
    expect(context.fillText).toHaveBeenLastCalledWith('2', boundsWidth / 2, boundsHeight / 2);
    frame = { ...frame, isCountIn: false };
    advance();
    expect(context.fillText).toHaveBeenLastCalledWith('1', boundsWidth / 2, boundsHeight / 2);
  });

  it('fits the number and its relocated progress track inside a short panel', () => {
    boundsWidth = 256;
    boundsHeight = 52;
    render(
      <BeatVisualizer
        variant="number"
        showProgress
        running
        frameSource={() => ({ accent: 1, beatCount: 4, beatIndex: 1, progress: 0.5 })}
      />,
    );
    expect(context.arc).not.toHaveBeenCalled();
    expect(context.fillRect).toHaveBeenCalledTimes(2);
    const track = context.fillRect.mock.calls[0]!.map(Number);
    const fill = context.fillRect.mock.calls[1]!.map(Number);
    expect(track[0]! + track[2]!).toBeLessThanOrEqual(boundsWidth);
    expect(track[1]! + track[3]!).toBeLessThanOrEqual(boundsHeight);
    expect(fill[2]).toBeCloseTo(track[2]! / 2);
    const fontSize = Number(context.font.match(/([\d.]+)px/)?.[1]);
    const numberY = Number(context.fillText.mock.calls[0]?.[2]);
    expect(numberY - fontSize / 2).toBeGreaterThanOrEqual(0);
    expect(numberY + fontSize / 2).toBeLessThan(track[1]!);
  });

  it.each(['waiting', 'reduced-motion'] as const)(
    'keeps only a fixed number-panel track during %s',
    (state) => {
      reducedMotion = state === 'reduced-motion';
      render(
        <BeatVisualizer
          variant="number"
          showProgress
          running
          frameSource={() => ({
            accent: 1,
            beatCount: 4,
            beatIndex: 1,
            progress: 0.5,
            isWaiting: state === 'waiting',
          })}
        />,
      );
      expect(context.fillRect).toHaveBeenCalledTimes(1);
      expect(Number(context.fillRect.mock.calls[0]?.[2])).toBeGreaterThan(0);
    },
  );

  it.each([false, true])('can omit the old track with count-in=%s', (isCountIn) => {
    render(
      <BeatVisualizer
        showProgress={false}
        running
        frameSource={() => ({
          accent: 1,
          beatCount: 4,
          beatIndex: 0,
          progress: 0.5,
          isCountIn,
          countInValue: 4,
        })}
      />,
    );
    expect(context.fillRect).not.toHaveBeenCalled();
    expect(context.fillText).toHaveBeenCalled();
  });

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

  it('waits for the first scheduled click before highlighting or announcing a measure', () => {
    let frame: BeatFrame = {
      accent: 2,
      beatCount: 3,
      beatIndex: 0,
      measureNumber: 5,
      progress: 0,
      isWaiting: true,
    };
    render(<BeatVisualizer frameSource={() => frame} running />);
    expect(screen.queryByText('5마디 시작')).not.toBeInTheDocument();
    expect(context.arc.mock.calls[0]?.[2]).toBe(context.arc.mock.calls[1]?.[2]);
    frame = { ...frame, isWaiting: false };
    advance();
    expect(screen.getByText('5마디 시작')).toBeInTheDocument();
  });

  it('redraws a changed idle preview without requiring a resize or playback', () => {
    const frame: BeatFrame = { accent: 2, beatCount: 3, beatIndex: 0, progress: 0 };
    const { rerender } = render(<BeatVisualizer frameSource={() => frame} running={false} />);
    context.fillText.mockClear();
    rerender(<BeatVisualizer frameSource={() => ({ ...frame, beatCount: 4 })} running={false} />);
    expect(context.fillText.mock.calls.map(([label]) => String(label))).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
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
    expect(context.fillText.mock.calls.map(([label]) => String(label))).toEqual(['4']);
    expect(context.arc).not.toHaveBeenCalled();
    const numeralY = Number(context.fillText.mock.calls[0]?.[2]);
    const trackY = Number(context.fillRect.mock.calls[0]?.[1]);
    expect(numeralY - fontSize / 2).toBeGreaterThanOrEqual(0);
    expect(numeralY + fontSize / 2).toBeLessThan(trackY);
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
