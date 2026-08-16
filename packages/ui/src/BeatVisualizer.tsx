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
  const gap = Math.min(28, width * 0.04);
  const usableWidth = width - gap * (count - 1);
  const radius = Math.max(12, Math.min(34, usableWidth / count / 2));
  const totalWidth = radius * 2 * count + gap * (count - 1);
  const startX = (width - totalWidth) / 2 + radius;
  const y = height * 0.48;

  for (let index = 0; index < count; index += 1) {
    const current = index === frame.beatIndex;
    const x = startX + index * (radius * 2 + gap);
    const downbeat = index === 0;
    context.beginPath();
    context.arc(x, y, current && downbeat ? radius * 1.2 : radius, 0, Math.PI * 2);
    context.fillStyle = current
      ? downbeat
        ? css('--accent', '#d4a853')
        : css('--beat', '#f4f1e8')
      : css('--surface-raised', '#1c1f26');
    context.fill();
    context.lineWidth = current ? 3 : 1;
    context.strokeStyle = current ? css('--text', '#f4f1e8') : css('--border', '#2a2e37');
    context.stroke();
  }

  if (!reducedMotion) {
    const barWidth = Math.min(width * 0.7, 540);
    const barX = (width - barWidth) / 2;
    const barY = y + radius * 1.8;
    context.fillStyle = css('--surface-raised', '#1c1f26');
    context.fillRect(barX, barY, barWidth, 5);
    context.fillStyle = frame.isCountIn ? css('--count-in', '#6fbf9e') : css('--accent', '#d4a853');
    context.fillRect(barX, barY, barWidth * Math.min(1, Math.max(0, frame.progress)), 5);
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

    const render = () => {
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
      if (running) animationFrame = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationFrame);
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
