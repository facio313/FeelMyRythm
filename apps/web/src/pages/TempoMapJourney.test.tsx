import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expandTimeline, type TempoMap } from '@feelmyrythm/core';
import type * as FeelMyRythmUi from '@feelmyrythm/ui';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultTempoMap } from '../lib/defaultTempoMap';
import { localDb } from '../lib/localDb';

const authState = vi.hoisted(() => ({
  user: null as null | { id: string },
  client: { get: vi.fn(), put: vi.fn() },
}));
const playback = vi.hoisted(() => ({
  map: null as TempoMap | null,
  playing: false,
  position: {
    measureNumber: 1,
    pass: 1,
    beatIndex: 0,
    beatCount: 4,
    sectionId: '',
    isCountIn: false,
  },
  frameSource: vi.fn(),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  setVolume: vi.fn(),
}));
const notify = vi.hoisted(() => vi.fn());

vi.mock('../lib/auth', () => ({ useAuth: () => authState }));
vi.mock('../lib/useMetronome', () => ({
  useMetronome: (map: TempoMap) => {
    playback.map = map;
    return playback;
  },
}));
vi.mock('@feelmyrythm/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof FeelMyRythmUi>();
  return {
    ...actual,
    BeatVisualizer: () => <div aria-label="메트로놈 박" />,
    useToast: () => ({ notify }),
  };
});

import { EditorPage } from './EditorPage';
import { MetronomePage } from './MetronomePage';

