import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type * as FeelMyRythmUi from '@feelmyrythm/ui';
import type { TempoMap } from '@feelmyrythm/core';
import { createMemoryRouter, Link, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';

const database = vi.hoisted(() => ({
  getTempoMapForRepertoire: vi.fn(),
  getTempoMap: vi.fn(),
  putTempoMap: vi.fn(),
}));
const notify = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({
  user: null as { id: string } | null,
  client: {
    get: vi.fn(),
    put: vi.fn(),
  },
}));

vi.mock('../lib/auth', () => ({ useAuth: () => authState }));
vi.mock('../lib/localDb', () => ({ localDb: database }));
vi.mock('@feelmyrythm/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof FeelMyRythmUi>();
  return { ...actual, useToast: () => ({ notify }) };
});

import { EditorPage } from './EditorPage';

const storedMap: TempoMap = {
  id: 'map-1',
  repertoireItemId: 'local',
  revision: 3,
  totalMeasures: 16,
  sections: [
    {
      id: 'section-1',
      label: 'A',
      startMeasure: 1,
      endMeasure: 16,
      timeSignature: { num: 4, denom: 4 },
      bpm: 100,
      beatUnit: 'quarter',
      accentPattern: [2, 1, 1, 1],
      subdivision: 1,
    },
  ],
  jumps: [],
  countIn: { measures: 1, useSectionMeter: true },
};

function EditorRoute() {
  return (
    <>
      <Link to="/destination">다른 화면</Link>
      <Link to="/editor/map-2">다른 템포맵</Link>
      <EditorPage />
    </>
  );
}

