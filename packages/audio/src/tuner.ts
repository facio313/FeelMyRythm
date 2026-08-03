/**
 * 튜너 엔진 (설계문서 §10).
 * 마이크 → MPM(McLeod Pitch Method, NSDF 기반) 피치 검출.
 */

export interface TunerReading {
  freqHz: number;
  /** 가장 가까운 평균율 음의 MIDI 번호 */
  midi: number;
  noteName: string;
  /** 그 음 기준 센트 편차 (-50 ~ +50) */
  cents: number;
  /** 검출 신뢰도 0~1 */
  clarity: number;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** NSDF(정규화 제곱차 함수) 기반 MPM 피치 검출. 단음 악기에 강건. */
export function detectPitchMpm(buf: Float32Array, sampleRate: number): { freqHz: number; clarity: number } | null {
  const n = buf.length;
  const maxTau = Math.min(n - 1, Math.floor(sampleRate / 50)); // 최저 50Hz
  const minTau = Math.floor(sampleRate / 2000); // 최고 2kHz

  const nsdf = new Float32Array(maxTau);
  for (let tau = minTau; tau < maxTau; tau++) {
    let acf = 0;
    let m = 0;
    for (let i = 0; i < n - tau; i++) {
      const a = buf[i]!;
      const b = buf[i + tau]!;
      acf += a * b;
      m += a * a + b * b;
    }
    nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
  }

  // 첫 음의 교차 이후의 키 맥시마 수집
  const maxima: { tau: number; value: number }[] = [];
  let tau = minTau;
  while (tau < maxTau && nsdf[tau]! > 0) tau++; // 초기 양수 구간 통과
  while (tau < maxTau) {
    while (tau < maxTau && nsdf[tau]! <= 0) tau++;
    let bestTau = tau;
    while (tau < maxTau && nsdf[tau]! > 0) {
      if (nsdf[tau]! > nsdf[bestTau]!) bestTau = tau;
      tau++;
    }
    if (bestTau < maxTau && nsdf[bestTau]! > 0) maxima.push({ tau: bestTau, value: nsdf[bestTau]! });
  }
  if (maxima.length === 0) return null;

  const highest = Math.max(...maxima.map((m) => m.value));
  const threshold = highest * 0.9;
  const pick = maxima.find((m) => m.value >= threshold)!;
  if (pick.value < 0.6) return null; // 노이즈

  // 포물선 보간으로 서브샘플 정밀도
  const t = pick.tau;
  const y1 = nsdf[t - 1] ?? pick.value;
  const y2 = pick.value;
  const y3 = nsdf[t + 1] ?? pick.value;
  const denom = 2 * (2 * y2 - y1 - y3);
  const shift = denom !== 0 ? (y3 - y1) / denom : 0;
  const period = t + shift;

  return { freqHz: sampleRate / period, clarity: pick.value };
}

export function freqToReading(freqHz: number, clarity: number, a4 = 440): TunerReading {
  const midiFloat = 69 + 12 * Math.log2(freqHz / a4);
  const midi = Math.round(midiFloat);
  const cents = (midiFloat - midi) * 100;
  const name = NOTE_NAMES[((midi % 12) + 12) % 12]!;
  const octave = Math.floor(midi / 12) - 1;
  return { freqHz, midi, noteName: `${name}${octave}`, cents, clarity };
}

export class TunerEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buf: Float32Array<ArrayBuffer> = new Float32Array(0);

  /** 기준음 A4 (Hz) — 오케스트라 프리셋 415/430/440/442/443 */
  a4 = 440;

  async start(onReading: (r: TunerReading | null) => void, intervalMs = 60): Promise<void> {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);

    this.timer = setInterval(() => {
      if (!this.analyser || !this.ctx) return;
      this.analyser.getFloatTimeDomainData(this.buf);
      const res = detectPitchMpm(this.buf, this.ctx.sampleRate);
      onReading(res ? freqToReading(res.freqHz, res.clarity, this.a4) : null);
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
    this.analyser = null;
  }
}
