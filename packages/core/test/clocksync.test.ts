import { describe, expect, it } from 'vitest';
import { ClockSyncEstimator } from '../src/index';

/** 결정론적 의사난수 (LCG) */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

describe('ClockSyncEstimator', () => {
  it('지터 있는 네트워크에서 min-RTT 필터로 오프셋을 정확히 추정', () => {
    const trueOffsetMs = 123.4; // 서버 시계가 클라보다 123.4ms 앞섬
    const rand = lcg(42);
    const est = new ClockSyncEstimator();

    let clientNow = 1_000_000;
    for (let i = 0; i < 30; i++) {
      const dOut = 5 + rand() * 50; // 왕복 비대칭 지연
      const dIn = 5 + rand() * 50;
      const t0 = clientNow;
      const t1 = t0 + dOut + trueOffsetMs; // 서버 수신 시각 (서버 클럭)
      const t2 = t0 + dOut + dIn;
      est.addPingPong(t0, t1, t2);
      clientNow += 100;
    }

    expect(est.sampleCount).toBeGreaterThan(0);
    expect(Math.abs(est.offsetMs! - trueOffsetMs)).toBeLessThan(6);
  });

  it('서버↔클라 시각 변환이 일관됨', () => {
    const est = new ClockSyncEstimator();
    est.addPingPong(1000, 1150, 1020); // rtt 20, offset 140
    const server = est.clientToServerMs(2000);
    expect(est.serverToClientMs(server)).toBeCloseTo(2000, 9);
  });

  it('비정상 RTT 표본은 폐기', () => {
    const est = new ClockSyncEstimator({ maxRttMs: 100 });
    est.addPingPong(0, 5000, 10_000); // rtt 10초 → 폐기
    expect(est.offsetMs).toBeNull();
  });

  it('표본 없이 변환 시 명확한 에러', () => {
    const est = new ClockSyncEstimator();
    expect(() => est.serverToClientMs(0)).toThrow();
  });
});
