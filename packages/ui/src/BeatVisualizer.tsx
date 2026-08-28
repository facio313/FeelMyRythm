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
}

export interface BeatVisualizerProps {
  frameSource: () => BeatFrame;
  running: boolean;
  className?: string;
  label?: string;
}

const css = (name: string, fallback: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function drawFrame(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: BeatFrame,
  reducedMotion: boolean,
) {
  const ratio = window.devicePixelRatio || 1;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

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
  const y = Math.max(radius * 1.2 + 4, Math.min(height * 0.54, lowestCircleY));

  for (let slot = 0; slot < visibleIndexes.length; slot += 1) {
    const beatIndex = visibleIndexes[slot]!;
    const current = beatIndex === activeBeatIndex;
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

  const barWidth = Math.min(width * 0.82, 920);
  const barX = (width - barWidth) / 2;
  const barY = Math.min(height - barHeight - 8, y + radius * 1.72);
  context.fillStyle = css('--control-border', '#626a78');
  context.fillRect(barX, barY, barWidth, barHeight);
  if (!reducedMotion) {
    context.fillStyle = frame.isCountIn ? css('--count-in', '#6fbf9e') : css('--accent', '#d4a853');
    context.fillRect(barX, barY, barWidth * Math.min(1, Math.max(0, frame.progress)), barHeight);
  }

  if (frame.isCountIn && frame.countInValue) {
    const countInFontSize = Math.max(24, Math.min(160, height * 0.62));
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = css('--count-in', '#6fbf9e');
    context.font = `300 ${countInFontSize}px 'Pretendard Variable', sans-serif`;
    context.fillText(String(frame.countInValue), width / 2, height / 2);
  }
}

export function BeatVisualizer({
  frameSource,
  running,
  className,
  label = '박자 시각화',
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
      drawFrame(context, width, height, frame, reduced);
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
      if (!running) {
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
  }, [running]);

  return (
    <div className={className}>
      <canvas ref={canvasRef} className="fmr-beat-canvas" role="img" aria-label={label} />
      <span className="fmr-sr-only" aria-live="polite" aria-atomic="true">
        {announcement.text ? <span key={announcement.sequence}>{announcement.text}</span> : null}
      </span>
    </div>
  );
}
