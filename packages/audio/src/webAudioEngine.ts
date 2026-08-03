import type { AudioEngine, ClickKind } from './engine';

/** 짧은 감쇠 톤 버스트 합성 — 외부 오디오 에셋 없이 클릭음 생성 */
function makeClickBuffer(ctx: AudioContext, freq: number, gain: number, durSec = 0.05): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * durSec);
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 90); // 빠른 감쇠 → 우드블록 느낌
    const tone = Math.sin(2 * Math.PI * freq * t) + 0.35 * Math.sin(2 * Math.PI * freq * 2 * t);
    data[i] = tone * env * gain;
  }
  return buf;
}

const CLICK_SPEC: Record<ClickKind, { freq: number; gain: number }> = {
  downbeat: { freq: 1568, gain: 1.0 }, // G6 — 강박
  beat: { freq: 1046, gain: 0.8 }, // C6
  sub: { freq: 784, gain: 0.35 }, // G5 — 분할박은 낮고 작게
  countIn: { freq: 2093, gain: 0.9 }, // C7 — 예비박은 확실히 구별
};

export class WebAudioEngine implements AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers: Partial<Record<ClickKind, AudioBuffer>> = {};
  private scheduled = new Set<AudioBufferSourceNode>();
  private volume = 1;

  async start(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      for (const kind of Object.keys(CLICK_SPEC) as ClickKind[]) {
        const { freq, gain } = CLICK_SPEC[kind];
        this.buffers[kind] = makeClickBuffer(this.ctx, freq, gain);
      }
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  stop(): void {
    this.cancelScheduled();
    void this.ctx?.suspend();
  }

  scheduleClick(atAudioTime: number, kind: ClickKind): void {
    if (!this.ctx || !this.master) throw new Error('AudioEngine이 시작되지 않았습니다');
    const buf = this.buffers[kind];
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.master);
    src.onended = () => this.scheduled.delete(src);
    this.scheduled.add(src);
    src.start(Math.max(atAudioTime, this.ctx.currentTime));
  }

  cancelScheduled(): void {
    for (const src of this.scheduled) {
      try {
        src.stop();
      } catch {
        // 이미 종료된 소스는 무시
      }
    }
    this.scheduled.clear();
  }

  now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  outputLatencySec(): number {
    if (!this.ctx) return 0;
    const anyCtx = this.ctx as AudioContext & { outputLatency?: number };
    return anyCtx.outputLatency ?? this.ctx.baseLatency ?? 0;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }
}
