/** 튜너 (설계문서 §10) — MPM 피치 검출, A4 프리셋 */
import { TunerEngine, type TunerReading } from '@feelmyrythm/audio';
import { useEffect, useRef, useState } from 'react';

const A4_PRESETS = [415, 430, 440, 442, 443];

export default function TunerPage() {
  const engineRef = useRef<TunerEngine | null>(null);
  const [active, setActive] = useState(false);
  const [reading, setReading] = useState<TunerReading | null>(null);
  const [a4, setA4] = useState(440);
  const [error, setError] = useState('');
  const holdRef = useRef<{ reading: TunerReading; at: number } | null>(null);

  useEffect(() => {
    return () => engineRef.current?.stop();
  }, []);

  const toggle = async () => {
    if (active) {
      engineRef.current?.stop();
      engineRef.current = null;
      setActive(false);
      setReading(null);
      return;
    }
    try {
      const engine = new TunerEngine();
      engine.a4 = a4;
      await engine.start((r) => {
        // 순간 끊김에도 표시 유지 (0.5초 홀드)
        if (r) {
          holdRef.current = { reading: r, at: Date.now() };
          setReading(r);
        } else if (holdRef.current && Date.now() - holdRef.current.at > 500) {
          setReading(null);
        }
      });
      engineRef.current = engine;
      setActive(true);
      setError('');
    } catch (e) {
      setError('마이크 권한이 필요합니다: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  useEffect(() => {
    if (engineRef.current) engineRef.current.a4 = a4;
  }, [a4]);

  const cents = reading?.cents ?? 0;
  const inTune = reading !== null && Math.abs(cents) < 5;

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-8">
      <h1 className="section-title">튜너</h1>

      <div
        className="flex h-40 w-40 flex-col items-center justify-center rounded-full border-4"
        style={{
          borderColor: inTune ? 'var(--success)' : reading ? 'var(--border)' : 'var(--border)',
          transition: 'border-color 0.2s',
        }}
      >
        <span className="tnum text-5xl font-extralight">{reading?.noteName ?? '—'}</span>
        <span className="tnum text-sm" style={{ color: 'var(--text-secondary)' }}>
          {reading ? `${reading.freqHz.toFixed(1)} Hz` : '대기 중'}
        </span>
      </div>

      {/* 센트 바늘 (±50) */}
      <div className="relative h-10 w-full max-w-sm">
        <div className="absolute inset-x-0 top-1/2 h-0.5" style={{ background: 'var(--border)' }} />
        <div className="absolute left-1/2 top-1 h-8 w-0.5 -translate-x-1/2" style={{ background: 'var(--text-muted)' }} />
        <div
          className="absolute top-0 h-10 w-1 rounded"
          style={{
            left: `calc(50% + ${Math.max(-50, Math.min(50, cents))}%)`,
            background: inTune ? 'var(--success)' : 'var(--accent)',
            opacity: reading ? 1 : 0.2,
          }}
        />
      </div>
      <div className="tnum text-sm" style={{ color: 'var(--text-secondary)' }}>
        {reading ? `${cents > 0 ? '+' : ''}${cents.toFixed(0)} cent` : '\u00a0'}
      </div>

      <div className="flex items-center gap-2">
        <span className="label m-0">A4 기준</span>
        {A4_PRESETS.map((v) => (
          <button
            key={v}
            className="btn"
            style={a4 === v ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
            onClick={() => setA4(v)}
          >
            {v}
          </button>
        ))}
      </div>

      <button className={active ? 'btn btn-danger' : 'btn btn-primary'} onClick={toggle}>
        {active ? '정지' : '튜너 시작'}
      </button>
      {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
    </div>
  );
}
