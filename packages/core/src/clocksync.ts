/**
 * NTP 유사 시계 동기 추정기 (설계문서 §6.2).
 * PING/PONG 왕복 표본에서 min-RTT 필터로 서버-클라이언트 오프셋을 추정한다.
 * 순수 로직 — WebSocket 전송은 호출측 책임.
 */

export interface ClockSample {
  /** offset = t1 - (t0 + t2)/2  (serverTime ≈ clientTime + offset) */
  offsetMs: number;
  rttMs: number;
}

export interface ClockSyncOptions {
  /** 추정에 사용할 최근 표본 수 */
  windowSize?: number;
  /** 새 추정으로 이동하는 지수평활 계수 (0~1) */
  smoothing?: number;
  /** 이보다 RTT가 크면 표본 폐기 (ms) */
  maxRttMs?: number;
}

export class ClockSyncEstimator {
  private samples: ClockSample[] = [];
  private estimate: number | null = null;
  private readonly windowSize: number;
  private readonly smoothing: number;
  private readonly maxRttMs: number;

  constructor(opts: ClockSyncOptions = {}) {
    this.windowSize = opts.windowSize ?? 20;
    this.smoothing = opts.smoothing ?? 0.25;
    this.maxRttMs = opts.maxRttMs ?? 1000;
  }

  /**
   * @param t0 클라이언트 송신 시각 (클라 클럭, ms)
   * @param t1 서버 수신·응답 시각 (서버 클럭, ms)
   * @param t2 클라이언트 수신 시각 (클라 클럭, ms)
   */
  addPingPong(t0: number, t1: number, t2: number): void {
    const rttMs = t2 - t0;
    if (rttMs < 0 || rttMs > this.maxRttMs) return;
    this.samples.push({ offsetMs: t1 - (t0 + t2) / 2, rttMs });
    if (this.samples.length > this.windowSize) this.samples.shift();

    // min-RTT 표본의 offset이 가장 신뢰도 높음 (비대칭 지연 영향 최소)
    let best = this.samples[0]!;
    for (const s of this.samples) if (s.rttMs < best.rttMs) best = s;

    if (this.estimate === null) {
      this.estimate = best.offsetMs;
    } else {
      this.estimate += (best.offsetMs - this.estimate) * this.smoothing;
    }
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /** 최근 표본의 최소 RTT (연결 품질 표시용) */
  get minRttMs(): number | null {
    if (this.samples.length === 0) return null;
    return Math.min(...this.samples.map((s) => s.rttMs));
  }

  /** 추정 오프셋 (serverTime ≈ clientTime + offset). 표본 없으면 null */
  get offsetMs(): number | null {
    return this.estimate;
  }

  /** 서버 시각 → 클라이언트 시각 */
  serverToClientMs(serverMs: number): number {
    if (this.estimate === null) throw new Error('시계 동기 표본이 아직 없습니다');
    return serverMs - this.estimate;
  }

  /** 클라이언트 시각 → 서버 시각 */
  clientToServerMs(clientMs: number): number {
    if (this.estimate === null) throw new Error('시계 동기 표본이 아직 없습니다');
    return clientMs + this.estimate;
  }
}
