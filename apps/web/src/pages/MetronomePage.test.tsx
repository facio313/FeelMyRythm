import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    BeatVisualizer: () => <div aria-label="오디오 시계 기준 메트로놈 박" />,
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
    for (const selector of ['.bpm-steppers', '.quick-settings', '.metronome-settings']) {
      expect(container.querySelector(selector)).toHaveAttribute('inert');
      expect(container.querySelector(selector)).toHaveAttribute('aria-hidden', 'true');
    }

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
    const startMeasure = await screen.findByRole('spinbutton', { name: '시작' });
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
  });
});