function renderEditor(path = '/editor/map-1') {
  const router = createMemoryRouter(
    [
      { path: '/editor/:tempoMapId', element: <EditorRoute /> },
      { path: '/destination', element: <h1>이동 완료</h1> },
      { path: '/', element: <h1>메트로놈</h1> },
    ],
    { initialEntries: [path] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

async function makeDirty() {
  const bpm = await screen.findByLabelText('BPM');
  fireEvent.change(bpm, { target: { value: '126' } });
  await screen.findByText('저장 안 됨', { exact: true });
}

function remoteMap(id: string, bpm = 100): TempoMap {
  return {
    ...storedMap,
    id,
    repertoireItemId: id,
    sections: storedMap.sections.map((section) => ({ ...section, bpm })),
  };
}

function serverResponse(map: TempoMap) {
  return {
    id: map.id,
    revision: map.revision,
    data: map,
  };
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('EditorPage tempo expressions and automatic breaths', () => {
  beforeEach(() => {
    database.getTempoMapForRepertoire.mockReset().mockResolvedValue(storedMap);
    database.getTempoMap.mockReset().mockResolvedValue(undefined);
    database.putTempoMap.mockReset().mockResolvedValue(undefined);
    authState.user = null;
    authState.client.get.mockReset();
    authState.client.put.mockReset();
    notify.mockReset();
  });

  afterEach(cleanup);

  function addMeasureExpression(measure: number) {
    const panel = screen.getByRole('region', { name: '마디별 연주 표현' });
    fireEvent.change(within(panel).getByLabelText('표현을 추가할 마디'), {
      target: { value: String(measure) },
    });
    fireEvent.click(within(panel).getByRole('button', { name: '마디 표현 추가' }));
    return within(panel).getByRole('group', { name: `${measure}마디 연주 표현` });
  }

  it('edits arbitrary measures and a specific fermata beat without splitting the section, then reloads exact settings', async () => {
    const { unmount } = renderEditor('/editor/map-1?source=local');
    await screen.findByLabelText('BPM');
    const rit = addMeasureExpression(3);
    fireEvent.change(within(rit).getByLabelText('템포 변화'), { target: { value: 'rit' } });
    fireEvent.change(within(rit).getByLabelText('도착 BPM'), { target: { value: '80' } });
    fireEvent.change(within(rit).getByLabelText('변화 끝 마디'), { target: { value: '4' } });
    const aTempo = addMeasureExpression(5);
    fireEvent.change(within(aTempo).getByLabelText('템포 변화'), { target: { value: 'aTempo' } });
    expect(within(aTempo).getByLabelText('복귀 BPM')).toHaveValue(100);
    expect(within(aTempo).queryByLabelText('변화 끝 마디')).not.toBeInTheDocument();
    const fermata = addMeasureExpression(7);
    fireEvent.click(within(fermata).getByRole('checkbox', { name: /페르마타/ }));
    fireEvent.change(within(fermata).getByLabelText('늘일 박'), { target: { value: '2' } });
    fireEvent.change(within(fermata).getByLabelText('추가로 늘일 박 수'), {
      target: { value: '1.5' },
    });
    const breath = addMeasureExpression(8);
    fireEvent.click(within(breath).getByRole('checkbox', { name: /쉼표 · 숨 고르기/ }));
    fireEvent.change(within(breath).getByLabelText('쉬는 시간 (초)'), { target: { value: '2.5' } });
    fireEvent.click(within(breath).getByRole('checkbox', { name: /재개 전 예비박/ }));
    fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);
    await waitFor(() => expect(database.putTempoMap).toHaveBeenCalledOnce());
    const saved = database.putTempoMap.mock.calls[0]![0] as TempoMap;
    expect(saved.sections).toEqual(storedMap.sections);
    expect(saved.measureExpressions).toEqual([
      { measure: 3, tempoChange: { type: 'rit', targetBpm: 80, endMeasure: 4 } },
      { measure: 5, tempoChange: { type: 'aTempo', targetBpm: 100 } },
      { measure: 7, fermata: { extraBeats: 1.5, beat: 2 } },
      { measure: 8, breath: { durationSec: 2.5, countIn: false } },
    ]);
    unmount();
    database.getTempoMapForRepertoire.mockResolvedValue(saved);
    renderEditor('/editor/map-1?source=local');
    const reopened = await screen.findByRole('group', { name: '8마디 연주 표현' });
    expect(within(reopened).getByLabelText('쉬는 시간 (초)')).toHaveValue(2.5);
    expect(within(reopened).getByRole('checkbox', { name: /재개 전 예비박/ })).not.toBeChecked();
    expect(
      within(screen.getByRole('group', { name: '7마디 연주 표현' })).getByLabelText('늘일 박'),
    ).toHaveValue('2');
  });

  it('keeps absolute measure expressions through section split, move and merge, and exposes rows beyond a shortened score', async () => {
    database.getTempoMapForRepertoire.mockResolvedValue({
      ...storedMap,
      measureExpressions: [{ measure: 7, fermata: { extraBeats: 1, beat: 2 } }],
    });
    renderEditor();
    await screen.findByLabelText('BPM');
    fireEvent.click(screen.getByRole('button', { name: '구간 나누기' }));
    const dialog = screen.getByRole('dialog', { name: '구간 나누기' });
    fireEvent.change(within(dialog).getByRole('spinbutton'), { target: { value: '8' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '나누기' }));
    fireEvent.click(screen.getByRole('button', { name: '구간 위로 이동' }));
    fireEvent.click(screen.getByRole('button', { name: '표' }));
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    fireEvent.click(screen.getByRole('button', { name: '이전과 합치기' }));
    fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);
    await waitFor(() => expect(database.putTempoMap).toHaveBeenCalledOnce());
    const saved = database.putTempoMap.mock.calls[0]![0] as TempoMap;
    expect(saved.sections).toHaveLength(1);
    expect(saved.measureExpressions).toEqual([{ measure: 7, fermata: { extraBeats: 1, beat: 2 } }]);
    fireEvent.change(screen.getByLabelText('총 마디 수'), { target: { value: '6' } });
    const outside = screen.getByRole('group', { name: '7마디 연주 표현' });
    expect(within(outside).getByLabelText('표현 마디')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);
    expect(database.putTempoMap).toHaveBeenCalledOnce();
    fireEvent.change(within(outside).getByLabelText('표현 마디'), { target: { value: '6' } });
    expect(screen.getByText('유효함', { exact: true })).toBeVisible();
  });

  it('restores the actual earlier ramp when a measure span overrides a later section ramp', async () => {
    const opening = storedMap.sections[0]!;
    database.getTempoMapForRepertoire.mockResolvedValue({
      ...storedMap,
      sections: [
        { ...opening, endMeasure: 3 },
        {
          ...opening,
          id: 'section-2',
          label: 'B',
          startMeasure: 4,
          bpm: 140,
          tempoChange: { type: 'rit', targetBpm: 120 },
        },
      ],
      measureExpressions: [
        { measure: 2, tempoChange: { type: 'rit', targetBpm: 80, endMeasure: 5 } },
      ],
    });
    renderEditor();
    await screen.findByLabelText('BPM');
    const row = addMeasureExpression(6);
    fireEvent.change(within(row).getByLabelText('템포 변화'), { target: { value: 'aTempo' } });
    expect(within(row).getByLabelText('복귀 BPM')).toHaveValue(100);
  });

  it('seeds section-end defaults, preserves an explicit empty override and restores inheritance when the row is deleted', async () => {
    const section = {
      ...storedMap.sections[0]!,
      fermata: { extraBeats: 1.5 },
      breath: { durationSec: 3, countIn: false },
    };
    database.getTempoMapForRepertoire.mockResolvedValue({ ...storedMap, sections: [section] });
    renderEditor();
    await screen.findByLabelText('BPM');
    const row = addMeasureExpression(16);
    expect(within(row).getByLabelText('추가로 늘일 박 수')).toHaveValue(1.5);
    expect(within(row).getByLabelText('쉬는 시간 (초)')).toHaveValue(3);
    expect(within(row).getByRole('checkbox', { name: /재개 전 예비박/ })).not.toBeChecked();
    fireEvent.click(within(row).getByRole('checkbox', { name: /페르마타/ }));
    fireEvent.click(within(row).getByRole('checkbox', { name: /쉼표 · 숨 고르기/ }));
    fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);
    await waitFor(() => expect(database.putTempoMap).toHaveBeenCalledOnce());
    const saved = database.putTempoMap.mock.calls[0]![0] as TempoMap;
    expect(saved.measureExpressions).toEqual([{ measure: 16 }]);
    expect(saved.sections).toEqual([section]);
    fireEvent.click(within(row).getByRole('button', { name: '16마디 표현 삭제' }));
    fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);
    await waitFor(() => expect(database.putTempoMap).toHaveBeenCalledTimes(2));
    expect((database.putTempoMap.mock.calls[1]![0] as TempoMap).measureExpressions).toEqual([]);
  });

  it('offers only the nominal primary beats actually played in a pickup measure', async () => {
    database.getTempoMapForRepertoire.mockResolvedValue({ ...storedMap, anacrusis: { beats: 2 } });
    renderEditor();
    await screen.findByLabelText('BPM');
    const row = addMeasureExpression(1);
    fireEvent.click(within(row).getByRole('checkbox', { name: /페르마타/ }));
    const beat = within(row).getByLabelText('늘일 박');
    expect(within(beat).queryByRole('option', { name: '1박' })).not.toBeInTheDocument();
    expect(within(beat).queryByRole('option', { name: '2박' })).not.toBeInTheDocument();
    expect(within(beat).getByRole('option', { name: '3박' })).toBeInTheDocument();
    fireEvent.change(beat, { target: { value: '3' } });
    fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);
    await waitFor(() => expect(database.putTempoMap).toHaveBeenCalledOnce());
    expect((database.putTempoMap.mock.calls[0]![0] as TempoMap).measureExpressions).toEqual([
      { measure: 1, fermata: { extraBeats: 1, beat: 3 } },
    ]);
  });

  it('persists measure-level breaths through the remote revision response and user cache', async () => {
    authState.user = { id: 'user-1' };
    authState.client.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith('/access') ? { role: 'leader' } : serverResponse(remoteMap('map-1')),
      ),
    );
    authState.client.put.mockImplementation((_path: string, body: { data: TempoMap }) =>
      Promise.resolve(serverResponse({ ...body.data, revision: 4 })),
    );
    renderEditor();
    await screen.findByLabelText('BPM');
    const row = addMeasureExpression(8);
    fireEvent.click(within(row).getByRole('checkbox', { name: /쉼표 · 숨 고르기/ }));
    fireEvent.click(within(row).getByRole('checkbox', { name: /재개 전 예비박/ }));
    fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);
    const expressions = [{ measure: 8, breath: { durationSec: 2, countIn: false } }];
    await waitFor(() =>
      expect(authState.client.put).toHaveBeenCalledWith('/repertoire/map-1/tempomap', {
        expectedRevision: 3,
        data: expect.objectContaining({
          measureExpressions: expressions,
          sections: storedMap.sections,
        }),
      }),
    );
    await waitFor(() =>
      expect(database.putTempoMap).toHaveBeenLastCalledWith(
        expect.objectContaining({ revision: 4, measureExpressions: expressions }),
        { userId: 'user-1' },
      ),
    );
  });

  it('saves fractional fermatas and silent automatic breaths, reopens them and opens the exact map for playback', async () => {
    const { router, unmount } = renderEditor('/editor/map-1?source=local');
    await screen.findByLabelText('BPM');
    fireEvent.click(screen.getByRole('checkbox', { name: /페르마타/ }));
    fireEvent.change(screen.getByLabelText('추가로 늘일 박 수'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /쉼표 · 숨 고르기/ }));
    fireEvent.change(screen.getByLabelText('쉬는 시간 (초)'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /재개 전 예비박/ }));
    fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);

    await waitFor(() => expect(database.putTempoMap).toHaveBeenCalledOnce());
    const saved = database.putTempoMap.mock.calls[0]![0] as TempoMap;
    expect(saved).toMatchObject({
      id: 'map-1',
      revision: 4,
      sections: [
        {
          fermata: { extraBeats: 0.5 },
          breath: { durationSec: 2.5, countIn: false },
        },
      ],
    });
    await screen.findByText('저장됨', { exact: true });
    fireEvent.click(screen.getByRole('button', { name: '메트로놈에서 열기' }));
    await screen.findByRole('heading', { name: '메트로놈' });
    expect(router.state.location.search).toBe('?tempoMap=map-1');

    unmount();
    database.getTempoMapForRepertoire.mockResolvedValue(saved);
    renderEditor('/editor/map-1?source=local');
    expect(await screen.findByLabelText('추가로 늘일 박 수')).toHaveValue(0.5);
    expect(screen.getByLabelText('쉬는 시간 (초)')).toHaveValue(2.5);
    expect(screen.getByRole('checkbox', { name: /재개 전 예비박/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: /페르마타/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /쉼표 · 숨 고르기/ }));
    fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);
    await waitFor(() => expect(database.putTempoMap).toHaveBeenCalledTimes(2));
    const cleared = database.putTempoMap.mock.calls[1]![0] as TempoMap;
    expect(cleared.sections[0]).not.toHaveProperty('fermata');
    expect(cleared.sections[0]).not.toHaveProperty('breath');
  });

  it.each([
    { label: '추가로 늘일 박 수', toggle: /페르마타/, invalid: '0', valid: '0.5' },
    { label: '추가로 늘일 박 수', toggle: /페르마타/, invalid: '17', valid: '16' },
    { label: '쉬는 시간 (초)', toggle: /쉼표 · 숨 고르기/, invalid: '-1', valid: '0.5' },
    { label: '쉬는 시간 (초)', toggle: /쉼표 · 숨 고르기/, invalid: '301', valid: '300' },
  ])('rejects $label=$invalid and accepts $valid', async ({ label, toggle, invalid, valid }) => {
    renderEditor();
    await screen.findByLabelText('BPM');
    fireEvent.click(screen.getByRole('checkbox', { name: toggle }));
    const input = screen.getByLabelText(label);
    fireEvent.change(input, { target: { value: invalid } });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);
    expect(database.putTempoMap).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: '템포맵 오류를 먼저 고쳐 주세요.' }),
    );
    fireEvent.change(input, { target: { value: valid } });
    expect(input).toHaveAttribute('aria-invalid', 'false');
    fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);
    await waitFor(() => expect(database.putTempoMap).toHaveBeenCalledOnce());
  });

  it('keeps section-end instructions at the original end through split and merge', async () => {
    renderEditor();
    await screen.findByLabelText('BPM');
    fireEvent.click(screen.getByRole('checkbox', { name: /페르마타/ }));
    fireEvent.change(screen.getByLabelText('추가로 늘일 박 수'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /쉼표 · 숨 고르기/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /재개 전 예비박/ }));
    fireEvent.click(screen.getByRole('button', { name: '구간 나누기' }));
    const dialog = screen.getByRole('dialog', { name: '구간 나누기' });
    fireEvent.change(within(dialog).getByRole('spinbutton'), { target: { value: '9' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '나누기' }));
    expect(screen.getByLabelText('추가로 늘일 박 수')).toHaveValue(1.5);
    expect(screen.getByRole('checkbox', { name: /재개 전 예비박/ })).not.toBeChecked();
    fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);
    await waitFor(() => expect(database.putTempoMap).toHaveBeenCalledOnce());
    const split = database.putTempoMap.mock.calls[0]![0] as TempoMap;
    expect(split.sections[0]).toMatchObject({ startMeasure: 1, endMeasure: 8 });
    expect(split.sections[0]).not.toHaveProperty('fermata');
    expect(split.sections[0]).not.toHaveProperty('breath');
    expect(split.sections[1]).toMatchObject({
      startMeasure: 9,
      endMeasure: 16,
      fermata: { extraBeats: 1.5 },
      breath: { durationSec: 2, countIn: false },
    });

    fireEvent.click(screen.getByRole('button', { name: '이전과 합치기' }));
    expect(screen.getByLabelText('추가로 늘일 박 수')).toHaveValue(1.5);
    expect(screen.getByRole('checkbox', { name: /재개 전 예비박/ })).not.toBeChecked();
    fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);
    await waitFor(() => expect(database.putTempoMap).toHaveBeenCalledTimes(2));
    const merged = database.putTempoMap.mock.calls[1]![0] as TempoMap;
    expect(merged.sections).toHaveLength(1);
    expect(merged.sections[0]).toMatchObject({
      startMeasure: 1,
      endMeasure: 16,
      fermata: { extraBeats: 1.5 },
      breath: { durationSec: 2, countIn: false },
    });
  });

  it('sends expressions to the remote revision endpoint and keeps count-in false in the saved cache', async () => {
    authState.user = { id: 'user-1' };
    authState.client.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith('/access') ? { role: 'leader' } : serverResponse(remoteMap('map-1')),
      ),
    );
    authState.client.put.mockImplementation((_path: string, body: { data: TempoMap }) =>
      Promise.resolve(serverResponse({ ...body.data, revision: 4 })),
    );
    renderEditor();
    await screen.findByLabelText('BPM');
    fireEvent.change(screen.getByLabelText('템포 변화'), { target: { value: 'aTempo' } });
    fireEvent.change(screen.getByLabelText('복귀 BPM'), { target: { value: '108' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /페르마타/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /쉼표 · 숨 고르기/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /재개 전 예비박/ }));
    fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);
    const section = {
      bpm: 108,
      tempoChange: { type: 'aTempo', targetBpm: 108 },
      fermata: { extraBeats: 1 },
      breath: { durationSec: 2, countIn: false },
    };
    await waitFor(() =>
      expect(authState.client.put).toHaveBeenCalledWith('/repertoire/map-1/tempomap', {
        expectedRevision: 3,
        data: expect.objectContaining({
          sections: [expect.objectContaining(section)],
        }),
      }),
    );
    await waitFor(() =>
      expect(database.putTempoMap).toHaveBeenLastCalledWith(
        expect.objectContaining({ revision: 4, sections: [expect.objectContaining(section)] }),
        { userId: 'user-1' },
      ),
    );
    expect(screen.getByRole('checkbox', { name: /재개 전 예비박/ })).not.toBeChecked();
  });

  it('prevents merging across a fermata or breath at the preceding boundary', async () => {
    const opening = storedMap.sections[0]!;
    database.getTempoMapForRepertoire.mockResolvedValue({
      ...storedMap,
      sections: [
        { ...opening, endMeasure: 8, breath: { durationSec: 2, countIn: true } },
        { ...opening, id: 'section-2', label: 'B', startMeasure: 9 },
      ],
    });
    renderEditor();
    await screen.findByLabelText('BPM');
    fireEvent.click(screen.getByRole('button', { name: '표' }));
    fireEvent.click(screen.getByRole('button', { name: 'B' }));
    expect(screen.getByRole('button', { name: '이전과 합치기' })).toBeDisabled();
    expect(screen.getByText(/이전 구간 끝의 페르마타·쉼표를 먼저 해제/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /쉼표 · 숨 고르기/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /페르마타/ }));
    fireEvent.click(screen.getByRole('button', { name: 'B' }));
    expect(screen.getByRole('button', { name: '이전과 합치기' })).toBeDisabled();
  });

  it.each(['rit', 'accel', 'none'] as const)(
    'defaults a tempo to the preceding %s reference, allows an explicit BPM and preserves it on save',
    async (type) => {
      const opening = storedMap.sections[0]!;
      database.getTempoMapForRepertoire.mockResolvedValue({
        ...storedMap,
        sections: [
          {
            ...opening,
            endMeasure: 4,
            ...(type !== 'none'
              ? { tempoChange: { type, targetBpm: type === 'rit' ? 80 : 120 } }
              : {}),
          },
          { ...opening, id: 'section-2', label: 'B', startMeasure: 5, endMeasure: 8, bpm: 90 },
          { ...opening, id: 'section-3', label: 'C', startMeasure: 9, bpm: 80 },
        ],
      });
      renderEditor();
      await screen.findByLabelText('BPM');
      fireEvent.click(screen.getByRole('button', { name: '표' }));
      fireEvent.click(screen.getByRole('button', { name: 'C' }));
      fireEvent.change(screen.getByLabelText('템포 변화'), { target: { value: 'aTempo' } });
      expect(screen.getByLabelText('복귀 BPM')).toHaveValue(type === 'none' ? 90 : 100);
      fireEvent.change(screen.getByLabelText('복귀 BPM'), { target: { value: '110' } });
      fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);
      await waitFor(() => expect(database.putTempoMap).toHaveBeenCalledOnce());
      const saved = database.putTempoMap.mock.calls[0]![0] as TempoMap;
      expect(saved.sections[2]?.tempoChange).toEqual({ type: 'aTempo', targetBpm: 110 });
      expect(screen.getByRole('table', { name: '템포 구간' })).toHaveTextContent('아 템포 110');
    },
  );
});

