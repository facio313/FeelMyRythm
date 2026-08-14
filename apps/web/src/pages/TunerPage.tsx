import { TUNER_A4_PRESETS, TunerEngine, type TunerReading } from '@feelmyrythm/audio';
import { Button, Card, StatusBadge, useToast } from '@feelmyrythm/ui';
import { AlertTriangle, Mic, MicOff, Radio, Waves } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { PageHeader } from '../components/PageHeader';

export function TunerPage() {
  const { notify } = useToast();
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [a4, setA4] = useState(() => {
    const stored = Number(localStorage.getItem('fmr.tuner.a4') ?? 440);
    return TUNER_A4_PRESETS.some((preset) => preset === stored) ? stored : 440;
  });
  const [reading, setReading] = useState<TunerReading | null>(null);
  const [startError, setStartError] = useState<string>();
  const engineRef = useRef<TunerEngine | null>(null);
  const startRequestRef = useRef(0);
  const startPendingRef = useRef(false);
  const presetRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const tuner = new TunerEngine({ windowSize: 4096 });
    tuner.onReading = (nextReading) => {
      if (engineRef.current === tuner) setReading(nextReading);
    };
    engineRef.current = tuner;
    return () => {
      startRequestRef.current += 1;
      startPendingRef.current = false;
      tuner.onReading = null;
      tuner.stop();
      engineRef.current = null;
    };
  }, []);

  async function start() {
    const engine = engineRef.current;
    if (!engine || startPendingRef.current) return;
    const request = ++startRequestRef.current;
    startPendingRef.current = true;
    setStarting(true);
    engine.setA4(a4);
    setStartError(undefined);
    try {
      await engine.start();
      if (request !== startRequestRef.current || engineRef.current !== engine) {
        engine.stop();
        return;
      }
      setRunning(true);
    } catch (error) {
      if (request !== startRequestRef.current || engineRef.current !== engine) {
        engine.stop();
        return;
      }
      const description = error instanceof Error ? error.message : String(error);
      setStartError(description);
      notify({
        title: '마이크를 시작하지 못했습니다.',
        description,
        tone: 'danger',
      });
    } finally {
      if (request === startRequestRef.current && engineRef.current === engine) {
        startPendingRef.current = false;
        setStarting(false);
      }
    }
  }

  function stop() {
    startRequestRef.current += 1;
    startPendingRef.current = false;
    engineRef.current?.stop();
    setStarting(false);
    setRunning(false);
    setReading(null);
  }

  const setConcertA = (value: number) => {
    setA4(value);
    localStorage.setItem('fmr.tuner.a4', String(value));
    engineRef.current?.setA4(value);
  };

  const handlePresetKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (index - 1 + TUNER_A4_PRESETS.length) % TUNER_A4_PRESETS.length;
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (index + 1) % TUNER_A4_PRESETS.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = TUNER_A4_PRESETS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextPreset = TUNER_A4_PRESETS[nextIndex];
    if (nextPreset === undefined) return;
    setConcertA(nextPreset);
    presetRefs.current[nextIndex]?.focus();
  };

  const cents = Math.max(-50, Math.min(50, reading?.cents ?? 0));
  const inTune = reading !== null && Math.abs(reading.cents) <= 3;

  return (
    <div className="page page--narrow tuner-page">
      <PageHeader
        eyebrow="Chromatic tuner"
        title="튜너"
        description="AudioWorklet으로 수집한 단음 악기 신호를 YIN 알고리즘으로 분석합니다."
        actions={
          running ? (
            <StatusBadge tone="success">
              <Radio size={13} /> 마이크 사용 중
            </StatusBadge>
          ) : (
            <StatusBadge>마이크 꺼짐</StatusBadge>
          )
        }
      />
      {startError ? (
        <Card className="error-panel tuner-error" role="alert">
          <AlertTriangle size={20} aria-hidden />
          <div>
            <strong>마이크 권한을 확인해 주세요.</strong>
            <span>
              브라우저 또는 OS 설정에서 이 사이트의 마이크를 허용한 뒤 다시 시도하세요. {startError}
            </span>
          </div>
          <Button onClick={() => void start()}>다시 시도</Button>
        </Card>
      ) : null}
      <Card className="tuner-card">
        <div className="tuner-note" aria-live="polite" aria-atomic="true">
          <span className="tuner-note__name">{reading?.name ?? '—'}</span>
          <span className="tuner-note__octave">{reading?.octave ?? ''}</span>
        </div>
        <div
          className="tuner-meter"
          role="meter"
          aria-label="튜닝 편차"
          aria-valuemin={-50}
          aria-valuemax={50}
          aria-valuenow={reading ? cents : undefined}
          aria-valuetext={
            reading
              ? `${reading.cents >= 0 ? '+' : ''}${reading.cents.toFixed(1)} cent`
              : '음을 기다리는 중'
          }
        >
          <div className="tuner-meter__ticks" aria-hidden>
            {[-50, -25, 0, 25, 50].map((value) => (
              <span key={value} style={{ left: `${value + 50}%` }}>
                {value}
              </span>
            ))}
          </div>
          <div
            className={inTune ? 'tuner-needle tuner-needle--in-tune' : 'tuner-needle'}
            style={{
              left: `${cents + 50}%`,
              transform: `translateX(-50%) rotate(${cents * 0.8}deg)`,
            }}
          />
        </div>
        <div className="tuner-reading">
          <strong className="fmr-tabular">
            {reading
              ? `${reading.cents >= 0 ? '+' : ''}${reading.cents.toFixed(1)} cent`
              : '음을 연주하세요'}
          </strong>
          <span className="fmr-tabular">
            {reading
              ? `${reading.frequency.toFixed(2)} Hz · 명료도 ${Math.round(reading.clarity * 100)}%`
              : '50–2000 Hz'}
          </span>
        </div>
        <Button
          className="tuner-mic-button"
          variant={running ? 'danger' : 'primary'}
          disabled={starting}
          onClick={() => (running ? stop() : void start())}
        >
          {running ? <MicOff size={22} /> : <Mic size={22} />}
          {starting ? '마이크 권한 확인 중…' : running ? '마이크 끄기' : '튜닝 시작'}
        </Button>
      </Card>

      <Card className="concert-a-card">
        <div>
          <Waves size={22} aria-hidden />
          <span>
            <strong>기준음 A4</strong>
            <small>고악기·오케스트라 피치에 맞춰 선택하세요.</small>
          </span>
        </div>
        <div className="concert-a-options" role="radiogroup" aria-label="기준음 A4">
          {TUNER_A4_PRESETS.map((preset, index) => (
            <Button
              key={preset}
              ref={(element) => {
                presetRefs.current[index] = element;
              }}
              role="radio"
              aria-checked={a4 === preset}
              tabIndex={a4 === preset ? 0 : -1}
              variant={a4 === preset ? 'primary' : 'secondary'}
              onClick={() => setConcertA(preset)}
              onKeyDown={(event) => handlePresetKeyDown(event, index)}
            >
              <span className="fmr-tabular">{preset}</span>
            </Button>
          ))}
        </div>
      </Card>
    </div>
  );
}
