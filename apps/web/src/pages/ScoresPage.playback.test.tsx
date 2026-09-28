import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TempoMap } from '@feelmyrythm/core';
import type * as FeelMyRythmUi from '@feelmyrythm/ui';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalScore } from '../lib/localDb';
import type * as PracticeApi from '../lib/practiceApi';
import type * as ScoreApi from '../lib/scoreApi';
import type { MetronomeController } from '../lib/useMetronome';

const database = vi.hoisted(() => ({
  listScores: vi.fn(),
  getScore: vi.fn(),
  putScore: vi.fn(),
  deleteScore: vi.fn(),
  getMeasureMap: vi.fn(),
  putMeasureMap: vi.fn(),
  deleteMeasureMap: vi.fn(),
  listAnnotations: vi.fn(),
  replaceAnnotations: vi.fn(),
  listTempoMaps: vi.fn(),
  getTempoMap: vi.fn(),
  putTempoMap: vi.fn(),
}));
const remoteScores = vi.hoisted(() => ({
  listScores: vi.fn(),
  getScore: vi.fn(),
  getMeasureMap: vi.fn(),
  downloadScore: vi.fn(),
  listRepertoireAnnotations: vi.fn(),
}));
const authState = vi.hoisted(() => ({
  user: null as { id: string } | null,
  client: { get: vi.fn() },
}));
const notify = vi.hoisted(() => vi.fn());
const useMetronome = vi.hoisted(() => vi.fn());

vi.mock('../lib/auth', () => ({ useAuth: () => authState }));
vi.mock('../lib/localDb', () => ({ localDb: database }));
vi.mock('../lib/useMetronome', () => ({ useMetronome }));
vi.mock('../lib/practiceApi', async (importOriginal) => {
  const actual = await importOriginal<typeof PracticeApi>();
  return { ...actual, listPracticeLogs: async () => [] };
});
vi.mock('../lib/scoreApi', async (importOriginal) => {
  const actual = await importOriginal<typeof ScoreApi>();
  return { ...actual, ...remoteScores };
});
vi.mock('@feelmyrythm/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof FeelMyRythmUi>();
  return {
    ...actual,
    useToast: () => ({ notify }),
    BeatVisualizer: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
  };
});

import { ScoresPage, type ScoresPageProps } from './ScoresPage';

const map: TempoMap = {
  id: 'local-map',
  repertoireItemId: 'local',
  revision: 3,
  totalMeasures: 8,
  sections: [
    {
      id: 'slow',
      label: 'A',
      startMeasure: 1,
      endMeasure: 4,
      timeSignature: { num: 4, denom: 4 },
      bpm: 100,
      beatUnit: 'quarter',
    },
    {
      id: 'fast',
      label: 'B',
      startMeasure: 5,
      endMeasure: 8,
      timeSignature: { num: 3, denom: 4 },
      bpm: 150,
      beatUnit: 'quarter',
    },
  ],
  jumps: [],
  countIn: { measures: 1, useSectionMeter: true },
};

function makeScore(id = 'score-1'): LocalScore {
  return {
    id,
    repertoireItemId: 'local',
    name: `${id}.png`,
    kind: 'part',
    instrument: id,
    mimeType: 'image/png',
    blob: new Blob(['image'], { type: 'image/png' }),
    updatedAt: '2026-09-28T00:00:00.000Z',
  };
}

function Location() {
  const location = useLocation();
  return (
    <output aria-label="현재 경로">
      {location.pathname}
      {location.search}
    </output>
  );
}

