import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { assertValidTempoMap } from '@feelmyrythm/core';
import type * as FeelMyRythmUi from '@feelmyrythm/ui';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { createDefaultTempoMap } from '../lib/defaultTempoMap';

const authState = vi.hoisted(() => ({
  user: null as null | { id: string },
  client: { get: vi.fn() },
}));
const database = vi.hoisted(() => ({
  listTempoMaps: vi.fn(),
  getTempoMapForRepertoire: vi.fn(),
  putTempoMap: vi.fn(),
}));
const metronome = vi.hoisted(() => ({
  playing: false,
  position: {
    measureNumber: 1,
    pass: 1,
    beatIndex: 0,
    beatCount: 4,
    sectionId: 'section-1',
    isCountIn: false,
  },
  frameSource: vi.fn(() => ({ beatIndex: 0, beatCount: 4, progress: 0, accent: 2 })),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  setVolume: vi.fn(),
}));
const notify = vi.hoisted(() => vi.fn());

vi.mock('../lib/auth', () => ({
  useAuth: () => authState,
}));

vi.mock('../lib/localDb', () => ({
  localDb: database,
}));

vi.mock('../lib/useMetronome', () => ({
  useMetronome: () => metronome,
}));

vi.mock('@feelmyrythm/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof FeelMyRythmUi>();
  return {
    ...actual,
    BeatVisualizer: ({
      className,
      label,
      showProgress,
      meterLabel,
      progressStyle,
      variant,
      numberScale,
    }: FeelMyRythmUi.BeatVisualizerProps) => (
      <div
        className={className}
        aria-label={label}
        data-progress={showProgress}
        data-meter={meterLabel}
        data-progress-style={progressStyle}
        data-variant={variant}
        data-number-scale={numberScale}
      />
    ),
    useToast: () => ({ notify }),
  };
});

import { MetronomePage, normalizeBpm } from './MetronomePage';

function renderPage(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MetronomePage />
    </MemoryRouter>,
  );
}

function NavigableMetronomePage() {
  const navigate = useNavigate();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void navigate('/');
        }}
      >
        로컬 경로로 이동
      </button>
      <button
        type="button"
        onClick={() => {
          void navigate('/?measure=12');
        }}
      >
        12마디로 이동
      </button>
      <MetronomePage />
    </>
  );
}

function renderNavigablePage(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NavigableMetronomePage />
    </MemoryRouter>,
  );
}

