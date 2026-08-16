import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type * as FeelMyRythmUi from '@feelmyrythm/ui';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    get: vi.fn(() => new Promise(() => undefined)),
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
  start: vi.fn(),
  startSynchronized: vi.fn(),
  stop: vi.fn(),
  setVolume: vi.fn(),
}));
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
vi.mock('../lib/useMetronome', () => ({ useMetronome: () => metronome }));
vi.mock('@feelmyrythm/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof FeelMyRythmUi>();
  return { ...actual, useToast: () => ({ notify: vi.fn() }) };
});

import {
  describeRoomConnection,
  hasDetectedBluetooth,
  readBluetoothDetectionStatus,
  SessionMobileControls,
  SessionPage,
  shouldStopRoomAfterLocalEnd,
} from './SessionPage';

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
    authState.client.get.mockClear();
    metronome.stop.mockClear();
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
    expect(screen.getByLabelText('초대 링크')).toHaveValue(window.location.href);
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
});