describe('EditorPage unsaved navigation', () => {
  beforeEach(() => {
    database.getTempoMapForRepertoire.mockReset().mockResolvedValue(storedMap);
    database.getTempoMap.mockReset().mockResolvedValue(undefined);
    database.putTempoMap.mockReset().mockResolvedValue(undefined);
    authState.user = null;
    authState.client.get.mockReset();
    authState.client.put.mockReset();
    notify.mockReset();
  });

  afterEach(cleanup);

  it('keeps editing or discards through an accessible navigation dialog', async () => {
    renderEditor();
    await makeDirty();

    fireEvent.click(screen.getByRole('link', { name: '다른 화면' }));
    const firstDialog = await screen.findByRole('dialog', {
      name: '저장하지 않은 변경이 있습니다',
    });
    fireEvent.click(screen.getByRole('button', { name: '계속 편집' }));
    await waitFor(() => expect(firstDialog).not.toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: '이동 완료' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: '다른 화면' }));
    await screen.findByRole('dialog', { name: '저장하지 않은 변경이 있습니다' });
    fireEvent.click(screen.getByRole('button', { name: '변경 버리고 이동' }));
    expect(await screen.findByRole('heading', { name: '이동 완료' })).toBeInTheDocument();
  });

  it('continues only after an asynchronous save succeeds', async () => {
    let completeSave: (() => void) | undefined;
    database.putTempoMap.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeSave = resolve;
        }),
    );
    renderEditor();
    await makeDirty();

    fireEvent.click(screen.getByRole('link', { name: '다른 화면' }));
    const dialog = await screen.findByRole('dialog', {
      name: '저장하지 않은 변경이 있습니다',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '저장 후 이동' }));

    await waitFor(() => expect(database.putTempoMap).toHaveBeenCalledOnce());
    expect(screen.queryByRole('heading', { name: '이동 완료' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '저장 중…' })).toBeDisabled();
    await act(async () => completeSave?.());
    expect(await screen.findByRole('heading', { name: '이동 완료' })).toBeInTheDocument();
  });

  it('does not navigate when saving fails', async () => {
    database.putTempoMap.mockRejectedValueOnce(new Error('disk unavailable'));
    renderEditor();
    await makeDirty();

    fireEvent.click(screen.getByRole('link', { name: '다른 화면' }));
    await screen.findByRole('dialog', { name: '저장하지 않은 변경이 있습니다' });
    fireEvent.click(screen.getByRole('button', { name: '저장 후 이동' }));

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: '저장하지 못했습니다.', tone: 'danger' }),
      ),
    );
    expect(
      screen.getByRole('dialog', { name: '저장하지 않은 변경이 있습니다' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '이동 완료' })).not.toBeInTheDocument();
  });

  it('registers beforeunload only while the loaded map is dirty', async () => {
    renderEditor();
    await screen.findByText('저장됨', { exact: true });

    const cleanEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    await makeDirty();
    const dirtyEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
  });
});

