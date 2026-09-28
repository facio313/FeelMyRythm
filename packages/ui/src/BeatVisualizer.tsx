import { useEffect, useRef, useState } from 'react';

export interface BeatFrame {
  beatIndex: number;
  beatCount: number;
  progress: number;
  accent: 0 | 1 | 2;
  isSubdivision?: boolean;
  isCountIn?: boolean;
  countInValue?: number;
  measureNumber?: number;
  isWaiting?: boolean;
}

export interface BeatVisualizerProps {
  frameSource: () => BeatFrame;
  running: boolean;
  className?: string;
  label?: string;
  variant?: 'beats' | 'number' | 'progress';
  showProgress?: boolean;
  progressStyle?: 'bar' | 'background';
  meterLabel?: string;
  numberScale?: number;
}

const css = (name: string, fallback: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function drawBackgroundProgress(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  progress: number,
) {
  const styles = getComputedStyle(canvas);
  const rawOpacity = styles.getPropertyValue('--fmr-progress-opacity').trim();
  const opacity = Number(rawOpacity);
  context.globalAlpha =
    rawOpacity && Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 0.16;
  context.fillStyle =
    styles.getPropertyValue('--fmr-progress-color').trim() || css('--accent', '#d4a853');
  context.fillRect(0, 0, width * Math.min(1, Math.max(0, progress)), height);
  context.globalAlpha = 1;
}

function drawFittedNumber(
  context: CanvasRenderingContext2D,
  value: string,
  meterLabel: string | undefined,
  width: number,
  contentHeight: number,
  normalBeatCount: number,
  numberScale: number,
) {
  const halfWidth = width / 2 - Math.min(12, width * 0.04);
  const textHeight = contentHeight - 2 * Math.min(8, contentHeight * 0.08);
  const gap = meterLabel ? Math.min(12, width * 0.025, contentHeight * 0.12) : 0;
  let numberSize = contentHeight * 1.5;
  let meterSize = Math.min(36, Math.max(12, numberSize * 0.18));
  const font = (size: number) => `600 ${size}px 'Pretendard Variable', sans-serif`;
  context.textBaseline = 'alphabetic';
  const measure = () => {
    context.textAlign = 'center';
    context.font = font(numberSize);
    const number = context.measureText(value);
    const numberBounds = {
      left: number.actualBoundingBoxLeft,
      right: number.actualBoundingBoxRight,
      height: number.actualBoundingBoxAscent + number.actualBoundingBoxDescent,
    };
    for (let beat = 1; beat <= normalBeatCount; beat += 1) {
      const beatMetrics = context.measureText(String(beat));
      numberBounds.left = Math.max(numberBounds.left, beatMetrics.actualBoundingBoxLeft);
      numberBounds.right = Math.max(numberBounds.right, beatMetrics.actualBoundingBoxRight);
      numberBounds.height = Math.max(
        numberBounds.height,
        beatMetrics.actualBoundingBoxAscent + beatMetrics.actualBoundingBoxDescent,
      );
    }
    let meter: TextMetrics | null = null;
    if (meterLabel) {
      context.textAlign = 'left';
      context.font = font(meterSize);
      meter = context.measureText(meterLabel);
    }
    return { number, numberBounds, meter };
  };
  let metrics = measure();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const scale = Math.min(
      1,
      halfWidth / metrics.numberBounds.left,
      (halfWidth - gap) /
        (metrics.numberBounds.right +
          (metrics.meter?.actualBoundingBoxLeft ?? 0) +
          (metrics.meter?.actualBoundingBoxRight ?? 0)),
      textHeight /
        Math.max(
          metrics.numberBounds.height,
          (metrics.meter?.actualBoundingBoxAscent ?? 0) +
            (metrics.meter?.actualBoundingBoxDescent ?? 0),
        ),
    );
    if (scale >= 1) break;
    numberSize *= scale;
    meterSize *= scale;
    metrics = measure();
  }
  const centeredBaseline = (text: TextMetrics) =>
    contentHeight / 2 + (text.actualBoundingBoxAscent - text.actualBoundingBoxDescent) / 2;
  context.textAlign = 'center';
  context.font = font(numberSize * numberScale);
  const numberMetrics = numberScale === 1 ? metrics.number : context.measureText(value);
  context.fillText(value, width / 2, centeredBaseline(numberMetrics));
  context.globalAlpha = 1;
  if (!meterLabel || !metrics.meter) return;
  context.textAlign = 'left';
  context.font = font(meterSize);
  context.fillStyle = css('--text-secondary', '#a8adb8');
  context.fillText(
    meterLabel,
    width / 2 + metrics.numberBounds.right + gap + metrics.meter.actualBoundingBoxLeft,
    centeredBaseline(metrics.meter),
  );
}

