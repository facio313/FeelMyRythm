/** 출력 지연 캘리브레이션 (설계문서 §6.5): 클릭에 맞춰 탭 → 중앙값 오프셋 저장 */
import { createDefaultTempoMap } from '@feelmyrythm/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getCalibrationMs, setCalibrationMs } from '../lib/localMaps';
import { getEngine, useMetronome } from '../lib/useMetronome';

export default function CalibrationPage() {
  const { isRunning, timeline, queueRef, start, stop } = useMetronome();
  const [taps, setTaps] = useState<number[]>([]);
  const [saved, setSaved] = useState(getCalibrationMs());
  const tapBtnRef = useRef<HTMLButtonElement>(null);

  const testMap = useMemo(
    () =>
      createDefaultTempoMap({
        id: 'calibration',
        totalMeasures: 200,
        sections: [
          {
            id: 'c',
            startMeasure: 1,
            endMeasure: 200,
            timeSignature: { num: 4, denom: 4 },
            bpm: 100,
            beatUnit: 'quarter',
          },
        ],
      }),
    [],
  );

  const median = useMemo(() => {
    if (taps.length === 0) return null;
    const sorted = [...taps].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }, [taps]);

  const onTap = () => {
    if (!isRunning) return;
    const now = getEngine().now();
    // 가장 가까운 예약 박과의 차이 (ms) — 양수면 탭이 늦음 = 소리가 늦게 남
    let best: number | null = null;
    for (const b of queueRef.current) {
      const diff = (now - b.audioTime) * 1000;
      if (best === null || Math.abs(diff) < Math.abs(best)) best = diff;
    }
    if (best !== null && Math.abs(best) < 300) setTaps((t) => [...t.slice(-19), best!]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        onTap();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6">
      <h1 className="section-title">출력 지연 캘리브레이션</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        클릭 소리가 <b>들리는 순간</b>에 맞춰 탭하세요 (8회 이상 권장). 블루투스 스피커는 지연이 크므로
        앙상블 모드에서는 유선/내장 스피커를 권장합니다.
      </p>

      {!isRunning ? (
        <button className="btn btn-primary" onClick={() => start(testMap, { countIn: false, loop: true })}>
          테스트 클릭 시작
        </button>
      ) : (
        <button className="btn btn-danger" onClick={stop}>
          정지
        </button>
      )}

      <button
        ref={tapBtnRef}
        className="btn h-28 w-28 rounded-full text-lg"
        disabled={!isRunning}
        onClick={onTap}
      >
        탭 (Space)
      </button>

      <div className="tnum text-sm" style={{ color: 'var(--text-secondary)' }}>
        수집 {taps.length}회 {median !== null && <>· 중앙값 {median.toFixed(0)}ms</>}
      </div>

      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          disabled={median === null || taps.length < 5}
          onClick={() => {
            setCalibrationMs(median!);
            setSaved(median!);
            setTaps([]);
            stop();
          }}
        >
          이 기기 오프셋으로 저장
        </button>
        <button className="btn" onClick={() => setTaps([])}>
          다시 측정
        </button>
      </div>

      <div className="chip tnum">현재 저장된 오프셋: {saved}ms</div>
      <div style={{ display: 'none' }}>{timeline?.totalDurationSec}</div>
    </div>
  );
}
