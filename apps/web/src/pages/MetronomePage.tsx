import { assertValidTempoMap, type TempoMap, type TempoSection } from '@feelmyrythm/core';
import type { components } from '@feelmyrythm/protocol';
import { BeatVisualizer, Button, Card, Modal, StatusBadge, useToast } from '@feelmyrythm/ui';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Expand,
  Gauge,
  Minus,
  Music2,
  Plus,
  Settings2,
  Shrink,
  SlidersHorizontal,
  Square,
  Volume2,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { localDb } from '../lib/localDb';
import { useMetronome } from '../lib/useMetronome';
import { createDefaultTempoMap } from '../lib/defaultTempoMap';

function meterBeatCount(section: TempoSection): number {
  return section.beatUnit === 'dottedQuarter'
    ? Math.max(1, Math.round(section.timeSignature.num / 3))
    : section.timeSignature.num;
}

export function normalizeBpm(value: number): number | null {
  if (!Number.isFinite(value) || value < 20 || value > 400) return null;
  return Math.round(value);
}

type TempoMapLoadState =
  | {
      status: 'local-loading' | 'local-ready' | 'remote-loading' | 'remote-ready';
    }
  | {
      status: 'local-error' | 'remote-cached' | 'remote-error';
      message: string;
    };

function isNetworkFailure(error: unknown): error is TypeError {
  return error instanceof TypeError;
}