function drawFrame(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  frame: BeatFrame,
  reducedMotion: boolean,
  running: boolean,
  variant: 'beats' | 'number' | 'progress',
  showProgress: boolean,
  progressStyle: 'bar' | 'background',
  meterLabel: string | undefined,
  numberScale: number,
) {
  const ratio = window.devicePixelRatio || 1;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  if (variant === 'progress') {
    if (showProgress && running && !frame.isWaiting && !reducedMotion) {
      drawBackgroundProgress(context, canvas, width, height, frame.progress);
    }
    return;
  }

  if (variant === 'number') {
    const value = frame.isWaiting
      ? '—'
      : String(
          frame.isCountIn && frame.countInValue !== undefined
            ? frame.countInValue
            : Math.min(Math.max(1, frame.beatCount), Math.max(1, Math.floor(frame.beatIndex) + 1)),
        );
    const backgroundProgress = progressStyle === 'background';
    const showBar = showProgress && !backgroundProgress;
    if (showProgress && backgroundProgress && running && !frame.isWaiting && !reducedMotion) {
      drawBackgroundProgress(context, canvas, width, height, frame.progress);
    }
    const progress = frame.isSubdivision ? 1 : Math.min(1, Math.max(0, frame.progress));
    context.globalAlpha =
      running && !frame.isWaiting && !reducedMotion ? 0.6 + 0.4 * (1 - progress) ** 3 : 1;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = css('--text', '#f4f1e8');
    const barHeight = Math.max(6, Math.min(14, height * 0.03));
    if (meterLabel || backgroundProgress) {
      const contentHeight = showBar ? Math.max(1, height - barHeight - 16) : height;
      drawFittedNumber(
        context,
        value,
        meterLabel,
        width,
        contentHeight,
        frame.isCountIn || frame.isWaiting ? 0 : frame.beatCount,
        numberScale,
      );
    } else {
      const contentHeight = showProgress ? height - 18 : height;
      const numberSize = Math.max(
        24,
        Math.min(200, contentHeight * 0.78, (width * 0.8) / value.length),
      );
      context.font = `600 ${numberSize * numberScale}px 'Pretendard Variable', sans-serif`;
      context.fillText(value, width / 2, contentHeight / 2);
    }
    context.globalAlpha = 1;
    if (showBar) {
      const barWidth = width * 0.82;
      const barX = (width - barWidth) / 2;
      const barY = height - barHeight - 8;
      context.fillStyle = css('--control-border', '#626a78');
      context.fillRect(barX, barY, barWidth, barHeight);
      if (!reducedMotion && !frame.isWaiting) {
        context.fillStyle = frame.isCountIn
          ? css('--count-in', '#6fbf9e')
          : css('--accent', '#d4a853');
        context.fillRect(
          barX,
          barY,
          barWidth * Math.min(1, Math.max(0, frame.progress)),
          barHeight,
        );
      }
    }
    return;
  }

  if (frame.isCountIn && frame.countInValue) {
    const barHeight = Math.max(6, Math.min(14, height * 0.03));
    const barWidth = Math.min(width * 0.82, 920);
    const barX = (width - barWidth) / 2;
    const barY = height - barHeight - 4;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = css('--count-in', '#6fbf9e');
    context.font = `300 ${Math.max(24, Math.min(160, height * 0.62))}px 'Pretendard Variable', sans-serif`;
    context.fillText(String(frame.countInValue), width / 2, (barY - 4) / 2);
    if (showProgress) {
      context.fillStyle = css('--control-border', '#626a78');
      context.fillRect(barX, barY, barWidth, barHeight);
      if (!reducedMotion) {
        context.fillStyle = css('--count-in', '#6fbf9e');
        context.fillRect(
          barX,
          barY,
          barWidth * Math.min(1, Math.max(0, frame.progress)),
          barHeight,
        );
      }
    }
    return;
  }

  const count = Math.max(1, frame.beatCount);
  const activeBeatIndex = Math.min(count - 1, Math.max(0, Math.floor(frame.beatIndex)));
  const horizontalPadding = Math.max(12, Math.min(40, width * 0.06));
  const gap = Math.max(8, Math.min(32, width * 0.035));
  const minimumSlotWidth = 24 + gap;
  const visibleCapacity = Math.max(
    1,
    Math.min(count, Math.floor((width - horizontalPadding * 2 + gap) / minimumSlotWidth)),
  );
  const pageStart = Math.floor(activeBeatIndex / visibleCapacity) * visibleCapacity;
  const pageEnd = Math.min(count, pageStart + visibleCapacity);
  const visibleIndexes = Array.from(
    { length: pageEnd - pageStart },
    (_, index) => pageStart + index,
  );
  const usableWidth = Math.max(1, width - horizontalPadding * 2 - gap * (visibleCapacity - 1));
  const radius = Math.max(9, Math.min(72, usableWidth / visibleCapacity / 2, height * 0.3));
  const totalWidth =
    radius * 2 * visibleIndexes.length + gap * Math.max(0, visibleIndexes.length - 1);
  const startX = (width - totalWidth) / 2 + radius;
  const barHeight = Math.max(6, Math.min(14, height * 0.03));
  const lowestCircleY = height - barHeight - 8 - radius * 1.72;
  const y = showProgress
    ? Math.max(radius * 1.2 + 4, Math.min(height * 0.54, lowestCircleY))
    : height / 2;

  for (let slot = 0; slot < visibleIndexes.length; slot += 1) {
    const beatIndex = visibleIndexes[slot]!;
    const current = !frame.isWaiting && beatIndex === activeBeatIndex;
    const x = startX + slot * (radius * 2 + gap);
    const downbeat = beatIndex === 0;
    const emphasized = downbeat || frame.accent === 2;
    const currentRadius = current
      ? Math.min(radius * (downbeat ? 1.18 : 1.1), radius + (downbeat ? 10 : 7))
      : radius;
    context.beginPath();
    context.arc(x, y, currentRadius, 0, Math.PI * 2);
    context.fillStyle = current
      ? emphasized
        ? css('--accent', '#d4a853')
        : css('--beat', '#f4f1e8')
      : css('--surface-raised', '#1c1f26');
    context.fill();
    context.lineWidth = current ? Math.max(3, Math.min(5, radius * 0.1)) : 2;
    context.strokeStyle = current ? css('--text', '#f4f1e8') : css('--control-border', '#626a78');
    context.stroke();

    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = current
      ? css('--on-accent', '#0c0d10')
      : css('--text-secondary', '#a8adb8');
    context.font = `600 ${Math.max(12, Math.min(26, radius * 0.52))}px 'Pretendard Variable', sans-serif`;
    context.fillText(String(beatIndex + 1), x, y + 1);
  }

  if (pageStart > 0 || pageEnd < count) {
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = css('--text-secondary', '#a8adb8');
    context.font = `700 ${Math.max(12, Math.min(18, radius * 0.7))}px 'Pretendard Variable', sans-serif`;
    if (pageStart > 0) context.fillText('…', horizontalPadding / 2, y);
    if (pageEnd < count) context.fillText('…', width - horizontalPadding / 2, y);
  }

  if (!showProgress) return;
  const barWidth = Math.min(width * 0.82, 920);
  const barX = (width - barWidth) / 2;
  const barY = Math.min(height - barHeight - 8, y + radius * 1.72);
  context.fillStyle = css('--control-border', '#626a78');
  context.fillRect(barX, barY, barWidth, barHeight);
  if (!reducedMotion) {
    context.fillStyle = frame.isCountIn ? css('--count-in', '#6fbf9e') : css('--accent', '#d4a853');
    context.fillRect(barX, barY, barWidth * Math.min(1, Math.max(0, frame.progress)), barHeight);
  }
}

