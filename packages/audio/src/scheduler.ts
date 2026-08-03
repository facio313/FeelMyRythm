/**
 * 룩어헤드 스케줄러 (설계문서 §5.2, Two Clocks 패턴).
 * Web Worker 타이머(25ms)가 룩어헤드 창(150ms) 안에 도래할 박을
 * 오디오 클럭 절대 시각으로 예약한다. 시각화는 audio clock 기준 rAF에서 별도 렌더.
 */
import type { CountInBeat, PerformanceTimeline } from '@feelmyrythm/core';
import type { AudioEngine, ClickKind } from './engine';

const TICK_MS = 25;
const LOOKAHEAD_SEC = 0.15;

export interface ScheduledBeat {
  /** 이 박이 울리는 오디오 클럭 시각 (초) */
  audioTime: number;
  isCountIn: boolean;
  /** 예비박 카운트다운 (4·3·2·1), 예비박일 때만 */
  countdown?: number;
  accent: 0 | 1 | 2;
  isSubdivision: boolean;
  measureNumber?: number;
  pass?: number;
  entryIndex?: number;
  beatIndex?: number;
}

export interface StartOptions {
  timeline: PerformanceTimeline;
  /** 본 재생 시작 지점의 타임라인 오프셋(초) — seekPoint() 결과 */
  anchorSec: number;
  /** 앵커 지점이 울릴 오디오 클럭 시각. 과거여도 됨(늦은 합류 → 다음 박부터) */
  anchorAudioTime: number;
  /** 예비박 (앵커 기준 음수 오프셋). 늦은 합류 시엔 생략 */
  countIn?: CountInBeat[];
}

interface FlatBeat {
  /** 앵커 기준 상대 시각 (초, 예비박은 음수) */
  relSec: number;
  kind: ClickKind;
  beat: Omit<ScheduledBeat, 'audioTime'>;
}

export function countInDurationSec(countIn: CountInBeat[]): number {
  return countIn.length > 0 ? -countIn[0]!.timeSec : 0;
}

export class MetronomeScheduler {
  private worker: Worker | null = null;
  private flat: FlatBeat[] = [];
  private pointer = 0;
  private anchorAudioTime = 0;
  private anchorSec = 0;
  private running = false;

  /** 룩어헤드 시점에 호출 — UI는 audioTime에 맞춰 자체 렌더 */
  onBeat: ((b: ScheduledBeat) => void) | null = null;
  onEnded: (() => void) | null = null;

  constructor(private engine: AudioEngine) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** 현재 타임라인 위치(초). 예비박 중엔 음수, 미재생 시 null */
  positionSec(): number | null {
    if (!this.running) return null;
    return this.engine.now() - this.anchorAudioTime + this.anchorSec;
  }

  start(opts: StartOptions): void {
    this.stopInternal();
    this.anchorAudioTime = opts.anchorAudioTime;
    this.anchorSec = opts.anchorSec;
    this.flat = [];

    for (const c of opts.countIn ?? []) {
      this.flat.push({
        relSec: c.timeSec,
        kind: 'countIn',
        beat: { isCountIn: true, countdown: c.countdown, accent: c.accent, isSubdivision: false },
      });
    }
    opts.timeline.entries.forEach((entry, entryIndex) => {
      entry.beats.forEach((b, beatIndex) => {
        if (b.timeSec < opts.anchorSec - 1e-9) return;
        this.flat.push({
          relSec: b.timeSec - opts.anchorSec,
          kind: b.isSubdivision ? 'sub' : b.accent === 2 ? 'downbeat' : 'beat',
          beat: {
            isCountIn: false,
            accent: b.accent,
            isSubdivision: b.isSubdivision,
            measureNumber: entry.measureNumber,
            pass: entry.pass,
            entryIndex,
            beatIndex,
          },
        });
      });
    });

    // 늦은 합류: 이미 지난 박은 건너뜀
    const nowRel = this.engine.now() - this.anchorAudioTime;
    this.pointer = this.flat.findIndex((f) => f.relSec >= nowRel + 0.02);
    if (this.pointer < 0) this.pointer = this.flat.length;

    this.running = true;
    this.worker = createTickWorker();
    this.worker.onmessage = () => this.tick();
    this.worker.postMessage('start');
    this.tick();
  }

  stop(): void {
    this.stopInternal();
    this.engine.cancelScheduled();
  }

  private stopInternal(): void {
    this.running = false;
    if (this.worker) {
      this.worker.postMessage('stop');
      this.worker.terminate();
      this.worker = null;
    }
  }

  private tick(): void {
    if (!this.running) return;
    const horizon = this.engine.now() + LOOKAHEAD_SEC;
    while (this.pointer < this.flat.length) {
      const f = this.flat[this.pointer]!;
      const audioTime = this.anchorAudioTime + f.relSec;
      if (audioTime > horizon) break;
      this.engine.scheduleClick(audioTime, f.kind);
      this.onBeat?.({ ...f.beat, audioTime });
      this.pointer++;
    }
    if (this.pointer >= this.flat.length) {
      const last = this.flat[this.flat.length - 1];
      if (!last || this.engine.now() > this.anchorAudioTime + last.relSec + 0.3) {
        this.stopInternal();
        this.onEnded?.();
      }
    }
  }
}

/** 백그라운드 탭에서도 스로틀되지 않는 Worker 타이머 (인라인 Blob — 번들러 설정 불필요) */
function createTickWorker(): Worker {
  const code = `let id=null;onmessage=(e)=>{if(e.data==='start'){if(id===null)id=setInterval(()=>postMessage(0),${TICK_MS});}else{clearInterval(id);id=null;}};`;
  const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  return worker;
}
