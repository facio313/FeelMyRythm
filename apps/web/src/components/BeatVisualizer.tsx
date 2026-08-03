/**
 * 비주얼 메트로놈 (설계문서 §9, UI_DESIGN.md §7.1).
 * - 이산 플래시 + 다음 박까지 차오르는 채움 예측 큐 (지휘자의 예비 동작 역할)
 * - 다운비트 = 골드 + 크기 + 위치 삼중 부호화, 예비박 = 세이지 + 대형 카운트다운
 * - CSS transition 금지: 오디오 클럭 기준 rAF 직접 렌더 (정확성 문제)
 */
import type { PerformanceTimeline } from '@feelmyrythm/core';
import type { ScheduledBeat } from '@feelmyrythm/audio';
import { useEffect, useRef } from 'react';
import { getEngine } from '../lib/useMetronome';

const COLORS = {
  accent: '#d4a853',
  beat: '#f4f1e8',
  muted: '#6c7280',
  countIn: '#6fbf9e',
  border: '#2a2e37',
};

interface Props {
  queueRef: React.RefObject<ScheduledBeat[]>;
  timeline: PerformanceTimeline | null;
  running: boolean;
  /** 활성 박이 바뀔 때 (마디 번호 표시 등 텍스트 UI용) */
  onDisplayBeat?: (beat: ScheduledBeat | null) => void;
  height?: number;
}

export function BeatVisualizer({ queueRef, timeline, running, onDisplayBeat, height = 180 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastReportedRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const engine = getEngine();
      const now = engine.now();
      const queue = queueRef.current;

      // 오래된 박 정리
      while (queue.length > 0 && queue[0]!.audioTime < now - 4) queue.shift();

      let current: ScheduledBeat | null = null;
      let next: ScheduledBeat | null = null;
      for (const b of queue) {
        if (b.audioTime <= now) current = b;
        else {
          next = b;
          break;
        }
      }

      if (onDisplayBeat && current?.audioTime !== lastReportedRef.current) {
        lastReportedRef.current = current?.audioTime ?? null;
        onDisplayBeat(current);
      }

      if (!running || !current) {
        // 대기 상태: 빈 슬롯 4개
        drawSlots(ctx, w, h, 4, -1, -1, 0);
        return;
      }

      const sinceBeat = now - current.audioTime;
      const flash = Math.max(0, 1 - sinceBeat / 0.12); // 박 직후 120ms 플래시

      if (current.isCountIn) {
        // 예비박: 대형 카운트다운 (§9)
        ctx.fillStyle = COLORS.countIn;
        ctx.globalAlpha = 0.12 + flash * 0.25;
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
        ctx.fillStyle = COLORS.countIn;
        ctx.font = `300 ${Math.min(h * 0.72, 160)}px 'Pretendard Variable', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(current.countdown ?? ''), w / 2, h / 2);
        return;
      }

      // 본 재생: 현재 마디의 박 슬롯
      const entry =
        timeline && current.entryIndex !== undefined ? timeline.entries[current.entryIndex] : undefined;
      const mainBeats = entry ? entry.beats.filter((b) => !b.isSubdivision).length : 4;
      let activeSlot = 0;
      if (entry && current.beatIndex !== undefined) {
        for (let i = 0; i <= current.beatIndex; i++) {
          if (!entry.beats[i]!.isSubdivision) activeSlot++;
        }
        activeSlot -= 1;
      }

      // 다음 박까지의 채움 진행 (예측 큐)
      let progress = 0;
      if (next) {
        progress = Math.min(1, Math.max(0, (now - current.audioTime) / (next.audioTime - current.audioTime)));
      }

      drawSlots(ctx, w, h, mainBeats, activeSlot, current.accent, flash);

      // 채움 바 (슬롯 아래)
      const barY = h - 14;
      ctx.fillStyle = COLORS.border;
      ctx.fillRect(w * 0.1, barY, w * 0.8, 3);
      ctx.fillStyle = next?.accent === 2 ? COLORS.accent : COLORS.beat;
      ctx.fillRect(w * 0.1, barY, w * 0.8 * progress, 3);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [queueRef, timeline, running, onDisplayBeat]);

  return <canvas ref={canvasRef} style={{ width: '100%', height, display: 'block' }} />;
}

function drawSlots(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  count: number,
  activeIndex: number,
  activeAccent: number,
  flash: number,
) {
  const usable = w * 0.8;
  const startX = w * 0.1;
  const cy = h * 0.45;
  const gap = usable / Math.max(count, 1);
  const baseR = Math.min(gap * 0.28, h * 0.2);

  for (let i = 0; i < count; i++) {
    const cx = startX + gap * (i + 0.5);
    const isActive = i === activeIndex;
    const isDownbeatSlot = i === 0;
    // 다운비트: 크기 + 색 + (위치는 항상 첫 슬롯) 삼중 부호화
    const r = baseR * (isDownbeatSlot ? 1.25 : 1) * (isActive ? 1 + flash * 0.25 : 1);

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (isActive) {
      ctx.fillStyle = activeAccent === 2 ? COLORS.accent : COLORS.beat;
      ctx.globalAlpha = 0.45 + flash * 0.55;
      ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      ctx.strokeStyle = isDownbeatSlot ? COLORS.accent : COLORS.muted;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}