describe('EditorPage remote cache boundary', () => {
  beforeEach(() => {
    database.getTempoMapForRepertoire.mockReset().mockResolvedValue(undefined);
    database.getTempoMap.mockReset().mockResolvedValue(undefined);
    database.putTempoMap.mockReset().mockResolvedValue(undefined);
    authState.user = { id: 'user-1' };
    authState.client.get.mockReset();
    authState.client.put.mockReset();
    notify.mockReset();
  });

  afterEach(cleanup);

  it('uses the authoritative server map when IndexedDB fails and only shows a nonblocking notice', async () => {
    const server = remoteMap('map-1', 144);
    database.getTempoMapForRepertoire.mockRejectedValue(new Error('IndexedDB unavailable'));
    database.getTempoMap.mockRejectedValue(new Error('IndexedDB unavailable'));
    database.putTempoMap.mockRejectedValue(new Error('IndexedDB unavailable'));
    authState.client.get.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith('/access') ? { role: 'leader' } : serverResponse(server)),
    );

    renderEditor();

    expect((await screen.findByLabelText('BPM')) as HTMLInputElement).toHaveValue(144);
    expect(await screen.findByText(/로컬 사본을 읽거나 갱신하지 못했습니다/)).toBeVisible();
    expect(screen.queryByText('오프라인 읽기 전용으로 열었습니다.')).not.toBeInTheDocument();
    for (const button of screen.getAllByRole('button', { name: '저장' })) {
      expect(button).toBeEnabled();
    }
  });

  it('opens a valid current-user cache as read-only only after a network TypeError', async () => {
    const cached = remoteMap('map-1', 132);
    database.getTempoMapForRepertoire.mockResolvedValue(cached);
    authState.client.get.mockRejectedValue(new TypeError('Failed to fetch'));

    renderEditor();

    expect((await screen.findByLabelText('BPM')) as HTMLInputElement).toHaveValue(132);
    expect(await screen.findByText('오프라인 읽기 전용으로 열었습니다.')).toBeVisible();
    expect(screen.getByRole('button', { name: '가져오기' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '내보내기' })).toBeEnabled();
    for (const button of screen.getAllByRole('button', { name: '저장' })) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByLabelText('BPM')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('BPM'), { target: { value: '180' } });
    expect(screen.getByLabelText('BPM')).toHaveValue(132);
    expect(authState.client.put).not.toHaveBeenCalled();
  });

  it('does not hide an HTTP error with the local cache', async () => {
    database.getTempoMapForRepertoire.mockResolvedValue(remoteMap('map-1', 132));
    authState.client.get.mockRejectedValue(new ApiError(403, { detail: 'Forbidden' }));

    renderEditor();

    expect(await screen.findByRole('alert')).toHaveTextContent('템포맵을 불러오지 못했습니다.');
    expect(screen.queryByText('오프라인 읽기 전용으로 열었습니다.')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('BPM')).not.toBeInTheDocument();
  });

  it('clears the offline read-only state after route navigation succeeds online', async () => {
    database.getTempoMapForRepertoire.mockResolvedValue(remoteMap('map-1', 132));
    authState.client.get.mockImplementation((path: string) => {
      if (path.includes('/map-1/')) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(
        path.endsWith('/access') ? { role: 'leader' } : serverResponse(remoteMap('map-2', 156)),
      );
    });

    renderEditor();
    await screen.findByText('오프라인 읽기 전용으로 열었습니다.');
    fireEvent.click(screen.getByRole('link', { name: '다른 템포맵' }));

    await waitFor(() => expect(screen.getByLabelText('BPM')).toHaveValue(156));
    expect(screen.queryByText('오프라인 읽기 전용으로 열었습니다.')).not.toBeInTheDocument();
    for (const button of screen.getAllByRole('button', { name: '저장' })) {
      expect(button).toBeEnabled();
    }
  });

  it.each(['owner', 'leader'])(
    'allows a %s to create the first map only after confirming an empty revision history',
    async (role) => {
      authState.client.get.mockImplementation((path: string) => {
        if (path.endsWith('/access')) return Promise.resolve({ role });
        if (path.endsWith('/revisions')) return Promise.resolve([]);
        return Promise.reject(new ApiError(404, { detail: 'tempo map not found' }));
      });
      authState.client.put.mockImplementation((_path: string, body: { data: TempoMap }) =>
        Promise.resolve(serverResponse({ ...body.data, revision: 1 })),
      );

      renderEditor();
      const bpm = await screen.findByLabelText('BPM');
      expect(bpm).toBeEnabled();
      expect(database.putTempoMap).not.toHaveBeenCalled();
      fireEvent.change(bpm, { target: { value: '150' } });
      fireEvent.click(screen.getAllByRole('button', { name: '저장' })[0]!);

      await waitFor(() =>
        expect(authState.client.put).toHaveBeenCalledWith(
          '/repertoire/map-1/tempomap',
          expect.objectContaining({
            expectedRevision: 0,
            data: expect.objectContaining({ repertoireItemId: 'map-1', revision: 0 }),
          }),
        ),
      );
      expect(await screen.findByText('저장됨', { exact: true })).toBeVisible();
    },
  );

  it.each([403, 404])('does not create a map when repertoire access returns %s', async (status) => {
    authState.client.get.mockRejectedValue(
      new ApiError(status, { detail: 'repertoire unavailable' }),
    );
    renderEditor();

    expect(await screen.findByRole('alert')).toHaveTextContent('repertoire unavailable');
    expect(screen.queryByLabelText('BPM')).not.toBeInTheDocument();
    expect(authState.client.get).toHaveBeenCalledExactlyOnceWith('/repertoire/map-1/access');
    expect(authState.client.put).not.toHaveBeenCalled();
  });

  it('does not replace an existing history with a new map after an inconsistent latest-map 404', async () => {
    authState.client.get.mockImplementation((path: string) => {
      if (path.endsWith('/access')) return Promise.resolve({ role: 'leader' });
      if (path.endsWith('/revisions')) return Promise.resolve([serverResponse(remoteMap('map-1'))]);
      return Promise.reject(new ApiError(404, { detail: 'tempo map not found' }));
    });
    renderEditor();

    expect(await screen.findByRole('alert')).toHaveTextContent('tempo map not found');
    expect(screen.queryByLabelText('BPM')).not.toBeInTheDocument();
    expect(database.putTempoMap).not.toHaveBeenCalled();
  });

  it('does not hide a latest-map 404 with cached data when checking the empty history fails', async () => {
    database.getTempoMapForRepertoire.mockResolvedValue(remoteMap('map-1', 132));
    authState.client.get.mockImplementation((path: string) => {
      if (path.endsWith('/access')) return Promise.resolve({ role: 'leader' });
      if (path.endsWith('/revisions')) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.reject(new ApiError(404, { detail: 'tempo map not found' }));
    });
    renderEditor();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '첫 템포맵을 만들 수 있는지 확인하지 못했습니다',
    );
    expect(screen.queryByText('오프라인 읽기 전용으로 열었습니다.')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('BPM')).not.toBeInTheDocument();
  });

  it('keeps a member read-only and exposes playback and score navigation', async () => {
    authState.client.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith('/access') ? { role: 'member' } : serverResponse(remoteMap('map-1')),
      ),
    );
    renderEditor('/editor/map-1?score=score-1');

    expect(await screen.findByLabelText('BPM')).toBeDisabled();
    expect(screen.getByRole('button', { name: '가져오기' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '메트로놈에서 열기' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '악보로 돌아가기' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('BPM'), { target: { value: '180' } });
    expect(screen.getByLabelText('BPM')).toHaveValue(100);
    expect(authState.client.put).not.toHaveBeenCalled();
  });

  it('does not open an unsaved first-map draft for a member', async () => {
    authState.client.get.mockImplementation((path: string) => {
      if (path.endsWith('/access')) return Promise.resolve({ role: 'member' });
      if (path.endsWith('/revisions')) return Promise.resolve([]);
      return Promise.reject(new ApiError(404, { detail: 'tempo map not found' }));
    });
    renderEditor();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '프로젝트 리더에게 첫 템포맵 작성을 요청',
    );
    expect(screen.queryByLabelText('BPM')).not.toBeInTheDocument();
    expect(database.putTempoMap).not.toHaveBeenCalled();
  });
});