export function BeatVisualizer({
  frameSource,
  running,
  className,
  label = '박자 시각화',
  variant = 'beats',
  showProgress = variant === 'beats',
  progressStyle = 'bar',
  meterLabel,
  numberScale = 1,
}: BeatVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceRef = useRef(frameSource);
  const [announcement, setAnnouncement] = useState({ sequence: 0, text: '' });
  const announcementRef = useRef('');
  const boundaryActiveRef = useRef(false);
  const lastAnnouncedRef = useRef('');

  useEffect(() => {
    sourceRef.current = frameSource;
  }, [frameSource]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let animationFrame = 0;

    const render = (scheduleNext: boolean) => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      if (
        canvas.width !== Math.round(width * ratio) ||
        canvas.height !== Math.round(height * ratio)
      ) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      const frame = sourceRef.current();
      drawFrame(
        context,
        canvas,
        width,
        height,
        frame,
        reduced,
        running,
        variant,
        showProgress,
        progressStyle,
        meterLabel,
        numberScale,
      );
      const boundaryAnnouncement = frame.isCountIn
        ? frame.countInValue === undefined
          ? null
          : {
              key: `count-in:${frame.countInValue}`,
              text: `예비박 ${frame.countInValue}`,
            }
        : frame.beatIndex === 0 && !frame.isSubdivision
          ? {
              key: `measure:${frame.measureNumber ?? 1}`,
              text: `${frame.measureNumber ?? 1}마디 시작`,
            }
          : null;
      if (!running || frame.isWaiting || variant !== 'beats') {
        boundaryActiveRef.current = false;
        lastAnnouncedRef.current = '';
        if (announcementRef.current) {
          announcementRef.current = '';
          setAnnouncement((current) => ({ sequence: current.sequence + 1, text: '' }));
        }
      } else if (boundaryAnnouncement) {
        if (!boundaryActiveRef.current || boundaryAnnouncement.key !== lastAnnouncedRef.current) {
          lastAnnouncedRef.current = boundaryAnnouncement.key;
          announcementRef.current = boundaryAnnouncement.text;
          setAnnouncement((current) => ({
            sequence: current.sequence + 1,
            text: boundaryAnnouncement.text,
          }));
        }
        boundaryActiveRef.current = true;
      } else {
        boundaryActiveRef.current = false;
      }
      if (scheduleNext) animationFrame = requestAnimationFrame(() => render(true));
    };

    const renderWhenIdle = () => {
      if (!running) render(false);
    };
    render(running);

    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(renderWhenIdle);
    resizeObserver?.observe(canvas);
    window.addEventListener('resize', renderWhenIdle);

    const themeObserver =
      typeof MutationObserver === 'undefined'
        ? undefined
        : new MutationObserver((records) => {
            if (records.some((record) => record.attributeName === 'data-theme')) renderWhenIdle();
          });
    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      window.removeEventListener('resize', renderWhenIdle);
    };
  }, [frameSource, running, variant, showProgress, progressStyle, meterLabel, numberScale]);

  return (
    <div className={className}>
      <canvas
        ref={canvasRef}
        className="fmr-beat-canvas"
        role={variant === 'progress' ? undefined : 'img'}
        aria-label={variant === 'progress' ? undefined : label}
        aria-hidden={variant === 'progress' ? true : undefined}
      />
      {variant === 'beats' ? (
        <span className="fmr-sr-only" aria-live="polite" aria-atomic="true">
          {announcement.text ? <span key={announcement.sequence}>{announcement.text}</span> : null}
        </span>
      ) : null}
    </div>
  );
}
