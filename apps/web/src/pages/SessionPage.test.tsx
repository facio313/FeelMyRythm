import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type * as FeelMyRythmUi from '@feelmyrythm/ui';
import type { TempoMap } from '@feelmyrythm/core';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomSnapshot } from '../lib/roomClient';
import type { ScoresPageProps } from './ScoresPage';

const authState = vi.hoisted(() => ({
  user: {
    id: 'user-1',
    email: 'player@example.test',
    displayName: 'Player',
  } as { id: string; email: string; displayName: string } | null,
  tokens: {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    tokenType: 'bearer',
  } as { accessToken: string; refreshToken: string; tokenType: string } | null,
  client: {
    get: vi.fn<(path: string) => Promise<unknown>>(() => new Promise(() => undefined)),
    post: vi.fn(),
    refreshAccessToken: vi.fn(),
  },
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
  prepareAudio: vi.fn<() => Promise<void>>(),
  start: vi.fn(),
  startSynchronized: vi.fn(),
  stop: vi.fn(),
  setVolume: vi.fn(),
}));
const metronomeHook = vi.hoisted(() => vi.fn());
const scoreBoundary = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());
const roomState = vi.hoisted(() => ({
  snapshot: undefined as RoomSnapshot | undefined,
  listener: undefined as ((snapshot: RoomSnapshot) => void) | undefined,
}));
const roomClient = vi.hoisted(() => ({
  subscribe: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  setReady: vi.fn(),
}));
const createRoomClient = vi.hoisted(() =>
  vi.fn(function () {
    return roomClient;
  }),
);
const workspaceState = vi.hoisted(() => ({
  data: { groups: [], failures: [] } as { groups: unknown[]; failures: unknown[] },
  loading: false,
  error: undefined as Error | undefined,
  reload: vi.fn(),
}));

vi.mock('../lib/auth', () => ({ useAuth: () => authState }));
vi.mock('../lib/useAsync', () => ({
  useAsync: () => workspaceState,
}));
vi.mock('../lib/useMetronome', () => ({ useMetronome: metronomeHook }));
vi.mock('../lib/roomClient', () => ({ RoomClient: createRoomClient }));
vi.mock('./ScoresPage', () => ({
  ScoresPage: (props: ScoresPageProps) => {
    scoreBoundary(props);
    return (
      <div aria-label="세션 악보">고정 악보 r{props.synchronizedPlayback?.tempoMap.revision}</div>
    );
  },
}));
vi.mock('@feelmyrythm/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof FeelMyRythmUi>();
  return {
    ...actual,
    useToast: () => ({ notify }),
    BeatVisualizer: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
  };
});

import {
  describeRoomConnection,
  hasDetectedBluetooth,
  readBluetoothDetectionStatus,
  SessionMobileControls,
  SessionPage,
  shouldStopRoomAfterLocalEnd,
} from './SessionPage';

const fixedTempoMap: TempoMap = {
  id: 'room-map',
  repertoireItemId: 'repertoire-1',
  revision: 2,
  totalMeasures: 4,
  sections: [
    {
      id: 'section-1',
      startMeasure: 1,
      endMeasure: 4,
      timeSignature: { num: 3, denom: 4 },
      bpm: 150,
      beatUnit: 'quarter',
    },
  ],
  jumps: [],
  countIn: { measures: 1, useSectionMeter: true },
};

function joinedSnapshot(role: 'leader' | 'member' = 'leader'): RoomSnapshot {
  return {
    transport: {
      roomId: 'room-1',
      repertoireId: fixedTempoMap.repertoireItemId,
      revision: fixedTempoMap.revision,
      status: 'stopped',
      countIn: false,
    },
    roster: [
      {
        userId: 'user-1',
        displayName: 'Player',
        role,
        ready: false,
        calibrated: true,
        bluetooth: false,
      },
      {
        userId: 'user-2',
        displayName: 'Partner',
        role: 'member',
        ready: true,
        calibrated: true,
        bluetooth: false,
      },
    ],
    connectionState: 'joined',
    connected: true,
    reconnecting: false,
    offsetMs: 12,
    rttMs: 20,
    error: undefined,
  };
}

function RouteLocation() {
  const location = useLocation();
  return <output aria-label="현재 경로">{location.pathname}</output>;
}