function renderJourney(path = '/') {
  const router = createMemoryRouter(
    [
      { path: '/', element: <MetronomePage /> },
      { path: '/editor/:tempoMapId?', element: <EditorPage /> },
      { path: '/scores/:scoreId', element: <h1>연결된 악보</h1> },
    ],
    { initialEntries: [path] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

describe('tempo map playback journeys with persisted local data', () => {
  beforeEach(async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    for (const map of await localDb.listTempoMaps()) await localDb.deleteTempoMap(map.id);
    authState.user = null;
    authState.client.get.mockReset();
    authState.client.put.mockReset();
    playback.map = null;
    playback.start.mockClear();
    notify.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([false, true])(
    'keeps 4/4 at 100 BPM and 3/4 at 150 BPM after editing, saving and reopening (signed in: %s)',
    async (signedIn) => {
      authState.user = signedIn ? { id: 'local-player' } : null;
      const view = renderJourney();
      const edit = screen.getByRole('button', { name: '템포맵' });
      await waitFor(() => expect(edit).toBeEnabled());
      fireEvent.click(edit);

      await screen.findByLabelText('총 마디 수');
      expect(view.router.state.location.search).toBe('?source=local');
      const initialMap = (await localDb.listTempoMaps())[0]!;
      expect(view.router.state.location.pathname).toBe(`/editor/${initialMap.id}`);
      fireEvent.change(screen.getByLabelText('총 마디 수'), { target: { value: '4' } });
      fireEvent.click(screen.getByRole('button', { name: '구간 나누기' }));
      const splitDialog = screen.getByRole('dialog', { name: '구간 나누기' });
      fireEvent.change(within(splitDialog).getByRole('spinbutton'), { target: { value: '3' } });
      fireEvent.click(within(splitDialog).getByRole('button', { name: '나누기' }));
      fireEvent.change(screen.getByLabelText('BPM'), { target: { value: '150' } });
      fireEvent.change(screen.getByLabelText('박자 분자'), { target: { value: '3' } });
      fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);
      await screen.findByText('저장됨', { exact: true });
      fireEvent.click(screen.getByRole('button', { name: '메트로놈에서 열기' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '메트로놈 재생' })).toBeEnabled(),
      );

      expect(view.router.state.location.search).toBe(`?tempoMap=${initialMap.id}`);
      expect(localStorage.getItem('fmr.activeTempoMap')).toBe(initialMap.id);
      expect(playback.map).toMatchObject({
        id: initialMap.id,
        repertoireItemId: 'local',
        totalMeasures: 4,
        sections: [
          { startMeasure: 1, endMeasure: 2, bpm: 100, timeSignature: { num: 4, denom: 4 } },
          { startMeasure: 3, endMeasure: 4, bpm: 150, timeSignature: { num: 3, denom: 4 } },
        ],
      });
      const timeline = expandTimeline(playback.map!);
      expect(timeline.entries.map((entry) => entry.beats.length)).toEqual([4, 4, 3, 3]);
      expect(timeline.entries[2]?.startTimeSec).toBeCloseTo(4.8);
      expect(timeline.totalDurationSec).toBeCloseTo(7.2);
      fireEvent.click(screen.getByRole('button', { name: '메트로놈 재생' }));
      expect(playback.start).toHaveBeenCalledWith(1, 1, true);
      const saved = await localDb.getTempoMap(initialMap.id);
      expect(saved?.sections).toEqual(playback.map?.sections);

      view.unmount();
      renderJourney('/');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '메트로놈 재생' })).toBeEnabled(),
      );
      expect(playback.map?.id).toBe(initialMap.id);
      expect(playback.map?.sections).toEqual(saved?.sections);
      expect(authState.client.get).not.toHaveBeenCalled();
      expect(authState.client.put).not.toHaveBeenCalled();
    },
  );

  it('opens remote editing by repertoire identity when the map has a different id', async () => {
    authState.user = { id: 'remote-player' };
    const map = { ...createDefaultTempoMap('repertoire-1'), id: 'different-map-id' };
    authState.client.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith('/access') ? { role: 'leader' } : { data: map, revision: map.revision },
      ),
    );
    const view = renderJourney('/?repertoire=repertoire-1');
    const edit = screen.getByRole('button', { name: '템포맵' });
    await waitFor(() => expect(edit).toBeEnabled());
    fireEvent.click(edit);

    expect(await screen.findByLabelText('BPM')).toHaveValue(100);
    expect(view.router.state.location.pathname).toBe('/editor/repertoire-1');
    expect(authState.client.get).toHaveBeenCalledWith('/repertoire/repertoire-1/access');
    expect(authState.client.get).not.toHaveBeenCalledWith('/repertoire/different-map-id/tempomap');
  });

  it('returns to the attached score only after saving the edited local map', async () => {
    const map = createDefaultTempoMap();
    await localDb.putTempoMap(map);
    const view = renderJourney(`/editor/${map.id}?source=local&score=score-1`);
    fireEvent.change(await screen.findByLabelText('BPM'), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: '악보로 돌아가기' }));
    const dialog = await screen.findByRole('dialog', { name: '저장하지 않은 변경이 있습니다' });
    fireEvent.click(within(dialog).getByRole('button', { name: '저장 후 이동' }));

    expect(await screen.findByRole('heading', { name: '연결된 악보' })).toBeVisible();
    expect(view.router.state.location.pathname).toBe('/scores/score-1');
    expect((await localDb.getTempoMap(map.id))?.sections[0]?.bpm).toBe(150);
  });

  it('imports section data into the current score map without replacing its identity', async () => {
    const map = { ...createDefaultTempoMap(), revision: 3 };
    await localDb.putTempoMap(map);
    const imported = { ...createDefaultTempoMap('different-repertoire'), revision: 17 };
    imported.sections[0]!.bpm = 150;
    const view = renderJourney(`/editor/${map.id}?source=local&score=score-1`);
    await screen.findByLabelText('BPM');
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('Tempo map import control is missing');
    fireEvent.change(input, {
      target: { files: [{ text: () => Promise.resolve(JSON.stringify(imported)) }] },
    });
    await waitFor(() => expect(screen.getByLabelText('BPM')).toHaveValue(150));
    fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);
    await screen.findByText('저장됨', { exact: true });

    expect(await localDb.getTempoMap(map.id)).toMatchObject({
      id: map.id,
      repertoireItemId: 'local',
      revision: 4,
      sections: [expect.objectContaining({ bpm: 150 })],
    });
    expect(await localDb.getTempoMap(imported.id)).toBeUndefined();
  });

  it('does not substitute an unrelated map when an explicitly requested local map is missing', async () => {
    await localDb.putTempoMap(createDefaultTempoMap());
    renderJourney('/?tempoMap=missing-map');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '선택한 템포맵을 불러오지 못했습니다',
    );
    expect(screen.getByRole('button', { name: '메트로놈 재생' })).toBeDisabled();
    expect(playback.start).not.toHaveBeenCalled();
  });
});
