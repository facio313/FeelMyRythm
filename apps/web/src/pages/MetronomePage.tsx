/** 메트로놈 메인 (UI_DESIGN.md §7.1). 빠른 모드 + 템포맵 모드(?map=로컬id 또는 ?rep=서버곡id) */
import {
  createDefaultTempoMap,
  sectionForMeasure,
  type NoteValue,
  type TempoMap,
} from '@feelmyrythm/core';
import type { ScheduledBeat } from '@feelmyrythm/audio';
import type { TempoMapOut } from '@feelmyrythm/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BeatVisualizer } from '../components/BeatVisualizer';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { listLocalMaps } from '../lib/localMaps';
import { useMetronome } from '../lib/useMetronome';

const TIME_SIGS = ['2/4', '3/4', '4/4', '5/4', '3/8', '6/8', '9/8', '12/8', '7/8'] as const;

function beatUnitFor(num: number, denom: number): NoteValue {
  if (denom === 8 && num % 3 === 0) return 'dottedQuarter';
  if (denom === 8) return 'eighth';
  if (denom === 2) return 'half';
  return 'quarter';
}

interface QuickSettings {
  bpm: number;
  timeSig: string;
  subdivision: 1 | 2 | 3 | 4;
  countIn: boolean;
}

function loadQuick(): QuickSettings {
  try {
    const v = JSON.parse(localStorage.getItem('fmr-quick') ?? '');
    if (v && typeof v.bpm === 'number') return v;
  } catch {
    // 기본값 사용
  }
  return { bpm: 100, timeSig: '4/4', subdivision: 1, countIn: true };
}

