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

function renderEditor() {
  const router = createMemoryRouter(
    [
      { path: '/editor/:tempoMapId', element: <EditorRoute /> },
      { path: '/destination', element: <h1>이동 완료</h1> },
    ],
    { initialEntries: ['/editor/map-1'] },
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
    authState.client.get.mockResolvedValue(serverResponse(server));

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
    authState.client.get
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(serverResponse(remoteMap('map-2', 156)));

    renderEditor();
    await screen.findByText('오프라인 읽기 전용으로 열었습니다.');
    fireEvent.click(screen.getByRole('link', { name: '다른 템포맵' }));

    await waitFor(() => expect(screen.getByLabelText('BPM')).toHaveValue(156));
    expect(screen.queryByText('오프라인 읽기 전용으로 열었습니다.')).not.toBeInTheDocument();
    for (const button of screen.getAllByRole('button', { name: '저장' })) {
      expect(button).toBeEnabled();
    }
  });
});