async function renderJoinedSession(snapshot = joinedSnapshot()) {
  roomState.snapshot = snapshot;
  authState.client.get.mockImplementation(async (path) => {
    if (path === '/rooms/room-1') {
      return {
        roomId: 'room-1',
        repertoireId: fixedTempoMap.repertoireItemId,
        tempoMapRevision: fixedTempoMap.revision,
        leaderId: 'user-1',
        expiresAt: '2026-09-29T00:00:00.000Z',
      };
    }
    if (path === '/repertoire/repertoire-1/tempomap/revisions/2') {
      return { revision: fixedTempoMap.revision, data: fixedTempoMap };
    }
    throw new Error(`Unexpected request ${path}`);
  });
  const view = render(
    <MemoryRouter initialEntries={['/session/room-1']}>
      <RouteLocation />
      <Routes>
        <Route path="session/:roomId" element={<SessionPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText('동기화됨');
  return view;
}

describe('session device status', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
    authState.user = {
      id: 'user-1',
      email: 'player@example.test',
      displayName: 'Player',
    };
    authState.tokens = {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tokenType: 'bearer',
    };
    authState.client.get.mockReset().mockImplementation(() => new Promise(() => undefined));
    metronome.playing = false;
    metronome.prepareAudio.mockReset().mockResolvedValue(undefined);
    metronome.startSynchronized.mockReset().mockResolvedValue(undefined);
    metronome.stop.mockReset();
    metronomeHook.mockReset().mockReturnValue(metronome);
    scoreBoundary.mockReset();
    notify.mockReset();
    roomState.snapshot = undefined;
    roomState.listener = undefined;
    createRoomClient.mockClear();
    roomClient.connect.mockReset();
    roomClient.disconnect.mockReset();
    roomClient.start.mockReset().mockReturnValue(true);
    roomClient.stop.mockReset().mockReturnValue(true);
    roomClient.setReady.mockReset().mockReturnValue(true);
    roomClient.subscribe
      .mockReset()
      .mockImplementation((listener: (snapshot: RoomSnapshot) => void) => {
        roomState.listener = listener;
        if (roomState.snapshot) listener(roomState.snapshot);
        return vi.fn();
      });
    workspaceState.data = { groups: [], failures: [] };
    workspaceState.loading = false;
    workspaceState.error = undefined;
    workspaceState.reload.mockReset();
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(navigator, 'clipboard');
    vi.unstubAllGlobals();
  });

  it('reports a detected Bluetooth output to the room client', () => {
    expect(hasDetectedBluetooth({ getItem: () => 'true' })).toBe(true);
    expect(hasDetectedBluetooth({ getItem: () => 'false' })).toBe(false);
    expect(hasDetectedBluetooth({ getItem: () => null })).toBe(false);
  });

  it('treats a missing or invalid detection status as unknown', () => {
    expect(readBluetoothDetectionStatus({ getItem: () => null })).toBe('unknown');
    expect(readBluetoothDetectionStatus({ getItem: () => 'invalid' })).toBe('unknown');
    expect(readBluetoothDetectionStatus({ getItem: () => 'detected' })).toBe('detected');
    expect(readBluetoothDetectionStatus({ getItem: () => 'not-detected' })).toBe('not-detected');
  });

  it('exposes distinct connection states for assistive status messaging', () => {
    expect(describeRoomConnection('idle')).toEqual({
      label: '연결 준비 중',
      tone: 'neutral',
    });
    expect(describeRoomConnection('connecting').label).toBe('세션 인증 중');
    expect(describeRoomConnection('authenticating').label).toBe('인증 갱신 중');
    expect(describeRoomConnection('joined')).toEqual({ label: '동기화됨', tone: 'success' });
    expect(describeRoomConnection('reconnecting').label).toBe('재연결 중');
    expect(describeRoomConnection('offline')).toEqual({ label: '오프라인', tone: 'danger' });
    expect(describeRoomConnection('closed')).toEqual({ label: '연결 종료됨', tone: 'danger' });
  });

  it('stops local playback when authentication is lost without unmounting the route', () => {
    const view = () => (
      <MemoryRouter initialEntries={['/session/room-1']}>
        <Routes>
          <Route path="session/:roomId" element={<SessionPage />} />
        </Routes>
      </MemoryRouter>
    );
    const { rerender } = render(view());
    expect(metronome.stop).not.toHaveBeenCalled();

    authState.user = null;
    authState.tokens = null;
    rerender(view());
    expect(metronome.stop).toHaveBeenCalledOnce();
  });

  it('keeps local playback running when an authenticated token rotates', () => {
    const view = () => (
      <MemoryRouter initialEntries={['/session/room-1']}>
        <Routes>
          <Route path="session/:roomId" element={<SessionPage />} />
        </Routes>
      </MemoryRouter>
    );
    const { rerender } = render(view());

    authState.tokens = {
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      tokenType: 'bearer',
    };
    rerender(view());

    expect(metronome.stop).not.toHaveBeenCalled();
  });

  it('shows a selectable invitation URL when clipboard permission is denied', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <MemoryRouter initialEntries={['/session/room-1']}>
        <Routes>
          <Route path="session/:roomId" element={<SessionPage />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: '초대 링크' }));

    const fallback = await screen.findByRole('alert');
    expect(fallback).toHaveTextContent('초대 링크를 직접 복사해 주세요.');
    expect(screen.getByRole('textbox', { name: '초대 링크' })).toHaveValue(
      `${window.location.origin}/feelmyrythm/session/room-1`,
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledOnce();
    });
  });

  it('requests one server stop only for a leader local-playing to ended transition', () => {
    const base = {
      canControl: true,
      connectionState: 'joined' as const,
      transportStatus: 'playing' as const,
    };
    expect(shouldStopRoomAfterLocalEnd({ ...base, wasPlaying: true, playing: false })).toBe(true);
    expect(shouldStopRoomAfterLocalEnd({ ...base, wasPlaying: false, playing: false })).toBe(false);
    expect(
      shouldStopRoomAfterLocalEnd({
        ...base,
        transportStatus: 'stopped',
        wasPlaying: true,
        playing: false,
      }),
    ).toBe(false);
  });

  it('keeps roster, ready, and leader transport actions in the compact control group', () => {
    const onOpenRoster = vi.fn();
    const onToggleReady = vi.fn();
    const onStart = vi.fn();
    render(
      <SessionMobileControls
        participantCount={3}
        rosterOpen={false}
        ready={false}
        canControl
        controlsEnabled
        transportActive={false}
        onOpenRoster={onOpenRoster}
        onToggleReady={onToggleReady}
        onStart={onStart}
        onStop={vi.fn()}
      />,
    );

    const group = screen.getByRole('group', { name: '세션 빠른 조작' });
    const roster = screen.getByRole('button', { name: /참가자/ });
    expect(roster).toHaveAttribute('aria-haspopup', 'dialog');
    expect(roster).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(roster);
    fireEvent.click(screen.getByRole('button', { name: '준비' }));
    fireEvent.click(screen.getByRole('button', { name: '시작' }));

    expect(group.querySelectorAll('button')).toHaveLength(3);
    expect(onOpenRoster).toHaveBeenCalledOnce();
    expect(onToggleReady).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('keeps roster details available but gates ready and transport while reconnecting', () => {
    render(
      <SessionMobileControls
        participantCount={1}
        rosterOpen
        ready
        canControl
        controlsEnabled={false}
        transportActive
        onOpenRoster={vi.fn()}
        onToggleReady={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /참가자/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: '준비 취소' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '정지' })).toBeDisabled();
  });

  it('does not expose leader transport to a member', () => {
    render(
      <SessionMobileControls
        participantCount={2}
        rosterOpen={false}
        ready={false}
        canControl={false}
        controlsEnabled
        transportActive={false}
        onOpenRoster={vi.fn()}
        onToggleReady={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /참가자/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: '준비' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '시작' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '정지' })).not.toBeInTheDocument();
  });

  it('keeps healthy session repertoire selectable while offering a partial-load retry', () => {
    workspaceState.data = {
      groups: [
        {
          id: 'group-1',
          name: 'Quartet',
          myRole: 'leader',
          memberCount: 0,
          members: [],
          projects: [
            {
              id: 'project-1',
              groupId: 'group-1',
              name: 'Concert',
              repertoire: [
                {
                  id: 'repertoire-1',
                  projectId: 'project-1',
                  title: 'Available suite',
                  currentTempoMapRevision: 4,
                },
              ],
            },
          ],
        },
      ],
      failures: [
        {
          section: 'repertoire',
          groupId: 'group-1',
          groupName: 'Quartet',
          projectId: 'project-2',
          projectName: 'Chamber',
          message: '503 Service Unavailable',
        },
      ],
    };

    render(
      <MemoryRouter initialEntries={['/session']}>
        <Routes>
          <Route path="session" element={<SessionPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('option', { name: 'Available suite · rev.4' })).toBeInTheDocument();
    expect(
      screen.getByText(
        '작업 공간 일부를 불러오지 못했습니다. 표시된 레퍼토리는 그대로 사용할 수 있습니다.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '누락된 정보 다시 시도' }));
    expect(workspaceState.reload).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '세션 열기' })).toBeEnabled();
  });

  it('opens and closes scores without leaving the room or replacing its fixed playback revision', async () => {
    await renderJoinedSession();
    expect(createRoomClient).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '악보 보기' }));

    expect(screen.getByLabelText('세션 악보')).toHaveTextContent('고정 악보 r2');
    expect(scoreBoundary).toHaveBeenLastCalledWith({
      repertoireItemId: 'repertoire-1',
      synchronizedPlayback: {
        tempoMap: fixedTempoMap,
        playing: false,
        position: metronome.position,
        frameSource: metronome.frameSource,
      },
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent('fmr:tempomap-updated', {
          detail: {
            repertoireId: 'repertoire-1',
            revision: 3,
            data: { ...fixedTempoMap, revision: 3 },
          },
        }),
      );
    });
    expect(metronomeHook).toHaveBeenLastCalledWith(fixedTempoMap);
    expect(screen.getByLabelText('세션 악보')).toHaveTextContent('고정 악보 r2');
    expect(authState.client.get.mock.calls.map(([path]) => path)).toEqual([
      '/rooms/room-1',
      '/repertoire/repertoire-1/tempomap/revisions/2',
    ]);

    fireEvent.click(screen.getByRole('button', { name: '박자 크게' }));
    expect(screen.queryByLabelText('세션 악보')).not.toBeInTheDocument();
    expect(screen.getByLabelText('현재 경로')).toHaveTextContent('/session/room-1');
    expect(createRoomClient).toHaveBeenCalledOnce();
    expect(roomClient.connect).toHaveBeenCalledOnce();
    expect(roomClient.disconnect).not.toHaveBeenCalled();
    expect(metronome.stop).not.toHaveBeenCalled();
  });

  it('shows each participant readiness and updates the total from the server roster', async () => {
    const snapshot = joinedSnapshot();
    await renderJoinedSession(snapshot);
    const partnerRow = screen.getByText('Partner').closest('.participant-row');
    const playerRow = screen.getByText('Player').closest('.participant-row');
    expect(partnerRow).not.toBeNull();
    expect(playerRow).not.toBeNull();
    expect(within(partnerRow as HTMLElement).getByText('준비 완료')).toBeInTheDocument();
    expect(within(playerRow as HTMLElement).getByText('준비 중')).toBeInTheDocument();
    expect(screen.getByText('준비 1/2명')).toBeInTheDocument();

    act(() => {
      roomState.listener?.({
        ...snapshot,
        roster: snapshot.roster.map((participant) => ({ ...participant, ready: true })),
      });
    });
    expect(within(playerRow as HTMLElement).getByText('준비 완료')).toBeInTheDocument();
    expect(screen.getByText('준비 2/2명')).toBeInTheDocument();
  });

  it.each(['준비 완료', '3초 뒤 시작'])(
    'prepares local audio before %s and blocks duplicate ready/start commands',
    async (action) => {
      let completePreparation: (() => void) | undefined;
      metronome.prepareAudio.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            completePreparation = resolve;
          }),
      );
      await renderJoinedSession();

      fireEvent.click(screen.getByRole('button', { name: action }));
      fireEvent.click(screen.getByRole('button', { name: '준비 완료' }));
      fireEvent.click(screen.getByRole('button', { name: '3초 뒤 시작' }));
      expect(metronome.prepareAudio).toHaveBeenCalledOnce();
      expect(roomClient.setReady).not.toHaveBeenCalled();
      expect(roomClient.start).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: '준비 완료' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '3초 뒤 시작' })).toBeDisabled();

      await act(async () => {
        completePreparation?.();
      });
      if (action === '준비 완료') {
        expect(roomClient.setReady).toHaveBeenCalledExactlyOnceWith(true);
        expect(roomClient.start).not.toHaveBeenCalled();
      } else {
        expect(roomClient.start).toHaveBeenCalledExactlyOnceWith({ measure: 1, pass: 1 }, true);
        expect(roomClient.setReady).not.toHaveBeenCalled();
      }
      fireEvent.click(screen.getByRole('button', { name: action }));
      expect(metronome.prepareAudio).toHaveBeenCalledOnce();
    },
  );

  it.each([0, 12])(
    'waits for the late participant audio gesture before scheduling transport at %dms offset',
    async (offsetMs) => {
      const snapshot = joinedSnapshot('member');
      snapshot.offsetMs = offsetMs;
      snapshot.transport = {
        ...snapshot.transport!,
        status: 'playing',
        anchor: { measure: 2, pass: 1 },
        serverStartTime: 500_000,
      };
      await renderJoinedSession(snapshot);
      expect(metronome.prepareAudio).not.toHaveBeenCalled();
      expect(metronome.startSynchronized).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: '소리 켜고 합류' }));
      await waitFor(() =>
        expect(metronome.startSynchronized).toHaveBeenCalledExactlyOnceWith({
          measure: 2,
          pass: 1,
          serverStartTimeMs: 500_000,
          serverOffsetMs: offsetMs,
          withCountIn: false,
        }),
      );
      expect(metronome.prepareAudio).toHaveBeenCalledOnce();
      expect(roomClient.start).not.toHaveBeenCalled();
    },
  );
});