describe('MetronomePage contracts', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
    authState.user = null;
    authState.client.get.mockReset();
    database.listTempoMaps.mockReset().mockResolvedValue([]);
    database.getTempoMapForRepertoire.mockReset().mockResolvedValue(undefined);
    database.putTempoMap.mockReset().mockResolvedValue(undefined);
    metronome.start.mockClear();
    metronome.stop.mockClear();
    metronome.playing = false;
    notify.mockClear();
    document.title = 'FeelMyRythm';
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
    delete (document as { exitFullscreen?: unknown }).exitFullscreen;
  });

  it('accepts only finite BPM values in the 20–400 contract', () => {
    expect(normalizeBpm(20)).toBe(20);
    expect(normalizeBpm(120.6)).toBe(121);
    expect(normalizeBpm(400)).toBe(400);
    expect(normalizeBpm(19)).toBeNull();
    expect(normalizeBpm(401)).toBeNull();
    expect(normalizeBpm(Number.NaN)).toBeNull();
    expect(normalizeBpm(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('keeps mobile progress inside the app layout while keeping count-in in settings', async () => {
    vi.stubGlobal('innerWidth', 390);
    const { container, unmount } = renderPage();
    const play = await screen.findByRole('button', { name: '메트로놈 재생' });
    await waitFor(() => expect(play).toBeEnabled());

    expect(container.querySelector('.metronome-heading .performance-context')).toHaveTextContent(
      '마디 1',
    );
    expect(container.querySelector('.metronome-stage .performance-context')).toBeNull();
    const tempo = container.querySelector('.metronome-stage .bpm-display--mobile');
    expect(tempo).toHaveTextContent('1004/4');
    expect(tempo).not.toHaveTextContent('BPM');
    const number = container.querySelector('.metronome-number__visualizer');
    expect(number).not.toHaveAttribute('data-meter');
    expect(number).toHaveAttribute('data-number-scale', '0.8');
    expect(number).toHaveAttribute('data-progress-style', 'background');
    expect(container.querySelector('.metronome-controls .count-in-button')).toBeNull();
    expect(number).toHaveAttribute('data-progress', 'false');
    const progress = document.body.querySelector('.metronome-screen-progress');
    expect(progress?.parentElement).toBe(container.querySelector('.metronome-page'));
    expect(progress).toHaveAttribute('data-variant', 'progress');
    expect(progress).toHaveAttribute('data-progress', 'true');
    expect(container.querySelector('.metronome-screen-progress')).toBe(progress);
    expect(container.querySelector('.metronome-visualizer')).toHaveAttribute(
      'data-progress',
      'false',
    );

    const tempoTrigger = screen.getByRole('button', { name: '현재 BPM 100, 눌러서 직접 입력' });
    expect(tempoTrigger.closest('.bpm-display--mobile')).toBe(tempo);
    fireEvent.click(tempoTrigger);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'BPM' }), { target: { value: '132' } });
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '현재 BPM 132, 눌러서 직접 입력' })).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole('button', { name: '세부 설정' }));
    const countIn = screen.getByRole('button', { name: '예비박' });
    expect(countIn.closest('[role="dialog"]')).toHaveAccessibleName('메트로놈 세부 설정');
    fireEvent.click(countIn);
    expect(countIn).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem('fmr.countInEnabled')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    fireEvent.click(play);
    expect(metronome.start).toHaveBeenCalledWith(1, 1, false);

    vi.stubGlobal('innerWidth', 840);
    fireEvent(window, new Event('resize'));
    expect(container.querySelector('.metronome-heading .performance-context')).toBeNull();
    expect(container.querySelector('.metronome-stage .performance-context')).toHaveTextContent(
      '마디 1',
    );
    expect(container.querySelector('.metronome-number')).toBeNull();
    expect(document.body.querySelector('.metronome-screen-progress')).toBeNull();
    expect(container.querySelector('.metronome-visualizer')).toHaveAttribute(
      'data-progress',
      'true',
    );
    vi.stubGlobal('innerWidth', 390);
    fireEvent(window, new Event('resize'));
    expect(document.body.querySelector('.metronome-screen-progress')).not.toBeNull();
    unmount();
    expect(document.body.querySelector('.metronome-screen-progress')).toBeNull();
  });

  it('selects a meter from the tempo row and restores focus with a valid accent pattern', async () => {
    vi.stubGlobal('innerWidth', 390);
    renderPage();
    const trigger = screen.getByRole('button', { name: '현재 4/4박자, 눌러서 선택' });
    await waitFor(() => expect(trigger).toBeEnabled());
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '박자 선택' });
    expect(within(dialog).getByRole('button', { name: '4/4박자' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: '12/8박자' }));
    expect(screen.queryByRole('dialog', { name: '박자 선택' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '현재 12/8박자, 눌러서 선택' })).toHaveFocus(),
    );
    await waitFor(() => expect(database.putTempoMap).toHaveBeenCalled());
    const saved: unknown = database.putTempoMap.mock.lastCall?.[0];
    assertValidTempoMap(saved);
    expect(saved.sections[0]).toMatchObject({
      timeSignature: { num: 12, denom: 8 },
      beatUnit: 'dottedQuarter',
      accentPattern: [2, 1, 1, 1],
    });
  });

  it('toggles mobile focus from the beat number without restarting playback and restores the shell', async () => {
    vi.stubGlobal('innerWidth', 390);
    metronome.playing = true;
    const { container } = render(
      <MemoryRouter>
        <div className="app-shell">
          <header className="topbar">
            <button>계정</button>
          </header>
          <main>
            <MetronomePage />
          </main>
          <nav className="bottom-nav">
            <button>더보기</button>
          </nav>
        </div>
      </MemoryRouter>,
    );
    const number = screen.getByRole('button', { name: '집중 화면' });
    await waitFor(() => expect(number).toBeEnabled());
    metronome.stop.mockClear();
    expect(screen.queryByRole('button', { name: '보면대 모드' })).not.toBeInTheDocument();
    fireEvent.click(number);
    expect(container.querySelector('.metronome-page')).toHaveClass('metronome-page--focused');
    expect(number).toHaveAccessibleName('집중 화면 나가기');
    expect(number).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '메트로놈 정지' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '탭 템포' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'BPM 5 낮추기' })).not.toBeInTheDocument();
    for (const selector of [
      '.topbar',
      '.bottom-nav',
      '.metronome-heading',
      '.metronome-settings',
    ]) {
      expect(container.querySelector(selector)).toHaveAttribute('aria-hidden', 'true');
    }
    expect(metronome.stop).not.toHaveBeenCalled();
    expect(metronome.start).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '현재 BPM 100, 눌러서 직접 입력' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('.metronome-page')).toHaveClass('metronome-page--focused');
    expect(screen.queryByRole('dialog', { name: 'BPM 직접 입력' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '현재 BPM 100, 눌러서 직접 입력' })).toHaveFocus(),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('.metronome-page')).not.toHaveClass('metronome-page--focused');
    expect(number).toHaveFocus();
    expect(container.querySelector('.bottom-nav')).not.toHaveAttribute('aria-hidden');
    expect(screen.getByRole('button', { name: '탭 템포' })).toBeInTheDocument();

    fireEvent.click(number);
    fireEvent.click(number);
    expect(container.querySelector('.metronome-page')).not.toHaveClass('metronome-page--focused');
    fireEvent.click(number);
    vi.stubGlobal('innerWidth', 840);
    fireEvent(window, new Event('resize'));
    expect(container.querySelector('.metronome-page')).not.toHaveClass('metronome-page--focused');
    expect(container.querySelector('.bottom-nav')).not.toHaveAttribute('aria-hidden');
    expect(metronome.stop).not.toHaveBeenCalled();
  });

  it('uses a section landmark, sets the title, and makes hidden fullscreen controls inert', async () => {
    let fullscreenElement: Element | null = null;
    const exitFullscreen = vi.fn(() => {
      fullscreenElement = null;
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    });
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: vi.fn(() => {
        fullscreenElement = document.querySelector('.metronome-page');
        Object.defineProperty(document, 'fullscreenElement', {
          configurable: true,
          get: () => fullscreenElement,
        });
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      }),
    });
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: exitFullscreen,
    });

    const { container } = renderPage();
    expect(document.title).toBe('메트로놈 · FeelMyRythm');
    expect(container.querySelector('.metronome-stage')?.tagName).toBe('SECTION');

    fireEvent.click(screen.getByRole('button', { name: '보면대 모드' }));
    await screen.findByRole('button', { name: '나가기' });
    for (const selector of [
      '.metronome-heading__editor',
      '.bpm-steppers',
      '.quick-settings',
      '.metronome-settings',
    ]) {
      expect(container.querySelector(selector)).toHaveAttribute('inert');
      expect(container.querySelector(selector)).toHaveAttribute('aria-hidden', 'true');
    }
    expect(container.querySelector('.metronome-heading__context')).toHaveAttribute(
      'aria-hidden',
      'true',
    );

    const stage = container.querySelector('.metronome-stage');
    if (!stage) throw new Error('Metronome stage was not rendered');
    vi.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_250);
    fireEvent.pointerUp(stage, { pointerType: 'touch' });
    fireEvent.pointerUp(stage, { pointerType: 'touch' });
    await waitFor(() => expect(exitFullscreen).toHaveBeenCalledOnce());
  });

  it('blocks playback while a remote map loads and after an uncached failure, then retries', async () => {
    authState.user = { id: 'user-1' };
    authState.client.get.mockRejectedValue(new Error('network unavailable'));

    renderPage('/?repertoire=repertoire-1');
    const play = screen.getByRole('button', { name: '메트로놈 재생' });
    expect(play).toBeDisabled();
    expect(screen.getByText(/레퍼토리 템포맵을 불러오는 중/)).toBeInTheDocument();

    expect(await screen.findByRole('alert')).toHaveTextContent('network unavailable');
    expect(play).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(authState.client.get).toHaveBeenCalledTimes(2));
    expect(metronome.start).not.toHaveBeenCalled();
  });

  it('caches a validated server map and enables playback only after it arrives', async () => {
    authState.user = { id: 'user-1' };
    const map = {
      ...createDefaultTempoMap(),
      repertoireItemId: 'repertoire-1',
      revision: 8,
    };
    authState.client.get.mockResolvedValue({ data: map, revision: 8 });

    renderPage('/?repertoire=repertoire-1');
    const play = screen.getByRole('button', { name: '메트로놈 재생' });
    expect(play).toBeDisabled();
    await waitFor(() =>
      expect(database.putTempoMap).toHaveBeenCalledWith(map, { userId: 'user-1' }),
    );
    expect(play).toBeEnabled();
  });

  it('uses a validated cache only for a network failure, never for an HTTP error', async () => {
    authState.user = { id: 'user-1' };
    const cachedMap = {
      ...createDefaultTempoMap(),
      repertoireItemId: 'repertoire-1',
      revision: 7,
    };
    database.getTempoMapForRepertoire.mockResolvedValue(cachedMap);
    authState.client.get.mockRejectedValue(new ApiError(403, { detail: 'forbidden' }));

    const { unmount } = renderPage('/?repertoire=repertoire-1');
    expect(await screen.findByRole('alert')).toHaveTextContent('forbidden');
    expect(screen.getByRole('button', { name: '메트로놈 재생' })).toBeDisabled();
    expect(screen.queryByText(/오프라인 캐시를 사용/)).not.toBeInTheDocument();

    unmount();
    authState.client.get.mockReset().mockRejectedValue(new TypeError('Failed to fetch'));
    renderPage('/?repertoire=repertoire-1');
    expect(await screen.findByText(/검증된 오프라인 캐시를 사용/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '메트로놈 재생' })).toBeEnabled();
  });

  it('surfaces local storage failures, keeps the safe default playable, and retries', async () => {
    database.listTempoMaps
      .mockRejectedValueOnce(new Error('IndexedDB unavailable'))
      .mockResolvedValueOnce([]);

    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('IndexedDB unavailable');
    expect(screen.getByRole('button', { name: '메트로놈 재생' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(database.listTempoMaps).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('replaces a remote map when navigating back to an empty local library', async () => {
    authState.user = { id: 'user-1' };
    const remoteMap = {
      ...createDefaultTempoMap(),
      repertoireItemId: 'repertoire-1',
      revision: 8,
      sections: [
        {
          ...createDefaultTempoMap().sections[0]!,
          bpm: 222,
        },
      ],
    };
    authState.client.get.mockResolvedValue({ data: remoteMap, revision: 8 });

    renderNavigablePage('/?repertoire=repertoire-1');
    expect(
      await screen.findByRole('button', { name: '현재 BPM 222, 눌러서 직접 입력' }),
    ).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '로컬 경로로 이동' }));
    expect(
      await screen.findByRole('button', { name: '현재 BPM 100, 눌러서 직접 입력' }),
    ).toBeEnabled();
  });

  it('synchronizes the requested start measure after a search-param change', async () => {
    renderNavigablePage('/?measure=3');
    const startMeasure = await screen.findByRole('spinbutton', { name: '시작 마디' });
    expect(startMeasure).toHaveValue(3);

    fireEvent.click(screen.getByRole('button', { name: '12마디로 이동' }));
    await waitFor(() => expect(startMeasure).toHaveValue(12));
  });

  it('keeps detailed settings reachable through the short-screen dialog', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '메트로놈 재생' })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole('button', { name: '세부 설정' }));

    const dialog = screen.getByRole('dialog', { name: '메트로놈 세부 설정' });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent('강세 패턴');
    expect(dialog.querySelector('input[type="range"]')).toBeEnabled();
    expect(dialog.querySelector('select')).toHaveValue('4/4');
    const startMeasure = dialog.querySelector<HTMLInputElement>('input[type="number"]');
    expect(startMeasure).toHaveAccessibleName('시작 마디');
    expect(startMeasure).toHaveAttribute('min', '1');
    fireEvent.change(startMeasure!, { target: { value: '4' } });
    expect(startMeasure).toHaveValue(4);

    expect(dialog.querySelector('button[aria-label^="1박, 강박"]')).toHaveAccessibleName(
      '1박, 강박. 누르면 무음으로 변경',
    );
  });

  it('keeps the saved map valid when meter changes resize an existing accent pattern', async () => {
    const map = createDefaultTempoMap();
    map.sections[0]!.accentPattern = [0, 2, 1, 2];
    database.listTempoMaps.mockResolvedValue([map]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '메트로놈 재생' })).toBeEnabled(),
    );
    const meter = screen.getByRole('combobox', { name: '박자' });

    for (const [signature, accents] of [
      ['3/4', [0, 2, 1]],
      ['6/8', [0, 2]],
      ['5/4', [0, 2, 1, 1, 1]],
    ] as const) {
      database.putTempoMap.mockClear();
      fireEvent.change(meter, { target: { value: signature } });
      await waitFor(() => expect(database.putTempoMap).toHaveBeenCalledTimes(1));
      const savedMap: unknown = database.putTempoMap.mock.lastCall?.[0];
      assertValidTempoMap(savedMap);
      expect(savedMap.sections[0]?.accentPattern).toEqual(accents);
    }
  });

  it('edits BPM in an accessible bounded number dialog', async () => {
    renderPage();
    const trigger = await screen.findByRole('button', {
      name: '현재 BPM 100, 눌러서 직접 입력',
    });
    await waitFor(() => expect(trigger).toBeEnabled());

    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'BPM 직접 입력' });
    const input = screen.getByRole('spinbutton', { name: 'BPM' });
    expect(dialog).toBeInTheDocument();
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('min', '20');
    expect(input).toHaveAttribute('max', '400');

    fireEvent.change(input, { target: { value: '19' } });
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    expect(input).toHaveAccessibleDescription('20에서 400 사이의 정수를 입력해 주세요.');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(input, { target: { value: '20.5' } });
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    expect(input).toHaveAccessibleDescription('20에서 400 사이의 정수를 입력해 주세요.');
    expect(screen.getByRole('dialog', { name: 'BPM 직접 입력' })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '132' } });
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    expect(screen.queryByRole('dialog', { name: 'BPM 직접 입력' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '현재 BPM 132, 눌러서 직접 입력' })).toHaveFocus(),
    );

    const updatedTrigger = screen.getByRole('button', {
      name: '현재 BPM 132, 눌러서 직접 입력',
    });
    fireEvent.click(updatedTrigger);
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    await waitFor(() => expect(updatedTrigger).toHaveFocus());

    fireEvent.click(updatedTrigger);
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(updatedTrigger).toHaveFocus());
  });

  it('uses explicit tempo-step labels and keeps the meter chevron inside its select control', async () => {
    const { container } = renderPage();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '메트로놈 재생' })).toBeEnabled(),
    );

    for (const name of ['BPM 5 낮추기', 'BPM 1 낮추기', 'BPM 1 높이기', 'BPM 5 높이기']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'BPM 5 낮추기' })).toHaveTextContent('−5');
    expect(screen.getByRole('button', { name: 'BPM 5 높이기' })).toHaveTextContent('+5');

    const controlOrder = [
      ...container.querySelectorAll<HTMLButtonElement>('.metronome-controls button'),
    ].map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim());
    expect(controlOrder[0]).toBe('메트로놈 재생');

    const meterControl = container.querySelector('.meter-select__control');
    expect(meterControl?.querySelector('select')).toHaveAccessibleName('박자');
    expect(meterControl?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('clamps tempo steps at the supported range and exposes non-color setting states', async () => {
    renderPage();
    const bpmTrigger = await screen.findByRole('button', {
      name: '현재 BPM 100, 눌러서 직접 입력',
    });
    await waitFor(() => expect(bpmTrigger).toBeEnabled());

    fireEvent.click(bpmTrigger);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'BPM' }), {
      target: { value: '398' },
    });
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    fireEvent.click(screen.getByRole('button', { name: 'BPM 5 높이기' }));
    expect(screen.getByRole('button', { name: '현재 BPM 400, 눌러서 직접 입력' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'BPM 1 높이기' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'BPM 5 높이기' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '현재 BPM 400, 눌러서 직접 입력' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'BPM' }), {
      target: { value: '21' },
    });
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    fireEvent.click(screen.getByRole('button', { name: 'BPM 5 낮추기' }));
    expect(screen.getByRole('button', { name: '현재 BPM 20, 눌러서 직접 입력' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'BPM 1 낮추기' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'BPM 5 낮추기' })).toBeDisabled();

    const countIn = screen.getByRole('button', { name: '예비박' });
    expect(countIn).toHaveTextContent('켬');
    expect(countIn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(countIn);
    expect(countIn).toHaveTextContent('끔');
    expect(countIn).toHaveAttribute('aria-pressed', 'false');

    const firstBeat = screen.getByRole('button', {
      name: '1박, 강박. 누르면 무음으로 변경',
    });
    fireEvent.click(firstBeat);
    expect(
      screen.getByRole('button', { name: '1박, 무음. 누르면 보통으로 변경' }),
    ).toBeInTheDocument();
  });

  it('opens a mobile tap pad without counting the launcher and restores controls after closing', async () => {
    vi.stubGlobal('innerWidth', 390);
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { container } = renderPage();
    const launcher = await screen.findByRole('button', { name: '탭 템포' });
    await waitFor(() => expect(launcher).toBeEnabled());

    expect(
      [...container.querySelectorAll('.metronome-controls button')].map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['BPM 5 낮추기', '메트로놈 재생', 'BPM 5 높이기', '탭 템포']);
    fireEvent.click(launcher);
    const pad = screen.getByRole('button', { name: '박자에 맞춰 탭' });
    await waitFor(() => expect(pad).toHaveFocus());
    expect(screen.queryByRole('button', { name: '메트로놈 재생' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '현재 BPM 100, 눌러서 직접 입력' })).toBeEnabled();

    now = 1_250;
    fireEvent.click(pad);
    expect(pad).toHaveAttribute('data-feedback', '다시 탭');
    expect(screen.getByRole('button', { name: '현재 BPM 100, 눌러서 직접 입력' })).toBeEnabled();
    now = 1_750;
    fireEvent.click(pad);
    expect(pad).toHaveAttribute('data-feedback', '2회');
    expect(screen.getByRole('button', { name: '현재 BPM 120, 눌러서 직접 입력' })).toBeEnabled();

    now = 1_800;
    fireEvent.click(screen.getByRole('button', { name: '탭 템포 닫기' }));
    expect(screen.queryByRole('button', { name: '박자에 맞춰 탭' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '탭 템포' })).toHaveFocus());
    expect(screen.getByRole('button', { name: '현재 BPM 120, 눌러서 직접 입력' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '탭 템포' }));
    now = 1_950;
    const reopenedPad = screen.getByRole('button', { name: '박자에 맞춰 탭' });
    fireEvent.click(reopenedPad);
    expect(reopenedPad).toHaveAttribute('data-feedback', '다시 탭');
    expect(screen.getByRole('button', { name: '현재 BPM 120, 눌러서 직접 입력' })).toBeEnabled();
    fireEvent.keyDown(reopenedPad, { key: 'Escape' });
    await waitFor(() => expect(screen.getByRole('button', { name: '탭 템포' })).toHaveFocus());
  });

  it('shows immediate tap-tempo progress before calculating the next BPM', async () => {
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    renderPage();
    const tapTempo = await screen.findByRole('button', { name: '탭 템포' });
    await waitFor(() => expect(tapTempo).toBeEnabled());

    fireEvent.click(tapTempo);
    expect(tapTempo).toHaveAttribute('data-feedback', '다시 탭');
    expect(tapTempo).toHaveTextContent('다시 탭');
    const feedbackStatus = document.querySelector('.tap-tempo-feedback');
    expect(feedbackStatus).toHaveAttribute('role', 'status');
    expect(feedbackStatus).toHaveAttribute('aria-live', 'polite');
    expect(feedbackStatus).toHaveTextContent('첫 탭을 인식했습니다. 다시 탭하세요.');

    now = 1_500;
    fireEvent.click(tapTempo);
    expect(tapTempo).toHaveAttribute('data-feedback', '2회');
    expect(tapTempo).toHaveTextContent('2회');
    expect(feedbackStatus).toHaveTextContent('탭 템포 2회 입력했습니다.');
    expect(screen.getByRole('button', { name: '현재 BPM 120, 눌러서 직접 입력' })).toBeEnabled();
  });
});