function scoreView(props: ScoresPageProps = {}, path = '/scores/score-1') {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Location />
      <Routes>
        <Route path="/scores/:scoreId" element={<ScoresPage {...props} />} />
        <Route path="/session/:roomId" element={<ScoresPage {...props} />} />
        <Route path="/editor/:tempoMapId" element={<h1>템포맵 편집</h1>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('score playback ownership and tempo map connections', () => {
  let controller: MetronomeController;

  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = null;
    authState.client.get.mockResolvedValue({ role: 'owner' });
    for (const method of Object.values(database)) method.mockResolvedValue(undefined);
    database.listScores.mockResolvedValue([makeScore()]);
    database.getScore.mockImplementation(async (id: string) => makeScore(id));
    database.listAnnotations.mockResolvedValue([]);
    database.listTempoMaps.mockResolvedValue([map]);
    database.getTempoMap.mockResolvedValue(map);
    remoteScores.listScores.mockResolvedValue([]);
    remoteScores.listRepertoireAnnotations.mockResolvedValue([]);
    remoteScores.getMeasureMap.mockResolvedValue(undefined);
    remoteScores.downloadScore.mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
    controller = {
      playing: false,
      position: {
        measureNumber: 1,
        pass: 1,
        beatIndex: 0,
        beatCount: 4,
        sectionId: 'slow',
        isCountIn: false,
      },
      frameSource: () => ({ beatIndex: 0, beatCount: 4, progress: 0, accent: 2 }),
      prepareAudio: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      startSynchronized: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      setVolume: vi.fn(),
    };
    useMetronome.mockReturnValue(controller);
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = vi.fn(() => 'blob:score');
        static override revokeObjectURL = vi.fn();
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps the session route, pinned revision, and audio owner while changing scores and following transport', async () => {
    authState.user = { id: 'player' };
    const records = ['score-1', 'score-2'].map((id): ScoreApi.ScoreRecord => ({
      id,
      repertoireId: 'shared-song',
      kind: 'part',
      instrument: id,
      filename: `${id}.png`,
      contentType: 'image/png',
      sizeBytes: 5,
      uploadStatus: 'ready',
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
    }));
    database.listScores.mockResolvedValue([]);
    remoteScores.listScores.mockResolvedValue(records);
    remoteScores.getScore.mockImplementation(async (_client, id: string) =>
      records.find((score) => score.id === id),
    );
    const synchronizedPlayback = { ...controller, tempoMap: { ...map, revision: 2 } };
    const view = render(
      scoreView({ repertoireItemId: 'shared-song', synchronizedPlayback }, '/session/room'),
    );
    expect(await screen.findByRole('tab', { name: 'score-1', selected: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'score-2' }));
    await screen.findByRole('tab', { name: 'score-2', selected: true });
    expect(screen.getByLabelText('현재 경로')).toHaveTextContent('/session/room');
    expect(screen.queryByRole('button', { name: '이 마디부터 재생' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '마디 구간 편집' })).not.toBeInTheDocument();

    view.rerender(
      scoreView(
        {
          repertoireItemId: 'shared-song',
          synchronizedPlayback: {
            ...synchronizedPlayback,
            playing: true,
            position: { ...controller.position, measureNumber: 5, sectionId: 'fast', beatCount: 3 },
          },
        },
        '/session/room',
      ),
    );
    await waitFor(() => expect(screen.getByLabelText('현재 마디')).toHaveValue(5));
    expect(screen.getByLabelText('현재 마디')).toHaveAttribute('readonly');
    expect(screen.getByText('세션 r2 · 5마디를 따라갑니다.')).toBeInTheDocument();
    expect(authState.client.get).not.toHaveBeenCalledWith(expect.stringContaining('/tempomap'));
    expect(useMetronome).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.stop).not.toHaveBeenCalled();
  });

  it('saves a new local map and its score connection before opening the editor', async () => {
    let finishSave: (() => void) | undefined;
    database.putTempoMap.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    render(scoreView());
    const edit = await screen.findByRole('button', { name: '마디 구간 편집' });
    fireEvent.click(edit);
    await waitFor(() => expect(database.putTempoMap).toHaveBeenCalledTimes(1));
    expect(database.putScore).not.toHaveBeenCalled();
    expect(screen.getByLabelText('현재 경로')).toHaveTextContent('/scores/score-1');
    await act(async () => {
      finishSave?.();
    });
    await screen.findByRole('heading', { name: '템포맵 편집' });
    const saved = database.putTempoMap.mock.calls[0]?.[0] as TempoMap;
    expect(database.putScore).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'score-1', tempoMapId: saved.id }),
    );
    expect(screen.getByLabelText('현재 경로')).toHaveTextContent(
      `/editor/${saved.id}?source=local&score=score-1`,
    );
  });

  it('connects a saved map to a local image and uses its section at the selected starting measure', async () => {
    render(scoreView());
    const select = await screen.findByLabelText('연결할 템포맵');
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: map.id } });
    await waitFor(() =>
      expect(database.putScore).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'score-1', tempoMapId: map.id }),
      ),
    );
    await waitFor(() => expect(useMetronome).toHaveBeenLastCalledWith(map));
    fireEvent.change(screen.getByLabelText('현재 마디'), { target: { value: '5' } });
    expect(screen.getByText('150 BPM · 3/4')).toBeInTheDocument();
    expect(screen.getByText('1 / 3박')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '이 마디부터 재생' }));
    expect(controller.start).toHaveBeenCalledWith(5, 1, true);
  });

  it('does not silently replace a missing connected map with a default when editing', async () => {
    database.getScore.mockResolvedValue({ ...makeScore(), tempoMapId: 'missing-map' });
    database.getTempoMap.mockResolvedValue(undefined);
    render(scoreView());
    fireEvent.click(await screen.findByRole('button', { name: '마디 구간 편집' }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: '템포맵 편집기를 열지 못했습니다.' }),
      ),
    );
    expect(database.putTempoMap).not.toHaveBeenCalled();
    expect(database.putScore).not.toHaveBeenCalled();
    expect(screen.getByLabelText('현재 경로')).toHaveTextContent('/scores/score-1');
  });
});
