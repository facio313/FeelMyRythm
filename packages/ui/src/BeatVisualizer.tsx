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
  const horizontalPadding = Math.max(12, Math.min(40, width * 0.06));
  const gap = Math.max(8, Math.min(32, width * 0.035));
  const usableWidth = Math.max(1, width - horizontalPadding * 2 - gap * (count - 1));
  const radius = Math.max(9, Math.min(52, usableWidth / count / 2, height * 0.2));
  const totalWidth = radius * 2 * count + gap * (count - 1);
  const startX = (width - totalWidth) / 2 + radius;
  const barHeight = Math.max(6, Math.min(12, height * 0.025));
  const lowestCircleY = height - barHeight - 8 - radius * 1.72;
  const y = Math.max(radius * 1.2 + 4, Math.min(height * 0.7, lowestCircleY));

  for (let index = 0; index < count; index += 1) {
    const current = index === frame.beatIndex;
    const x = startX + index * (radius * 2 + gap);
    const downbeat = index === 0;
    const emphasized = downbeat || frame.accent === 2;
    const currentRadius = current && downbeat ? Math.min(radius * 1.16, radius + 8) : radius;
    context.beginPath();
    context.arc(x, y, currentRadius, 0, Math.PI * 2);
    context.fillStyle = current
      ? emphasized
        ? css('--accent', '#d4a853')
        : css('--beat', '#f4f1e8')
      : css('--surface-raised', '#1c1f26');
    context.fill();
    context.lineWidth = current ? Math.max(3, Math.min(5, radius * 0.1)) : 2;
    context.strokeStyle = current ? css('--text', '#f4f1e8') : css('--border', '#2a2e37');
    context.stroke();
  }

  const barWidth = Math.min(width * 0.78, 720);
  const barX = (width - barWidth) / 2;
  const barY = Math.min(height - barHeight - 8, y + radius * 1.72);
  context.fillStyle = css('--surface-raised', '#1c1f26');
  context.fillRect(barX, barY, barWidth, barHeight);
  if (!reducedMotion) {
    context.fillStyle = frame.isCountIn ? css('--count-in', '#6fbf9e') : css('--accent', '#d4a853');
    context.fillRect(barX, barY, barWidth * Math.min(1, Math.max(0, frame.progress)), barHeight);
  }

  if (frame.isCountIn && frame.countInValue) {
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = css('--count-in', '#6fbf9e');
    context.font = `300 ${Math.max(96, height * 0.42)}px 'Pretendard Variable', sans-serif`;
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
