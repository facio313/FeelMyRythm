import { assertValidTempoMap, type TempoMap, type TempoSection } from '@feelmyrythm/core';
import type { components } from '@feelmyrythm/protocol';
import { BeatVisualizer, Button, Card, Field, Modal, StatusBadge, useToast } from '@feelmyrythm/ui';
import {
  Check,
  ChevronDown,
  Expand,
  Gauge,
  Music2,
  Settings2,
  Shrink,
  SlidersHorizontal,
  Square,
  Volume2,
  X,
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

const METER_OPTIONS = ['2/4', '3/4', '4/4', '5/4', '6/8', '9/8', '12/8'];

function meterBeatCount(section: TempoSection): number {
  return section.beatUnit === 'dottedQuarter'
    ? Math.max(1, Math.round(section.timeSignature.num / 3))
    : section.timeSignature.num;
}

function accentLabel(accent: number): '무음' | '보통' | '강박' {
  if (accent === 0) return '무음';
  if (accent === 2) return '강박';
  return '보통';
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
  const requestedLocalMapId = searchParams.get('tempoMap');
  const [map, setMap] = useState<TempoMap>(() => createDefaultTempoMap());
  const [startMeasure, setStartMeasure] = useState(() =>
    Number.isInteger(requestedMeasure) && requestedMeasure > 0 ? requestedMeasure : 1,
  );
  const [withCountIn, setWithCountIn] = useState(
    () => localStorage.getItem('fmr.countInEnabled') !== 'false',
  );
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('fmr.volume') ?? 0.75));
  const [fullscreen, setFullscreen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(() => window.innerWidth <= 839);
  const mobileStage = mobileViewport && !fullscreen;
  const [focused, setFocused] = useState(false);
  const mobileFocus = mobileStage && focused;
  const [bpmDialogOpen, setBpmDialogOpen] = useState(false);
  const [meterDialogOpen, setMeterDialogOpen] = useState(false);
  const [bpmDraft, setBpmDraft] = useState('');
  const [bpmError, setBpmError] = useState<string>();
  const [tapFeedback, setTapFeedback] = useState('');
  const [tapPadOpen, setTapPadOpen] = useState(false);
  const [shortSettingsOpen, setShortSettingsOpen] = useState(false);
  const [tempoMapLoadAttempt, setTempoMapLoadAttempt] = useState(0);
  const [tempoMapLoadState, setTempoMapLoadState] = useState<TempoMapLoadState>({
    status: user && repertoireItemId ? 'remote-loading' : 'local-loading',
  });
  const tapsRef = useRef<number[]>([]);
  const fullscreenTapRef = useRef<number | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const bpmTriggerRef = useRef<HTMLButtonElement>(null);
  const bpmInputRef = useRef<HTMLInputElement>(null);
  const meterTriggerRef = useRef<HTMLButtonElement>(null);
  const numberTriggerRef = useRef<HTMLButtonElement>(null);
  const shortSettingsTriggerRef = useRef<HTMLButtonElement>(null);
  const tapTriggerRef = useRef<HTMLButtonElement>(null);
  const tapPadRef = useRef<HTMLButtonElement>(null);
  const tapFeedbackFrameRef = useRef<number | undefined>(undefined);
  const tapFeedbackExpiresAtRef = useRef(0);
  const persistenceTimerRef = useRef<number | undefined>(undefined);
  const metronome = useMetronome(map);
  const stopMetronome = metronome.stop;
  const validStartMeasure = Math.min(map.totalMeasures, Math.max(1, startMeasure));
  const usesRemoteMap = Boolean(user && repertoireItemId);
  const mapReadyForPlayback = usesRemoteMap
    ? (tempoMapLoadState.status === 'remote-ready' ||
        tempoMapLoadState.status === 'remote-cached') &&
      map.repertoireItemId === repertoireItemId
    : (tempoMapLoadState.status === 'local-ready' ||
        (tempoMapLoadState.status === 'local-error' && !requestedLocalMapId)) &&
      map.repertoireItemId === 'local' &&
      (!requestedLocalMapId || map.id === requestedLocalMapId);
  const remoteMapLoading =
    usesRemoteMap &&
    tempoMapLoadState.status !== 'remote-ready' &&
    tempoMapLoadState.status !== 'remote-cached' &&
    tempoMapLoadState.status !== 'remote-error';
  const localMapLoading =
    !usesRemoteMap &&
    tempoMapLoadState.status !== 'local-ready' &&
    tempoMapLoadState.status !== 'local-error';

  const resetTapMeasurement = useCallback(() => {
    tapsRef.current.length = 0;
    setTapFeedback('');
    if (tapFeedbackFrameRef.current !== undefined) {
      window.cancelAnimationFrame(tapFeedbackFrameRef.current);
      tapFeedbackFrameRef.current = undefined;
    }
  }, []);

  const handleTapPadOpenChange = useCallback(
    (open: boolean) => {
      resetTapMeasurement();
      setTapPadOpen(open);
      if (!open) queueMicrotask(() => tapTriggerRef.current?.focus());
    },
    [resetTapMeasurement],
  );

  useEffect(() => {
    if (tapPadOpen && mobileStage) tapPadRef.current?.focus();
  }, [tapPadOpen, mobileStage]);

  useEffect(() => {
    const updateViewport = () => {
      const mobile = window.innerWidth <= 839;
      setMobileViewport(mobile);
      if (!mobile) setFocused(false);
      if (!mobile && tapPadOpen) handleTapPadOpenChange(false);
    };
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, [handleTapPadOpenChange, tapPadOpen]);

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
        const activeId = requestedLocalMapId ?? localStorage.getItem('fmr.activeTempoMap');
        const active =
          localMaps.find((candidate) => candidate.id === activeId) ??
          (requestedLocalMapId ? undefined : localMaps[0]);
        if (requestedLocalMapId && !active) {
          throw new Error('선택한 템포맵을 이 기기에서 찾지 못했습니다. 편집기에서 저장해 주세요.');
        }
        if (active) {
          assertValidTempoMap(active);
          setMap(active);
          if (requestedLocalMapId) localStorage.setItem('fmr.activeTempoMap', active.id);
        }
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
  }, [
    client,
    notify,
    repertoireItemId,
    requestedLocalMapId,
    stopMetronome,
    tempoMapLoadAttempt,
    user,
  ]);

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
    const onFullscreen = () => {
      const active = document.fullscreenElement === containerRef.current;
      setFullscreen(active);
      if (active && tapPadOpen) {
        resetTapMeasurement();
        setTapPadOpen(false);
      }
    };
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => document.removeEventListener('fullscreenchange', onFullscreen);
  }, [resetTapMeasurement, tapPadOpen]);

  useEffect(() => {
    if (!fullscreen && !mobileFocus) return undefined;

    const shellChrome = [
      ...document.querySelectorAll<HTMLElement>(
        '.app-shell > .skip-link, .app-shell > .topbar, .app-shell > .sidebar, .app-shell > .bottom-nav',
      ),
    ];
    const previous = shellChrome.map((element) => ({
      element,
      ariaHidden: element.getAttribute('aria-hidden'),
      inert: element.inert,
    }));
    for (const element of shellChrome) {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }

    return () => {
      for (const state of previous) {
        state.element.inert = state.inert;
        if (state.ariaHidden === null) state.element.removeAttribute('aria-hidden');
        else state.element.setAttribute('aria-hidden', state.ariaHidden);
      }
    };
  }, [fullscreen, mobileFocus]);

  useEffect(() => {
    if (!mobileFocus || bpmDialogOpen || meterDialogOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event
          .composedPath()
          .some(
            (element) => element instanceof Element && element.getAttribute('role') === 'dialog',
          )
      )
        return;
      event.preventDefault();
      setFocused(false);
      numberTriggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [bpmDialogOpen, meterDialogOpen, mobileFocus]);

  useEffect(() => {
    document.title = '메트로놈 · FeelMyRythm';
  }, []);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(
    () => () => {
      if (tapFeedbackFrameRef.current !== undefined) {
        window.cancelAnimationFrame(tapFeedbackFrameRef.current);
      }
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

  const openEditor = async () => {
    if (!mapReadyForPlayback) return;
    if (usesRemoteMap) {
      void navigate(`/editor/${encodeURIComponent(map.repertoireItemId)}`);
      return;
    }
    if (persistenceTimerRef.current !== undefined) {
      window.clearTimeout(persistenceTimerRef.current);
      persistenceTimerRef.current = undefined;
    }
    try {
      await localDb.putTempoMap(map);
      localStorage.setItem('fmr.activeTempoMap', map.id);
      void navigate(`/editor/${encodeURIComponent(map.id)}?source=local`);
    } catch (error) {
      notify({
        title: '편집할 템포맵을 저장하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  };

  const setBpm = useCallback(
    (next: number) => {
      const normalized = normalizeBpm(next);
      if (normalized === null) return false;
      updateSection({ bpm: normalized });
      return true;
    },
    [updateSection],
  );

  const stepBpm = useCallback(
    (amount: number) => setBpm(Math.min(400, Math.max(20, currentSection.bpm + amount))),
    [currentSection.bpm, setBpm],
  );

  const setMeter = (meter: string) => {
    const [num, denom] = meter.split('/').map(Number);
    const nextSection: TempoSection = {
      ...currentSection,
      timeSignature: { num: num ?? 4, denom: denom ?? 4 },
      beatUnit: denom === 8 && (num ?? 0) % 3 === 0 ? 'dottedQuarter' : 'quarter',
    };
    updateSection({
      timeSignature: nextSection.timeSignature,
      beatUnit: nextSection.beatUnit,
      accentPattern: Array.from(
        { length: meterBeatCount(nextSection) },
        (_, beat) => currentSection.accentPattern?.[beat] ?? (beat === 0 ? 2 : 1),
      ),
    });
  };

  const handleMeterDialogOpenChange = useCallback((open: boolean) => {
    setMeterDialogOpen(open);
    if (!open) {
      queueMicrotask(() => (meterTriggerRef.current ?? headingRef.current)?.focus());
    }
  }, []);

  const toggleMobileFocus = () => {
    resetTapMeasurement();
    setTapPadOpen(false);
    setFocused((current) => !current);
  };

  const handleBpmDialogOpenChange = useCallback((open: boolean) => {
    setBpmDialogOpen(open);
    if (!open) {
      setBpmError(undefined);
      queueMicrotask(() => bpmTriggerRef.current?.focus());
    }
  }, []);

  const handleShortSettingsOpenChange = useCallback((open: boolean) => {
    setShortSettingsOpen(open);
    if (!open) {
      queueMicrotask(() => {
        const focusIfAvailable = (element: HTMLElement | null): boolean => {
          if (
            !element ||
            element.matches(':disabled') ||
            element.closest('[inert], [aria-hidden="true"]') ||
            window.getComputedStyle(element).display === 'none' ||
            window.getComputedStyle(element).visibility === 'hidden'
          ) {
            return false;
          }
          element.focus({ preventScroll: true });
          return document.activeElement === element;
        };

        if (focusIfAvailable(shortSettingsTriggerRef.current)) return;
        const inlineSetting =
          containerRef.current?.querySelector<HTMLElement>(
            '.quick-settings input:not(:disabled), .metronome-settings button:not(:disabled), .metronome-settings input:not(:disabled), .metronome-settings select:not(:disabled)',
          ) ?? null;
        if (!focusIfAvailable(inlineSetting)) headingRef.current?.focus({ preventScroll: true });
      });
    }
  }, []);

  useEffect(() => {
    if (!bpmDialogOpen) return undefined;

    const frame = window.requestAnimationFrame(() => {
      const input = bpmInputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      const dialog = input.closest<HTMLElement>('.fmr-dialog__content');
      if (!dialog) {
        input.scrollIntoView?.({ block: 'center', inline: 'nearest' });
        return;
      }

      const inputRect = input.getBoundingClientRect();
      const dialogRect = dialog.getBoundingClientRect();
      const focusMargin = 4;
      const visibleTop = Math.max(dialogRect.top, 0) + focusMargin;
      const visibleBottom = Math.min(dialogRect.bottom, window.innerHeight) - focusMargin;
      if (inputRect.bottom > visibleBottom) {
        dialog.scrollTop += inputRect.bottom - visibleBottom;
      } else if (inputRect.top < visibleTop) {
        dialog.scrollTop -= visibleTop - inputRect.top;
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [bpmDialogOpen]);

  const tapTempo = () => {
    const now = performance.now();
    const taps = tapsRef.current;
    if (taps.length > 0 && now - (taps.at(-1) ?? now) > 2000) taps.length = 0;
    taps.push(now);
    if (taps.length > 8) taps.shift();
    setTapFeedback(taps.length === 1 ? '다시 탭' : `${taps.length}회`);
    tapFeedbackExpiresAtRef.current = now + 2000;
    if (tapFeedbackFrameRef.current !== undefined) {
      window.cancelAnimationFrame(tapFeedbackFrameRef.current);
    }
    const clearExpiredFeedback = (frameTime: number) => {
      if (frameTime >= tapFeedbackExpiresAtRef.current) {
        tapsRef.current.length = 0;
        setTapFeedback('');
        tapFeedbackFrameRef.current = undefined;
        return;
      }
      tapFeedbackFrameRef.current = window.requestAnimationFrame(clearExpiredFeedback);
    };
    tapFeedbackFrameRef.current = window.requestAnimationFrame(clearExpiredFeedback);
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

  const playControl = (
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
  );

  const bpmStep = (amount: number) => (
    <Button
      size="icon"
      aria-label={`BPM ${Math.abs(amount)} ${amount < 0 ? '낮추기' : '높이기'}`}
      disabled={
        !mapReadyForPlayback || (amount < 0 ? currentSection.bpm <= 20 : currentSection.bpm >= 400)
      }
      onClick={() => stepBpm(amount)}
    >
      <span className="bpm-stepper__amount" aria-hidden>
        {amount < 0 ? '−' : '+'}
        {Math.abs(amount)}
      </span>
    </Button>
  );

  const sectionBeatCount = meterBeatCount(currentSection);
  const accentPattern = Array.from(
    { length: sectionBeatCount },
    (_, index) => currentSection.accentPattern?.[index] ?? (index === 0 ? 2 : 1),
  );
  const contextLine = nextSection
    ? `${nextSection.startMeasure - metronome.position.measureNumber}마디 뒤 ♩=${nextSection.bpm}`
    : '마지막 구간';
  const performanceContext = (
    <div className="performance-context">
      <strong className="fmr-tabular">
        {metronome.position.isWaiting
          ? `마디 ${metronome.position.measureNumber} · 시작 대기`
          : metronome.position.isCountIn
            ? `마디 ${metronome.position.measureNumber} · 예비박 ${metronome.position.countdown ?? ''}`
            : `마디 ${metronome.position.measureNumber}`}
      </strong>
      {!mobileStage || nextSection ? <span>다음: {contextLine}</span> : null}
    </div>
  );
  const settingsControls = (
    <>
      <div className="accent-editor">
        <span className="fmr-field__label">강세 패턴</span>
        <span className="accent-editor__hint">눌러 무음 → 보통 → 강박 순환</span>
        <div>
          {accentPattern.map((accent, index) => {
            const currentLabel = accentLabel(accent);
            const nextLabel = accentLabel((accent + 1) % 3);
            return (
              <button
                key={index}
                type="button"
                className={`accent-dot accent-dot--${accent}`}
                disabled={!mapReadyForPlayback}
                onClick={() => toggleAccent(index)}
                aria-label={`${index + 1}박, ${currentLabel}. 누르면 ${nextLabel}으로 변경`}
                title={`${index + 1}박 ${currentLabel}`}
              >
                {index + 1}
              </button>
            );
          })}
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
      <Button
        className="count-in-button"
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
        aria-label="예비박"
      >
        {withCountIn ? <Check size={17} aria-hidden /> : <Settings2 size={17} aria-hidden />}
        <span className="count-in-button__label">예비박</span>
        <span className="count-in-button__state">{withCountIn ? '켬' : '끔'}</span>
      </Button>
      <label className="meter-select">
        <span className="fmr-field__label">박자</span>
        <span className="meter-select__control">
          <select
            className="fmr-input"
            disabled={!mapReadyForPlayback}
            value={`${currentSection.timeSignature.num}/${currentSection.timeSignature.denom}`}
            onChange={(event) => setMeter(event.target.value)}
          >
            {METER_OPTIONS.map((meter) => (
              <option key={meter}>{meter}</option>
            ))}
          </select>
          <ChevronDown size={18} aria-hidden />
        </span>
      </label>
    </>
  );

  return (
    <div
      ref={containerRef}
      className={[
        'metronome-page',
        fullscreen && 'metronome-page--fullscreen',
        mobileStage && 'metronome-page--screen-progress',
        mobileFocus && 'metronome-page--focused',
      ]
        .filter(Boolean)
        .join(' ')}
      data-count-in={metronome.position.isCountIn || undefined}
      data-beat-tone={
        metronome.position.isCountIn
          ? 'count-in'
          : metronome.position.beatIndex === 0
            ? 'downbeat'
            : 'beat'
      }
      data-playing={(metronome.playing && !metronome.position.isWaiting) || undefined}
      onPointerUp={handleFullscreenTap}
    >
      {mobileStage ? (
        <BeatVisualizer
          className="metronome-screen-progress"
          variant="progress"
          showProgress
          running={metronome.playing}
          frameSource={metronome.frameSource}
        />
      ) : null}
      <header
        className="metronome-heading"
        inert={mobileFocus || undefined}
        aria-hidden={mobileFocus || undefined}
      >
        <h1 ref={headingRef} className="sr-only" tabIndex={-1}>
          메트로놈
        </h1>
        <div className="metronome-heading__context" aria-hidden={fullscreen || undefined}>
          <span className="eyebrow">Local performance</span>
          <div className="cluster">
            <Music2 size={18} aria-hidden />
            <strong>개인 연습</strong>
            <StatusBadge>{currentSection.label ?? 'Section'}</StatusBadge>
          </div>
        </div>
        {mobileStage ? performanceContext : null}
        <div className="cluster metronome-heading__actions">
          {!mobileStage ? (
            <Button
              className="metronome-heading__fullscreen"
              variant="ghost"
              onClick={() => void toggleFullscreen()}
            >
              {fullscreen ? <Shrink size={18} /> : <Expand size={18} />}
              {fullscreen ? '나가기' : '보면대 모드'}
            </Button>
          ) : null}
          <Button
            className="metronome-heading__editor"
            variant="ghost"
            inert={fullscreen ? true : undefined}
            aria-hidden={fullscreen || undefined}
            disabled={!mapReadyForPlayback}
            onClick={() => void openEditor()}
          >
            <SlidersHorizontal size={18} /> 템포맵
          </Button>
          <Button
            ref={shortSettingsTriggerRef}
            className="metronome-heading__short-settings"
            variant="secondary"
            aria-haspopup="dialog"
            aria-label="세부 설정"
            inert={fullscreen ? true : undefined}
            aria-hidden={fullscreen || undefined}
            onClick={() => handleShortSettingsOpenChange(true)}
          >
            <Settings2 size={18} aria-hidden />
            <span className="metronome-heading__settings-label">세부 설정</span>
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
          <span>
            {remoteMapLoading
              ? '레퍼토리 템포맵을 불러오는 중입니다. 준비될 때까지 재생할 수 없습니다.'
              : '이 기기의 템포맵을 불러오는 중입니다. 준비될 때까지 재생할 수 없습니다.'}
          </span>
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
            {requestedLocalMapId
              ? '선택한 템포맵을 불러오지 못했습니다'
              : '이 기기의 템포맵을 불러오지 못해 기본 템포맵을 사용합니다'}
            : {tempoMapLoadState.message}
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
        {mobileStage ? (
          <button
            ref={numberTriggerRef}
            type="button"
            className="metronome-number"
            aria-label={mobileFocus ? '집중 화면 나가기' : '집중 화면'}
            aria-pressed={mobileFocus}
            disabled={!mapReadyForPlayback}
            onClick={toggleMobileFocus}
          >
            <BeatVisualizer
              className="metronome-number__visualizer"
              variant="number"
              numberScale={0.8}
              showProgress={false}
              progressStyle="background"
              running={metronome.playing}
              frameSource={metronome.frameSource}
              label="현재 박 숫자"
            />
          </button>
        ) : null}
        <BeatVisualizer
          className="metronome-visualizer"
          showProgress={!mobileStage}
          running={metronome.playing}
          frameSource={metronome.frameSource}
          label="오디오 시계 기준 메트로놈 박"
        />
        <div className={mobileStage ? 'bpm-display bpm-display--mobile' : 'bpm-display'}>
          <button
            ref={bpmTriggerRef}
            type="button"
            className="bpm-display__value"
            aria-label={`현재 BPM ${currentSection.bpm}, 눌러서 직접 입력`}
            inert={fullscreen ? true : undefined}
            aria-hidden={fullscreen || undefined}
            disabled={!mapReadyForPlayback}
            onClick={() => {
              setBpmDraft(String(currentSection.bpm));
              setBpmError(undefined);
              setBpmDialogOpen(true);
            }}
          >
            <span className="fmr-tabular">{currentSection.bpm}</span>
          </button>
          {fullscreen ? (
            <span className="sr-only" role="status">
              현재 BPM {currentSection.bpm}, {currentSection.timeSignature.num}/
              {currentSection.timeSignature.denom}박자
            </span>
          ) : null}
          {mobileStage ? (
            <button
              ref={meterTriggerRef}
              type="button"
              className="bpm-display__meter"
              aria-label={`현재 ${currentSection.timeSignature.num}/${currentSection.timeSignature.denom}박자, 눌러서 선택`}
              aria-haspopup="dialog"
              disabled={!mapReadyForPlayback}
              onClick={() => handleMeterDialogOpenChange(true)}
            >
              <span>
                {currentSection.timeSignature.num}/{currentSection.timeSignature.denom}
              </span>
            </button>
          ) : (
            <div>
              <span>{currentSection.beatUnit === 'dottedQuarter' ? 'BPM (♩.)' : 'BPM'}</span>
              <span aria-hidden>·</span>
              <strong>
                {currentSection.timeSignature.num}/{currentSection.timeSignature.denom}
              </strong>
            </div>
          )}
        </div>
        {!mobileStage ? performanceContext : null}
      </section>

      <section className="metronome-controls" aria-label="메트로놈 조작">
        {mobileFocus ? (
          playControl
        ) : mobileStage ? (
          tapPadOpen ? (
            <div
              className="tap-tempo-panel"
              role="group"
              aria-label="탭 템포 입력"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  handleTapPadOpenChange(false);
                }
              }}
            >
              <button
                ref={tapPadRef}
                type="button"
                className="tap-tempo-pad"
                aria-label="박자에 맞춰 탭"
                data-feedback={tapFeedback || undefined}
                onClick={tapTempo}
                disabled={!mapReadyForPlayback}
              >
                <span aria-hidden>{tapFeedback || '박자에 맞춰 탭'}</span>
                <small aria-hidden>두 번 이상 두드리세요</small>
              </button>
              <Button
                className="tap-tempo-panel__close"
                size="icon"
                variant="ghost"
                aria-label="탭 템포 닫기"
                onClick={() => handleTapPadOpenChange(false)}
              >
                <X size={16} aria-hidden />
              </Button>
            </div>
          ) : (
            <div className="metronome-mobile-controls">
              {bpmStep(-5)}
              {playControl}
              {bpmStep(5)}
              <Button
                ref={tapTriggerRef}
                className="tap-button"
                aria-label="탭 템포"
                onClick={() => handleTapPadOpenChange(true)}
                disabled={!mapReadyForPlayback}
              >
                탭
              </Button>
            </div>
          )
        ) : (
          <>
            {playControl}
            <div
              className="bpm-steppers"
              inert={fullscreen ? true : undefined}
              aria-hidden={fullscreen || undefined}
            >
              {bpmStep(-5)}
              {bpmStep(-1)}
              <Button
                ref={tapTriggerRef}
                className="tap-button"
                aria-label="탭 템포"
                data-feedback={tapFeedback || undefined}
                onClick={tapTempo}
                disabled={!mapReadyForPlayback}
              >
                <Gauge size={18} aria-hidden />
                <span className="tap-button__visible-label" aria-hidden>
                  {tapFeedback || (
                    <>
                      탭<span className="tap-button__optional-label"> 템포</span>
                    </>
                  )}
                </span>
              </Button>
              {bpmStep(1)}
              {bpmStep(5)}
            </div>
          </>
        )}

        {tapFeedback ? (
          <span className="sr-only tap-tempo-feedback" role="status" aria-live="polite">
            {tapFeedback === '다시 탭'
              ? '첫 탭을 인식했습니다. 다시 탭하세요.'
              : `탭 템포 ${tapFeedback} 입력했습니다.`}
          </span>
        ) : null}

        <div
          className="quick-settings"
          inert={fullscreen || mobileFocus || undefined}
          aria-hidden={fullscreen || mobileFocus || undefined}
          hidden={mobileFocus || (mobileStage && tapPadOpen)}
        >
          <label>
            <span>시작 마디</span>
            <input
              type="number"
              min={1}
              max={map.totalMeasures}
              value={validStartMeasure}
              onChange={(event) => setStartMeasure(Number(event.target.value))}
              disabled={metronome.playing || !mapReadyForPlayback}
            />
          </label>
        </div>
      </section>

      <Card
        className="metronome-settings"
        inert={fullscreen || mobileFocus || undefined}
        aria-hidden={fullscreen || mobileFocus || undefined}
      >
        {settingsControls}
      </Card>

      <Modal
        open={bpmDialogOpen}
        onOpenChange={handleBpmDialogOpenChange}
        title="BPM 직접 입력"
        description="20에서 400 사이의 정수로 입력하세요."
      >
        <form
          className="bpm-entry-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const parsedBpm = Number(bpmDraft);
            if (!Number.isInteger(parsedBpm) || !setBpm(parsedBpm)) {
              setBpmError('20에서 400 사이의 정수를 입력해 주세요.');
              return;
            }
            handleBpmDialogOpenChange(false);
          }}
        >
          <Field
            ref={bpmInputRef}
            label="BPM"
            type="number"
            inputMode="numeric"
            min={20}
            max={400}
            step={1}
            value={bpmDraft}
            {...(bpmError ? { error: bpmError } : {})}
            onChange={(event) => {
              setBpmDraft(event.target.value);
              setBpmError(undefined);
            }}
          />
          <div className="bpm-entry-actions">
            <Button type="button" onClick={() => handleBpmDialogOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" variant="primary">
              적용
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={meterDialogOpen} onOpenChange={handleMeterDialogOpenChange} title="박자 선택">
        <div className="meter-options">
          {METER_OPTIONS.map((meter) => (
            <Button
              key={meter}
              aria-label={`${meter}박자`}
              aria-pressed={
                meter ===
                `${currentSection.timeSignature.num}/${currentSection.timeSignature.denom}`
              }
              variant={
                meter ===
                `${currentSection.timeSignature.num}/${currentSection.timeSignature.denom}`
                  ? 'primary'
                  : 'secondary'
              }
              disabled={!mapReadyForPlayback}
              onClick={() => {
                setMeter(meter);
                handleMeterDialogOpenChange(false);
              }}
            >
              {meter}
            </Button>
          ))}
        </div>
      </Modal>

      <Modal
        open={shortSettingsOpen}
        onOpenChange={handleShortSettingsOpenChange}
        title="메트로놈 세부 설정"
        description="시작 마디, 예비박, 강세 패턴, 볼륨과 박자를 조절할 수 있습니다."
      >
        <div className="metronome-settings-dialog">
          <label className="start-measure-field">
            <span className="fmr-field__label">시작 마디</span>
            <input
              className="fmr-input"
              type="number"
              min={1}
              max={map.totalMeasures}
              value={validStartMeasure}
              onChange={(event) => setStartMeasure(Number(event.target.value))}
              disabled={metronome.playing || !mapReadyForPlayback}
            />
          </label>
          {settingsControls}
        </div>
      </Modal>
    </div>
  );
}