export function MetronomePage() {
  const { notify } = useToast();
  const { user, client } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedMeasure = Number(searchParams.get('measure'));
  const repertoireItemId = searchParams.get('repertoire');
  const [map, setMap] = useState<TempoMap>(() => createDefaultTempoMap());
  const [startMeasure, setStartMeasure] = useState(() =>
    Number.isInteger(requestedMeasure) && requestedMeasure > 0 ? requestedMeasure : 1,
  );
  const [withCountIn, setWithCountIn] = useState(
    () => localStorage.getItem('fmr.countInEnabled') !== 'false',
  );
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('fmr.volume') ?? 0.75));
  const [fullscreen, setFullscreen] = useState(false);
  const [shortSettingsOpen, setShortSettingsOpen] = useState(false);
  const [tempoMapLoadAttempt, setTempoMapLoadAttempt] = useState(0);
  const [tempoMapLoadState, setTempoMapLoadState] = useState<TempoMapLoadState>({
    status: user && repertoireItemId ? 'remote-loading' : 'local-loading',
  });
  const tapsRef = useRef<number[]>([]);
  const fullscreenTapRef = useRef<number | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const persistenceTimerRef = useRef<number | undefined>(undefined);
  const metronome = useMetronome(map);
  const stopMetronome = metronome.stop;
  const validStartMeasure = Math.min(map.totalMeasures, Math.max(1, startMeasure));
  const usesRemoteMap = Boolean(user && repertoireItemId);
  const mapReadyForPlayback = usesRemoteMap
    ? (tempoMapLoadState.status === 'remote-ready' ||
        tempoMapLoadState.status === 'remote-cached') &&
      map.repertoireItemId === repertoireItemId
    : (tempoMapLoadState.status === 'local-ready' || tempoMapLoadState.status === 'local-error') &&
      map.repertoireItemId === 'local';
  const remoteMapLoading =
    usesRemoteMap &&
    tempoMapLoadState.status !== 'remote-ready' &&
    tempoMapLoadState.status !== 'remote-cached' &&
    tempoMapLoadState.status !== 'remote-error';
  const localMapLoading =
    !usesRemoteMap &&
    tempoMapLoadState.status !== 'local-ready' &&
    tempoMapLoadState.status !== 'local-error';

  useEffect(() => {
    let cancelled = false;
    stopMetronome();
    if (user && repertoireItemId) {
      type ServerTempoMap = components['schemas']['TempoMapOut'];
      queueMicrotask(() => {
        if (!cancelled) setTempoMapLoadState({ status: 'remote-loading' });
      });
      const remoteCacheScope = { userId: user.id };
      const cachedMap = localDb
        .getTempoMapForRepertoire(repertoireItemId, remoteCacheScope)
        .catch(() => undefined);
      void (async () => {
        try {
          const response = await client.get<ServerTempoMap>(
            `/repertoire/${encodeURIComponent(repertoireItemId)}/tempomap`,
          );
          const data: unknown = response.data;
          assertValidTempoMap(data);
          const nextMap: TempoMap = {
            ...data,
            repertoireItemId,
            revision: response.revision,
          };
          if (cancelled) return;
          setMap(nextMap);
          setTempoMapLoadState({ status: 'remote-ready' });
          void localDb.putTempoMap(nextMap, remoteCacheScope).catch((error: unknown) => {
            notify({
              title: '오프라인 템포맵 캐시를 저장하지 못했습니다.',
              description: error instanceof Error ? error.message : String(error),
              tone: 'neutral',
            });
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!isNetworkFailure(error)) {
            if (cancelled) return;
            setTempoMapLoadState({ status: 'remote-error', message });
            notify({
              title: '레퍼토리 템포맵을 불러오지 못했습니다.',
              description: message,
              tone: 'danger',
            });
            return;
          }
          let cached: TempoMap | undefined;
          try {
            cached = await cachedMap;
            if (cached) assertValidTempoMap(cached);
          } catch {
            cached = undefined;
          }
          if (cancelled) return;
          if (cached) {
            setMap(cached);
            setTempoMapLoadState({ status: 'remote-cached', message });
            notify({
              title: '저장된 템포맵으로 오프라인 연습을 엽니다.',
              description: message,
              tone: 'info',
            });
          } else {
            setTempoMapLoadState({ status: 'remote-error', message });
            notify({
              title: '레퍼토리 템포맵을 불러오지 못했습니다.',
              description: message,
              tone: 'danger',
            });
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    queueMicrotask(() => {
      if (cancelled) return;
      setMap(createDefaultTempoMap());
      setTempoMapLoadState({ status: 'local-loading' });
    });
    void localDb
      .listTempoMaps()
      .then((maps) => {
        if (cancelled) return;
        const localMaps = maps.filter((candidate) => candidate.repertoireItemId === 'local');
        const activeId = localStorage.getItem('fmr.activeTempoMap');
        const active = localMaps.find((candidate) => candidate.id === activeId) ?? localMaps[0];
        if (active) setMap(active);
        setTempoMapLoadState({ status: 'local-ready' });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setTempoMapLoadState({ status: 'local-error', message });
        notify({
          title: '이 기기의 템포맵을 불러오지 못했습니다.',
          description: message,
          tone: 'danger',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [client, notify, repertoireItemId, stopMetronome, tempoMapLoadAttempt, user]);

  useEffect(() => {
    let cancelled = false;
    const nextMeasure =
      Number.isInteger(requestedMeasure) && requestedMeasure > 0 ? requestedMeasure : 1;
    queueMicrotask(() => {
      if (!cancelled) setStartMeasure(nextMeasure);
    });
    return () => {
      cancelled = true;
    };
  }, [requestedMeasure]);

  useEffect(() => {
    const onFullscreen = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => document.removeEventListener('fullscreenchange', onFullscreen);
  }, []);

  useEffect(() => {
    document.title = '메트로놈 · FeelMyRythm';
  }, []);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(
    () => () => {
      if (persistenceTimerRef.current !== undefined) {
        window.clearTimeout(persistenceTimerRef.current);
      }
    },
    [],
  );

  const currentSection =
    map.sections.find(
      (section) =>
        metronome.position.measureNumber >= section.startMeasure &&
        metronome.position.measureNumber <= section.endMeasure,
    ) ?? map.sections[0]!;
  const nextSection = map.sections.find(
    (section) => section.startMeasure > metronome.position.measureNumber,
  );

  const updateSection = useCallback(
    (patch: Partial<TempoSection>) => {
      const next = {
        ...map,
        sections: map.sections.map((section) =>
          section.id === currentSection.id ? { ...section, ...patch } : section,
        ),
      };
      setMap(next);
      if (next.repertoireItemId === 'local') {
        if (persistenceTimerRef.current !== undefined) {
          window.clearTimeout(persistenceTimerRef.current);
        }
        persistenceTimerRef.current = window.setTimeout(() => {
          localStorage.setItem('fmr.activeTempoMap', next.id);
          void localDb.putTempoMap(next).catch((error: unknown) => {
            notify({
              title: '메트로놈 설정을 저장하지 못했습니다.',
              description: error instanceof Error ? error.message : String(error),
              tone: 'danger',
            });
          });
        }, 250);
      }
    },
    [currentSection.id, map, notify],
  );

  const setBpm = useCallback(
    (next: number) => {
      const normalized = normalizeBpm(next);
      if (normalized === null) return false;
      updateSection({ bpm: normalized });
      return true;
    },
    [updateSection],
  );

  const tapTempo = () => {
    const now = performance.now();
    const taps = tapsRef.current;
    if (taps.length > 0 && now - (taps.at(-1) ?? now) > 2000) taps.length = 0;
    taps.push(now);
    if (taps.length > 8) taps.shift();
    if (taps.length >= 2) {
      const intervals = taps.slice(1).map((value, index) => value - taps[index]!);
      const sorted = [...intervals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 500;
      setBpm(60_000 / median);
    }
  };

  const toggleAccent = (index: number) => {
    const count = meterBeatCount(currentSection);
    const pattern = Array.from(
      { length: count },
      (_, beat) => currentSection.accentPattern?.[beat] ?? (beat === 0 ? 2 : 1),
    );
    const value = pattern[index] ?? 0;
    pattern[index] = ((value + 1) % 3) as 0 | 1 | 2;
    updateSection({ accentPattern: pattern });
  };

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) await containerRef.current?.requestFullscreen();
      else await document.exitFullscreen();
    } catch (error) {
      notify({
        title: '보면대 모드를 전환하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  };

  const handleFullscreenTap = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!fullscreen || event.pointerType !== 'touch') return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('button, input, select, textarea, a, [role="button"]')
    ) {
      fullscreenTapRef.current = undefined;
      return;
    }
    const now = performance.now();
    if (fullscreenTapRef.current !== undefined && now - fullscreenTapRef.current <= 450) {
      fullscreenTapRef.current = undefined;
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch((error: unknown) => {
          notify({
            title: '보면대 모드를 종료하지 못했습니다.',
            description: error instanceof Error ? error.message : String(error),
            tone: 'danger',
          });
        });
      }
      return;
    }
    fullscreenTapRef.current = now;
  };

  const play = async () => {
    if (!mapReadyForPlayback) {
      notify({
        title: '템포맵을 준비한 뒤 재생할 수 있습니다.',
        tone: 'danger',
      });
      return;
    }
    try {
      await metronome.start(validStartMeasure, 1, withCountIn);
    } catch (error) {
      notify({
        title: '오디오를 시작하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  };

  const sectionBeatCount = meterBeatCount(currentSection);
  const accentPattern = Array.from(
    { length: sectionBeatCount },
    (_, index) => currentSection.accentPattern?.[index] ?? (index === 0 ? 2 : 1),
  );
  const contextLine = nextSection
    ? `${nextSection.startMeasure - metronome.position.measureNumber}마디 뒤 ♩=${nextSection.bpm}`
    : '마지막 구간';
  const settingsControls = (
    <>
      <div className="accent-editor">
        <span className="fmr-field__label">강세 패턴</span>
        <div>
          {accentPattern.map((accent, index) => (
            <button
              key={index}
              type="button"
              className={`accent-dot accent-dot--${accent}`}
              disabled={!mapReadyForPlayback}
              onClick={() => toggleAccent(index)}
              aria-label={`${index + 1}박 강세 ${accent}`}
            >
              {index + 1}
            </button>
          ))}
        </div>
      </div>
      <label className="range-field">
        <Volume2 size={18} aria-label="볼륨" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          disabled={!mapReadyForPlayback}
          onChange={(event) => {
            const next = Number(event.target.value);
            setVolume(next);
            metronome.setVolume(next);
          }}
        />
        <output>{Math.round(volume * 100)}%</output>
      </label>
      <label className="meter-select">
        <span className="fmr-field__label">박자</span>
        <select
          className="fmr-input"
          disabled={!mapReadyForPlayback}
          value={`${currentSection.timeSignature.num}/${currentSection.timeSignature.denom}`}
          onChange={(event) => {
            const [num, denom] = event.target.value.split('/').map(Number);
            updateSection({
              timeSignature: { num: num ?? 4, denom: denom ?? 4 },
              beatUnit: denom === 8 && (num ?? 0) % 3 === 0 ? 'dottedQuarter' : 'quarter',
            });
          }}
        >
          {['2/4', '3/4', '4/4', '5/4', '6/8', '9/8', '12/8'].map((meter) => (
            <option key={meter}>{meter}</option>
          ))}
        </select>
        <ChevronDown size={16} aria-hidden />
      </label>
    </>
  );

  return (
    <div
      ref={containerRef}
      className={fullscreen ? 'metronome-page metronome-page--fullscreen' : 'metronome-page'}
      data-count-in={metronome.position.isCountIn || undefined}
      data-beat-tone={
        metronome.position.isCountIn
          ? 'count-in'
          : metronome.position.beatIndex === 0
            ? 'downbeat'
            : 'beat'
      }
      data-beat-parity={metronome.position.beatIndex % 2 === 0 ? 'even' : 'odd'}
      onPointerUp={handleFullscreenTap}
    >
      <header className="metronome-heading">
        <div>
          <h1 ref={headingRef} className="sr-only" tabIndex={-1}>
            메트로놈
          </h1>
          <span className="eyebrow">Local performance</span>
          <div className="cluster">
            <Music2 size={18} aria-hidden />
            <strong>개인 연습</strong>
            <StatusBadge>{currentSection.label ?? 'Section'}</StatusBadge>
          </div>
        </div>
        <div className="cluster metronome-heading__actions">
          <Button
            className="metronome-heading__fullscreen"
            variant="ghost"
            onClick={() => void toggleFullscreen()}
          >
            {fullscreen ? <Shrink size={18} /> : <Expand size={18} />}
            {fullscreen ? '나가기' : '보면대 모드'}
          </Button>
          <Button
            className="metronome-heading__editor"
            variant="ghost"
            onClick={() => {
              void navigate(`/editor/${map.id}`);
            }}
          >
            <SlidersHorizontal size={18} /> 템포맵
          </Button>
          <Button
            className="metronome-heading__short-settings"
            variant="secondary"
            aria-haspopup="dialog"
            onClick={() => setShortSettingsOpen(true)}
          >
            <Settings2 size={18} /> 세부 설정
          </Button>
        </div>
      </header>

      {remoteMapLoading || localMapLoading ? (
        <div
          id="metronome-map-status"
          className="metronome-map-status"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          {remoteMapLoading
            ? '레퍼토리 템포맵을 불러오는 중입니다. 준비될 때까지 재생할 수 없습니다.'
            : '이 기기의 템포맵을 불러오는 중입니다. 준비될 때까지 재생할 수 없습니다.'}
        </div>
      ) : usesRemoteMap && tempoMapLoadState.status === 'remote-error' ? (
        <div id="metronome-map-status" className="metronome-map-status" role="alert">
          <span>템포맵을 불러오지 못했습니다: {tempoMapLoadState.message}</span>
          <Button
            size="compact"
            onClick={() => {
              setTempoMapLoadState({ status: 'remote-loading' });
              setTempoMapLoadAttempt((attempt) => attempt + 1);
            }}
          >
            다시 시도
          </Button>
        </div>
      ) : !usesRemoteMap && tempoMapLoadState.status === 'local-error' ? (
        <div id="metronome-map-status" className="metronome-map-status" role="alert">
          <span>
            이 기기의 템포맵을 불러오지 못해 기본 템포맵을 사용합니다: {tempoMapLoadState.message}
          </span>
          <Button
            size="compact"
            onClick={() => {
              setTempoMapLoadState({ status: 'local-loading' });
              setTempoMapLoadAttempt((attempt) => attempt + 1);
            }}
          >
            다시 시도
          </Button>
        </div>
      ) : usesRemoteMap && tempoMapLoadState.status === 'remote-cached' ? (
        <div id="metronome-map-status" className="metronome-map-status">
          <span role="status">서버에 연결할 수 없어 검증된 오프라인 캐시를 사용합니다.</span>
          <Button
            size="compact"
            onClick={() => {
              setTempoMapLoadState({ status: 'remote-loading' });
              setTempoMapLoadAttempt((attempt) => attempt + 1);
            }}
          >
            서버 다시 확인
          </Button>
        </div>
      ) : null}

      <section className="metronome-stage" aria-label="메트로놈 상태">
        <BeatVisualizer
          className="metronome-visualizer"
          running={metronome.playing}
          frameSource={metronome.frameSource}
          label="오디오 시계 기준 메트로놈 박"
        />
        <div className="bpm-display">
          <button
            type="button"
            aria-label={`현재 BPM ${currentSection.bpm}, 눌러서 직접 입력`}
            disabled={!mapReadyForPlayback}
            onClick={() => {
              const value = window.prompt('BPM', String(currentSection.bpm));
              if (value === null) return;
              if (!setBpm(Number(value))) {
                notify({
                  title: 'BPM은 20에서 400 사이의 숫자로 입력해 주세요.',
                  tone: 'danger',
                });
              }
            }}
          >
            <span className="fmr-tabular">{currentSection.bpm}</span>
          </button>
          <div>
            <span>{currentSection.beatUnit === 'dottedQuarter' ? '♩.' : '♩'} = BPM</span>
            <strong>
              {currentSection.timeSignature.num}/{currentSection.timeSignature.denom}
            </strong>
          </div>
        </div>
        <div className="performance-context">
          <strong className="fmr-tabular">
            {metronome.position.isCountIn
              ? `예비박 ${metronome.position.countdown ?? ''}`
              : `마디 ${metronome.position.measureNumber}`}
          </strong>
          <span>다음: {contextLine}</span>
        </div>
      </section>

      <section className="metronome-controls" aria-label="메트로놈 조작">
        <div
          className="bpm-steppers"
          inert={fullscreen ? true : undefined}
          aria-hidden={fullscreen || undefined}
        >
          <Button
            size="icon"
            aria-label="BPM 5 낮추기"
            disabled={!mapReadyForPlayback}
            onClick={() => setBpm(currentSection.bpm - 5)}
          >
            <ChevronLeft size={20} />
          </Button>
          <Button
            size="icon"
            aria-label="BPM 1 낮추기"
            disabled={!mapReadyForPlayback}
            onClick={() => setBpm(currentSection.bpm - 1)}
          >
            <Minus size={18} />
          </Button>
          <Button className="tap-button" onClick={tapTempo} disabled={!mapReadyForPlayback}>
            <Gauge size={18} /> 탭 템포
          </Button>
          <Button
            size="icon"
            aria-label="BPM 1 높이기"
            disabled={!mapReadyForPlayback}
            onClick={() => setBpm(currentSection.bpm + 1)}
          >
            <Plus size={18} />
          </Button>
          <Button
            size="icon"
            aria-label="BPM 5 높이기"
            disabled={!mapReadyForPlayback}
            onClick={() => setBpm(currentSection.bpm + 5)}
          >
            <ChevronRight size={20} />
          </Button>
        </div>

        <button
          type="button"
          className={metronome.playing ? 'play-button play-button--playing' : 'play-button'}
          aria-label={metronome.playing ? '메트로놈 정지' : '메트로놈 재생'}
          aria-describedby={!mapReadyForPlayback ? 'metronome-map-status' : undefined}
          disabled={!mapReadyForPlayback}
          onClick={() => (metronome.playing ? metronome.stop() : void play())}
        >
          {metronome.playing ? (
            <Square size={26} fill="currentColor" />
          ) : (
            <span className="play-triangle" aria-hidden />
          )}
        </button>

        <div
          className="quick-settings"
          inert={fullscreen ? true : undefined}
          aria-hidden={fullscreen || undefined}
        >
          <label>
            <span>시작</span>
            <input
              type="number"
              min={1}
              max={map.totalMeasures}
              value={validStartMeasure}
              onChange={(event) => setStartMeasure(Number(event.target.value))}
              disabled={metronome.playing || !mapReadyForPlayback}
            />
          </label>
          <Button
            variant={withCountIn ? 'primary' : 'secondary'}
            disabled={!mapReadyForPlayback}
            onClick={() =>
              setWithCountIn((current) => {
                const next = !current;
                localStorage.setItem('fmr.countInEnabled', String(next));
                return next;
              })
            }
            aria-pressed={withCountIn}
          >
            <Settings2 size={17} /> 예비박
          </Button>
        </div>
      </section>

      <Card
        className="metronome-settings"
        inert={fullscreen ? true : undefined}
        aria-hidden={fullscreen || undefined}
      >
        {settingsControls}
      </Card>

      <Modal
        open={shortSettingsOpen}
        onOpenChange={setShortSettingsOpen}
        title="메트로놈 세부 설정"
        description="짧은 화면에서도 강세 패턴, 볼륨, 박자를 조절할 수 있습니다."
      >
        <div className="metronome-settings-dialog">{settingsControls}</div>
      </Modal>
    </div>
  );
}