export default function MetronomePage() {
  const [params] = useSearchParams();
  const token = useAuth((s) => s.token);
  const { isRunning, timeline, queueRef, start, stop } = useMetronome();

  const [quick, setQuick] = useState<QuickSettings>(loadQuick);
  const [loadedMap, setLoadedMap] = useState<TempoMap | null>(null);
  const [startMeasure, setStartMeasure] = useState(1);
  const [display, setDisplay] = useState<{ measure: number | null; countIn: boolean }>({
    measure: null,
    countIn: false,
  });
  const [bpmEditing, setBpmEditing] = useState(false);
  const tapTimesRef = useRef<number[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    localStorage.setItem('fmr-quick', JSON.stringify(quick));
  }, [quick]);

  // ?map=<로컬id> 또는 ?rep=<서버 곡 id> 로 템포맵 로드
  useEffect(() => {
    const mapId = params.get('map');
    const repId = params.get('rep');
    const measure = Number(params.get('measure'));
    if (Number.isFinite(measure) && measure >= 1) setStartMeasure(measure);
    if (mapId) {
      const found = listLocalMaps().find((m) => m.id === mapId);
      if (found) setLoadedMap(found);
      else setError('로컬 템포맵을 찾을 수 없습니다');
    } else if (repId && token) {
      api<TempoMapOut>(`/api/repertoire/${repId}/tempomap`)
        .then((r) => setLoadedMap(r.data as TempoMap))
        .catch((e) => setError(e.message));
    }
  }, [params, token]);

  const quickMap = useMemo<TempoMap>(() => {
    const [num, denom] = quick.timeSig.split('/').map(Number) as [number, number];
    return createDefaultTempoMap({
      id: 'quick',
      totalMeasures: 1000,
      sections: [
        {
          id: 'q',
          startMeasure: 1,
          endMeasure: 1000,
          timeSignature: { num, denom },
          bpm: quick.bpm,
          beatUnit: beatUnitFor(num, denom),
          subdivision: quick.subdivision,
        },
      ],
      countIn: { measures: 1, useSectionMeter: true },
    });
  }, [quick]);

  const activeMap = loadedMap ?? quickMap;
  const isQuick = loadedMap === null;

  const handleStart = useCallback(async () => {
    setError('');
    try {
      await start(activeMap, {
        startMeasure: isQuick ? 1 : startMeasure,
        countIn: quick.countIn,
        loop: isQuick,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [activeMap, isQuick, startMeasure, quick.countIn, start]);

  const onDisplayBeat = useCallback((b: ScheduledBeat | null) => {
    setDisplay({ measure: b?.measureNumber ?? null, countIn: b?.isCountIn ?? false });
  }, []);

  const tapTempo = () => {
    const now = Date.now();
    const taps = tapTimesRef.current.filter((t) => now - t < 3000);
    taps.push(now);
    tapTimesRef.current = taps;
    if (taps.length >= 2) {
      const intervals = taps.slice(1).map((t, i) => t - taps[i]!);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const bpm = Math.min(400, Math.max(20, Math.round(60000 / avg)));
      setQuick((q) => ({ ...q, bpm }));
    }
  };

  // 현재/다음 구간 정보 (상황 인식, 설계문서 §9)
  const currentSection = display.measure !== null ? sectionForMeasure(activeMap, display.measure) : null;
  const nextChange = useMemo(() => {
    if (display.measure === null) return null;
    const next = activeMap.sections.find((s) => s.startMeasure > display.measure!);
    if (!next) return null;
    return { inMeasures: next.startMeasure - display.measure, bpm: next.bpm };
  }, [activeMap, display.measure]);

  return (
    <div className="flex flex-col items-center gap-6">
      {loadedMap && (
        <div className="chip">
          템포맵: {loadedMap.title ?? loadedMap.id} ({loadedMap.totalMeasures}마디)
          <button className="btn-ghost cursor-pointer" onClick={() => setLoadedMap(null)}>
            ✕ 빠른 모드로
          </button>
        </div>
      )}

      <div className="w-full max-w-2xl">
        <BeatVisualizer queueRef={queueRef} timeline={timeline} running={isRunning} onDisplayBeat={onDisplayBeat} />
      </div>

      {/* BPM 디스플레이 */}
      <div className="flex flex-col items-center gap-1">
        {bpmEditing && isQuick ? (
          <input
            autoFocus
            className="input bpm-display w-56 text-center"
            style={{ height: 'auto', fontSize: 72 }}
            defaultValue={quick.bpm}
            onBlur={(e) => {
              const v = Math.min(400, Math.max(20, Number(e.target.value) || quick.bpm));
              setQuick((q) => ({ ...q, bpm: v }));
              setBpmEditing(false);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <button className="bpm-display cursor-pointer border-0 bg-transparent" style={{ color: 'var(--text)' }} onClick={() => isQuick && setBpmEditing(true)}>
            {currentSection?.bpm ?? quick.bpm}
          </button>
        )}
        <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          ♩ = BPM · {currentSection ? `${currentSection.timeSignature.num}/${currentSection.timeSignature.denom}` : quick.timeSig}
        </div>
        <div className="tnum text-sm" style={{ color: 'var(--text-secondary)' }}>
          {display.countIn
            ? '예비박…'
            : display.measure !== null
              ? `마디 ${display.measure}${currentSection?.label ? ` · ${currentSection.label}` : ''}`
              : '\u00a0'}
          {nextChange && !display.countIn && (
            <span style={{ color: 'var(--accent)' }}> · {nextChange.inMeasures}마디 뒤 ♩={nextChange.bpm}</span>
          )}
        </div>
      </div>

      {/* 조작 영역 (하단 배치, UI_DESIGN.md §4) */}
      <div className="flex flex-wrap items-center justify-center gap-3">
        {isQuick && (
          <>
            <button className="btn" onClick={() => setQuick((q) => ({ ...q, bpm: Math.max(20, q.bpm - 5) }))}>
              −5
            </button>
            <button className="btn" onClick={() => setQuick((q) => ({ ...q, bpm: Math.min(400, q.bpm + 5) }))}>
              +5
            </button>
            <select
              className="select"
              value={quick.timeSig}
              onChange={(e) => setQuick((q) => ({ ...q, timeSig: e.target.value }))}
            >
              {TIME_SIGS.map((ts) => (
                <option key={ts}>{ts}</option>
              ))}
            </select>
            <select
              className="select"
              value={quick.subdivision}
              onChange={(e) => setQuick((q) => ({ ...q, subdivision: Number(e.target.value) as 1 | 2 | 3 | 4 }))}
            >
              <option value={1}>분할 없음</option>
              <option value={2}>2분할</option>
              <option value={3}>3분할</option>
              <option value={4}>4분할</option>
            </select>
            <button className="btn" onClick={tapTempo}>
              탭 템포
            </button>
          </>
        )}
        {!isQuick && (
          <label className="flex items-center gap-2 text-sm">
            시작 마디
            <input
              type="number"
              min={1}
              max={activeMap.totalMeasures}
              className="input tnum w-24"
              value={startMeasure}
              onChange={(e) => setStartMeasure(Number(e.target.value) || 1)}
            />
          </label>
        )}
        <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
          <input
            type="checkbox"
            checked={quick.countIn}
            onChange={(e) => setQuick((q) => ({ ...q, countIn: e.target.checked }))}
          />
          예비박
        </label>
      </div>

      <div className="flex items-center gap-4">
        {isRunning ? (
          <button className="btn btn-primary h-16 w-16 rounded-full text-xl" onClick={stop}>
            ■
          </button>
        ) : (
          <button className="btn btn-primary h-16 w-16 rounded-full text-xl" onClick={handleStart}>
            ▶
          </button>
        )}
      </div>

      {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}

      <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
        구간·박자 변화·반복이 있는 곡은 <Link to="/editor">템포맵 편집기</Link>에서 만들어 여세요.
      </div>
    </div>
  );
}
