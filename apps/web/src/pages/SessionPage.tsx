import { BeatVisualizer, Button, Card, Field, Modal, StatusBadge, useToast } from '@feelmyrythm/ui';
import { assertValidTempoMap, type TempoMap } from '@feelmyrythm/core';
import type { components } from '@feelmyrythm/protocol';
import {
  Bluetooth,
  CheckCircle2,
  Copy,
  LogIn,
  Play,
  Radio,
  RotateCw,
  Square,
  UsersRound,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/useAsync';
import { useMetronome } from '../lib/useMetronome';
import { loadWorkspace } from '../lib/workspace';
import { createDefaultTempoMap } from '../lib/defaultTempoMap';
import { RoomClient, type RoomConnectionState, type RoomSnapshot } from '../lib/roomClient';
import { roomRefMatches, sessionPathForJoinInput } from '../lib/roomJoin';

type CreatedRoom = components['schemas']['RoomOut'];
type ServerTempoMap = components['schemas']['TempoMapOut'];
type Participant = RoomSnapshot['roster'][number];
type PendingSessionCommand =
  | { kind: 'ready'; targetReady: boolean }
  | { kind: 'transport'; baseline: RoomSnapshot['transport'] };

const initialSnapshot: RoomSnapshot = {
  transport: null,
  roster: [],
  connectionState: 'idle',
  connected: false,
  reconnecting: false,
  offsetMs: 0,
  rttMs: Number.POSITIVE_INFINITY,
  error: undefined,
};

export function describeRoomConnection(state: RoomConnectionState): {
  label: string;
  tone: 'neutral' | 'success' | 'danger' | 'info' | 'warning';
} {
  switch (state) {
    case 'connecting':
      return { label: '세션 인증 중', tone: 'info' };
    case 'authenticating':
      return { label: '인증 갱신 중', tone: 'warning' };
    case 'joined':
      return { label: '동기화됨', tone: 'success' };
    case 'reconnecting':
      return { label: '재연결 중', tone: 'warning' };
    case 'offline':
      return { label: '오프라인', tone: 'danger' };
    case 'closed':
      return { label: '연결 종료됨', tone: 'danger' };
    case 'idle':
      return { label: '연결 준비 중', tone: 'neutral' };
  }
  return { label: '연결 상태 확인 중', tone: 'neutral' };
}

export function hasDetectedBluetooth(storage: Pick<Storage, 'getItem'>): boolean {
  return storage.getItem('fmr.bluetoothDetected') === 'true';
}

export function readBluetoothDetectionStatus(
  storage: Pick<Storage, 'getItem'>,
): 'unknown' | 'detected' | 'not-detected' {
  const status = storage.getItem('fmr.bluetoothDetectionStatus');
  return status === 'detected' || status === 'not-detected' ? status : 'unknown';
}

export function shouldStopRoomAfterLocalEnd(options: {
  wasPlaying: boolean;
  playing: boolean;
  canControl: boolean;
  connectionState: RoomConnectionState;
  transportStatus: NonNullable<RoomSnapshot['transport']>['status'] | undefined;
}): boolean {
  return (
    options.wasPlaying &&
    !options.playing &&
    options.canControl &&
    options.connectionState === 'joined' &&
    (options.transportStatus === 'armed' || options.transportStatus === 'playing')
  );
}

function ParticipantList({ participants }: { participants: Participant[] }) {
  return (
    <div className="roster-list">
      {participants.length === 0 ? (
        <p className="roster-list__empty" role="status">
          참가자 연결을 기다리고 있습니다.
        </p>
      ) : null}
      {participants.map((participant) => (
        <div key={participant.userId} className="participant-row">
          <span className="participant-avatar" aria-hidden>
            {participant.displayName.slice(0, 1)}
          </span>
          <span>
            <strong>{participant.displayName}</strong>
            <small>{participant.role}</small>
          </span>
          <div className="participant-signals">
            {participant.calibrated ? (
              <CheckCircle2 size={16} aria-label="출력 지연 보정됨" />
            ) : (
              <StatusBadge tone="warning">미보정</StatusBadge>
            )}
            {participant.bluetooth ? (
              <Bluetooth className="warning-icon" size={16} aria-label="블루투스 사용 중" />
            ) : null}
            <span className="fmr-tabular">{participant.rttMs?.toFixed(0) ?? '—'}ms</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function SessionMobileControls({
  participantCount,
  rosterOpen,
  ready,
  canControl,
  controlsEnabled,
  transportActive,
  onOpenRoster,
  onToggleReady,
  onStart,
  onStop,
}: {
  participantCount: number;
  rosterOpen: boolean;
  ready: boolean;
  canControl: boolean;
  controlsEnabled: boolean;
  transportActive: boolean;
  onOpenRoster: () => void;
  onToggleReady: () => void;
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <div
      className={`session-mobile-bar${canControl ? ' session-mobile-bar--leader' : ''}`}
      role="group"
      aria-label="세션 빠른 조작"
    >
      <Button
        className="session-mobile-bar__button"
        variant="secondary"
        onClick={onOpenRoster}
        aria-haspopup="dialog"
        aria-expanded={rosterOpen}
      >
        <UsersRound size={18} aria-hidden />
        <span>참가자</span>
        <StatusBadge>{participantCount}</StatusBadge>
      </Button>
      <Button
        className="session-mobile-bar__button"
        onClick={onToggleReady}
        variant={ready ? 'secondary' : 'primary'}
        disabled={!controlsEnabled}
      >
        <CheckCircle2 size={18} aria-hidden /> {ready ? '준비 취소' : '준비'}
      </Button>
      {canControl ? (
        transportActive ? (
          <Button
            className="session-mobile-bar__button"
            variant="primary"
            disabled={!controlsEnabled}
            onClick={onStop}
          >
            <Square size={18} fill="currentColor" aria-hidden /> 정지
          </Button>
        ) : (
          <Button
            className="session-mobile-bar__button"
            variant="primary"
            disabled={!controlsEnabled}
            onClick={onStart}
          >
            <Play size={18} fill="currentColor" aria-hidden /> 시작
          </Button>
        )
      ) : null}
    </div>
  );
}

export function SessionPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, tokens, client: api } = useAuth();
  const { notify } = useToast();
  const roomClientRef = useRef<RoomClient | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<RoomSnapshot>(initialSnapshot);
  const [joinCode, setJoinCode] = useState('');
  const [anchorMeasure, setAnchorMeasure] = useState(1);
  const [anchorPass, setAnchorPass] = useState(1);
  const [withCountIn, setWithCountIn] = useState(true);
  const [creating, setCreating] = useState(false);
  const [selectedRepertoireId, setSelectedRepertoireId] = useState('');
  const [roomMetadata, setRoomMetadata] = useState<CreatedRoom>();
  const [roomLoadError, setRoomLoadError] = useState<string>();
  const [roomLoadAttempt, setRoomLoadAttempt] = useState(0);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [inviteFallbackUrl, setInviteFallbackUrl] = useState<string>();
  const [pendingCommand, setPendingCommand] = useState<PendingSessionCommand['kind']>();
  const pendingCommandRef = useRef<PendingSessionCommand | null>(null);
  const pendingCommandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tempoMap, setTempoMap] = useState<TempoMap>(() => createDefaultTempoMap());
  const workspace = useAsync(
    async () => (user ? loadWorkspace(api) : { groups: [], failures: [] }),
    [api, user?.id],
  );
  const availableRepertoire = useMemo(
    () =>
      (workspace.data?.groups ?? [])
        .filter((group) => group.myRole === 'owner' || group.myRole === 'leader')
        .flatMap((group) => group.projects.flatMap((project) => project.repertoire))
        .filter((item) => item.currentTempoMapRevision > 0),
    [workspace.data],
  );
  const repertoireId = selectedRepertoireId || availableRepertoire[0]?.id || '';
  const metronome = useMetronome(tempoMap);
  const { playing, startSynchronized, stop: stopMetronome } = metronome;
  const scheduledStartRef = useRef<number | undefined>(undefined);
  const previousLocalPlayingRef = useRef(playing);
  const hasAuthSession = Boolean(user && tokens);
  const roomAuthRefreshRef = useRef<{ roomId: string | undefined; attempted: boolean }>({
    roomId,
    attempted: false,
  });

  const clearPendingCommand = useCallback(() => {
    if (pendingCommandTimerRef.current) clearTimeout(pendingCommandTimerRef.current);
    pendingCommandTimerRef.current = null;
    pendingCommandRef.current = null;
    setPendingCommand(undefined);
  }, []);

  const beginPendingCommand = useCallback(
    (command: PendingSessionCommand) => {
      pendingCommandRef.current = command;
      setPendingCommand(command.kind);
      if (pendingCommandTimerRef.current) clearTimeout(pendingCommandTimerRef.current);
      pendingCommandTimerRef.current = setTimeout(() => {
        pendingCommandTimerRef.current = null;
        pendingCommandRef.current = null;
        setPendingCommand(undefined);
        notify({
          title: '세션 명령 응답이 지연되고 있습니다.',
          description: '연결 상태를 확인한 뒤 다시 시도해 주세요.',
          tone: 'danger',
        });
      }, 5_000);
    },
    [notify],
  );

  const acknowledgePendingCommand = useCallback(
    (nextSnapshot: RoomSnapshot) => {
      const pending = pendingCommandRef.current;
      if (!pending) return;
      if (nextSnapshot.connectionState !== 'joined' || nextSnapshot.error) {
        clearPendingCommand();
        return;
      }
      if (pending.kind === 'transport' && nextSnapshot.transport !== pending.baseline) {
        clearPendingCommand();
        return;
      }
      if (pending.kind === 'ready') {
        const nextMe = nextSnapshot.roster.find((participant) => participant.userId === user?.id);
        if (nextMe?.ready === pending.targetReady) clearPendingCommand();
      }
    },
    [clearPendingCommand, user?.id],
  );

  useEffect(
    () => () => {
      if (pendingCommandTimerRef.current) clearTimeout(pendingCommandTimerRef.current);
      pendingCommandTimerRef.current = null;
      pendingCommandRef.current = null;
    },
    [],
  );

  const refreshRoomAuthorization = useCallback(
    async (rejectedAccessToken: string): Promise<string | null> => {
      if (!roomId) return null;
      if (roomAuthRefreshRef.current.roomId !== roomId) {
        roomAuthRefreshRef.current = { roomId, attempted: false };
      }
      if (roomAuthRefreshRef.current.attempted) return null;
      roomAuthRefreshRef.current.attempted = true;
      try {
        const refreshed = await api.refreshAccessToken(rejectedAccessToken);
        return refreshed.accessToken;
      } catch {
        return null;
      }
    },
    [api, roomId],
  );

  useEffect(
    () => () => {
      stopMetronome();
      scheduledStartRef.current = undefined;
      previousLocalPlayingRef.current = false;
    },
    [hasAuthSession, roomId, stopMetronome, user?.id],
  );

  useEffect(() => {
    if (!roomId || !tokens) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setRoomMetadata(undefined);
      setRoomLoadError(undefined);
      setSnapshot(initialSnapshot);
    });
    void api
      .get<CreatedRoom>(`/rooms/${roomId}`)
      .then(async (room) => {
        const response = await api.get<ServerTempoMap>(
          `/repertoire/${room.repertoireId}/tempomap/revisions/${room.tempoMapRevision}`,
        );
        if (cancelled) return;
        const data: unknown = response.data;
        assertValidTempoMap(data);
        setRoomLoadError(undefined);
        setRoomMetadata(room);
        setTempoMap({
          ...data,
          repertoireItemId: room.repertoireId,
          revision: response.revision,
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRoomLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, roomId, roomLoadAttempt, tokens]);

  useEffect(() => {
    if (
      !roomId ||
      !tokens ||
      roomMetadata == null ||
      !roomRefMatches(roomMetadata, roomId) ||
      tempoMap.revision !== roomMetadata.tempoMapRevision
    ) {
      return;
    }
    const roomClient = new RoomClient(
      roomMetadata.roomId,
      tokens.accessToken,
      {
        ...(localStorage.getItem('fmr.serverCalibrationId')
          ? { calibrationId: localStorage.getItem('fmr.serverCalibrationId')! }
          : {}),
        bluetooth: hasDetectedBluetooth(localStorage),
      },
      { onUnauthorized: refreshRoomAuthorization },
    );
    roomClientRef.current = roomClient;
    const unsubscribe = roomClient.subscribe((nextSnapshot) => {
      if (nextSnapshot.connectionState === 'joined') {
        roomAuthRefreshRef.current = { roomId, attempted: false };
      }
      acknowledgePendingCommand(nextSnapshot);
      setSnapshot(nextSnapshot);
    });
    roomClient.connect();
    return () => {
      unsubscribe();
      roomClient.disconnect();
      roomClientRef.current = undefined;
    };
  }, [
    acknowledgePendingCommand,
    refreshRoomAuthorization,
    roomId,
    roomMetadata,
    tempoMap.revision,
    tokens,
  ]);

  useEffect(() => {
    if (!roomMetadata) return;
    const reloadTempoMap = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      if (detail.repertoireId !== roomMetadata.repertoireId) return;
      const revision = Number(detail.revision);
      if (!Number.isInteger(revision)) return;
      void api
        .get<ServerTempoMap>(
          `/repertoire/${roomMetadata.repertoireId}/tempomap/revisions/${revision}`,
        )
        .then((response) => {
          const data: unknown = response.data;
          assertValidTempoMap(data);
          setRoomMetadata((current) =>
            current ? { ...current, tempoMapRevision: response.revision } : current,
          );
          setTempoMap({
            ...data,
            repertoireItemId: roomMetadata.repertoireId,
            revision: response.revision,
          });
        })
        .catch((error: unknown) => {
          notify({
            title: '최신 템포맵을 불러오지 못했습니다.',
            description: error instanceof Error ? error.message : String(error),
            tone: 'danger',
          });
        });
    };
    window.addEventListener('fmr:tempomap-updated', reloadTempoMap);
    return () => window.removeEventListener('fmr:tempomap-updated', reloadTempoMap);
  }, [api, notify, roomMetadata]);

  const me = snapshot.roster.find((participant) => participant.userId === user?.id);
  const canControl = me?.role === 'owner' || me?.role === 'leader';
  const controlsEnabled = snapshot.connectionState === 'joined' && !pendingCommand;
  const connection = describeRoomConnection(snapshot.connectionState);
  const bluetoothDetectionStatus = readBluetoothDetectionStatus(localStorage);
  const transport = snapshot.transport;

  const sendStart = useCallback(() => {
    if (pendingCommandRef.current || snapshot.connectionState !== 'joined') return;
    const sent = roomClientRef.current?.start(
      { measure: anchorMeasure, pass: anchorPass },
      withCountIn,
    );
    if (sent) beginPendingCommand({ kind: 'transport', baseline: snapshot.transport });
  }, [
    anchorMeasure,
    anchorPass,
    beginPendingCommand,
    snapshot.connectionState,
    snapshot.transport,
    withCountIn,
  ]);

  const sendStop = useCallback(() => {
    if (pendingCommandRef.current || snapshot.connectionState !== 'joined') return;
    const sent = roomClientRef.current?.stop();
    if (sent) beginPendingCommand({ kind: 'transport', baseline: snapshot.transport });
  }, [beginPendingCommand, snapshot.connectionState, snapshot.transport]);

  const toggleReady = useCallback(() => {
    if (pendingCommandRef.current || snapshot.connectionState !== 'joined') return;
    const targetReady = !me?.ready;
    const sent = roomClientRef.current?.setReady(targetReady);
    if (sent) beginPendingCommand({ kind: 'ready', targetReady });
  }, [beginPendingCommand, me?.ready, snapshot.connectionState]);

  useEffect(() => {
    if (!window.matchMedia) return;
    const desktop = window.matchMedia('(min-width: 840px)');
    const closeCompactRoster = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setRosterOpen(false);
    };
    closeCompactRoster(desktop);
    desktop.addEventListener('change', closeCompactRoster);
    return () => desktop.removeEventListener('change', closeCompactRoster);
  }, []);
  useEffect(() => {
    if (snapshot.connectionState === 'closed') stopMetronome();
  }, [snapshot.connectionState, stopMetronome]);

  useEffect(() => {
    const wasPlaying = previousLocalPlayingRef.current;
    previousLocalPlayingRef.current = playing;
    if (
      shouldStopRoomAfterLocalEnd({
        wasPlaying,
        playing,
        canControl,
        connectionState: snapshot.connectionState,
        transportStatus: transport?.status,
      })
    ) {
      sendStop();
    }
  }, [canControl, playing, sendStop, snapshot.connectionState, transport?.status]);

  useEffect(() => {
    if (
      (transport?.status === 'armed' || transport?.status === 'playing') &&
      transport.serverStartTime &&
      transport.anchor &&
      snapshot.offsetMs &&
      transport.revision === tempoMap.revision &&
      scheduledStartRef.current !== transport.serverStartTime
    ) {
      scheduledStartRef.current = transport.serverStartTime;
      void startSynchronized({
        measure: transport.anchor.measure,
        pass: transport.anchor.pass,
        serverStartTimeMs: transport.serverStartTime,
        serverOffsetMs: snapshot.offsetMs,
        withCountIn: transport.countIn,
      }).catch((error: unknown) => {
        notify({
          title: '동기 재생을 예약하지 못했습니다.',
          description: error instanceof Error ? error.message : String(error),
          tone: 'danger',
        });
      });
    }
    if ((transport?.status === 'idle' || transport?.status === 'stopped') && playing) {
      stopMetronome();
      scheduledStartRef.current = undefined;
    }
  }, [
    notify,
    playing,
    snapshot.offsetMs,
    startSynchronized,
    stopMetronome,
    tempoMap.revision,
    transport,
  ]);

  async function createRoom() {
    if (!user || !repertoireId) return;
    setCreating(true);
    try {
      const room = await api.post<CreatedRoom>('/rooms', {
        repertoireId,
      });
      void navigate(`/session/${room.roomId}`);
    } catch (error) {
      notify({
        title: '세션을 열지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      setCreating(false);
    }
  }

  const copyJoinCode = async () => {
    if (!roomMetadata?.joinCode) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('클립보드 API를 사용할 수 없습니다.');
      await navigator.clipboard.writeText(roomMetadata.joinCode);
      notify({ title: '방 코드를 복사했습니다.', tone: 'success' });
    } catch (error) {
      notify({
        title: '방 코드를 자동으로 복사하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  };

  const copyInvite = async () => {
    const inviteUrl = window.location.href;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('클립보드 API를 사용할 수 없습니다.');
      await navigator.clipboard.writeText(inviteUrl);
      setInviteFallbackUrl(undefined);
      notify({ title: '초대 링크를 복사했습니다.', tone: 'success' });
    } catch (error) {
      setInviteFallbackUrl(inviteUrl);
      notify({
        title: '초대 링크를 자동으로 복사하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  };

  if (!user || !tokens) {
    return (
      <div className="page page--narrow">
        <PageHeader
          eyebrow="Synchronized rehearsal"
          title="앙상블 세션"
          description="동기 세션은 템포맵 revision과 시작 시각을 안전하게 공유하기 위해 로그인이 필요합니다."
        />
        <Card className="session-gate">
          <Radio size={40} aria-hidden />
          <h2>그룹 계정으로 연결하세요</h2>
          <p className="subtle">솔로 메트로놈은 로그인 없이 계속 사용할 수 있습니다.</p>
          <Button
            variant="primary"
            onClick={() => {
              void navigate('/login', {
                state: { returnTo: `${location.pathname}${location.search}` },
              });
            }}
          >
            <LogIn size={18} aria-hidden /> 로그인
          </Button>
        </Card>
      </div>
    );
  }

  if (!roomId) {
    return (
      <div className="page page--narrow">
        <PageHeader
          eyebrow="Synchronized rehearsal"
          title="앙상블 세션"
          description="같은 템포맵과 서버 시작 시각으로 모든 기기가 로컬에서 박을 전개합니다."
        />
        <div className="session-entry-grid">
          <Card className="session-entry">
            <UsersRound size={32} aria-hidden />
            <h2>새 세션 열기</h2>
            <p className="subtle">리더가 시작 마디와 예비박을 정하고 멤버를 초대합니다.</p>
            <label>
              <span className="fmr-field__label">레퍼토리</span>
              <select
                className="fmr-input"
                value={repertoireId}
                onChange={(event) => setSelectedRepertoireId(event.target.value)}
                disabled={workspace.loading}
              >
                {availableRepertoire.length === 0 ? (
                  <option value="">템포맵이 있는 리더 레퍼토리가 없습니다</option>
                ) : null}
                {availableRepertoire.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title} · rev.{item.currentTempoMapRevision}
                  </option>
                ))}
              </select>
            </label>
            {workspace.loading ? (
              <p className="session-entry__status" role="status" aria-live="polite">
                참여 가능한 레퍼토리를 불러오는 중…
              </p>
            ) : null}
            {workspace.error ? (
              <div className="session-entry__error" role="alert">
                <span>레퍼토리를 불러오지 못했습니다.</span>
                <Button size="compact" variant="ghost" onClick={workspace.reload}>
                  다시 시도
                </Button>
              </div>
            ) : null}
            {workspace.data && workspace.data.failures.length > 0 ? (
              <div className="session-entry__error" role="alert">
                <span>
                  작업 공간 일부를 불러오지 못했습니다. 표시된 레퍼토리는 그대로 사용할 수 있습니다.
                </span>
                <Button size="compact" variant="ghost" onClick={workspace.reload}>
                  누락된 정보 다시 시도
                </Button>
              </div>
            ) : null}
            <Button
              variant="primary"
              onClick={() => void createRoom()}
              disabled={creating || !repertoireId}
            >
              {creating ? '여는 중…' : '세션 열기'}
            </Button>
          </Card>
          <Card className="session-entry">
            <Radio size={32} aria-hidden />
            <h2>세션 참가</h2>
            <Field
              label="방 코드"
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value.trim())}
              placeholder="6자리 코드 또는 UUID"
            />
            <Button
              onClick={() => {
                const path = sessionPathForJoinInput(joinCode);
                if (path) void navigate(path);
              }}
              disabled={!sessionPathForJoinInput(joinCode)}
            >
              참가
            </Button>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="page session-page">
      <PageHeader
        eyebrow={roomMetadata?.joinCode ? `Room · ${roomMetadata.joinCode}` : `Room · ${roomId}`}
        title="앙상블 세션"
        description="박을 스트리밍하지 않고, 합의한 시작 시각부터 각 기기가 같은 타임라인을 재생합니다. 구두 공유는 6자리 방 코드, 링크 공유는 UUID 초대 URL을 사용합니다."
        actions={
          <>
            {roomMetadata?.joinCode ? (
              <Button onClick={() => void copyJoinCode()}>
                <Copy size={17} aria-hidden /> 방 코드
              </Button>
            ) : null}
            <Button onClick={() => void copyInvite()}>
              <Copy size={17} aria-hidden /> 초대 링크
            </Button>
          </>
        }
      />
      {roomMetadata?.joinCode ? (
        <p className="subtle">
          구두 공유 코드 <strong>{roomMetadata.joinCode}</strong>
        </p>
      ) : null}
      {inviteFallbackUrl ? (
        <Card className="session-entry__error" role="alert">
          <strong>초대 링크를 직접 복사해 주세요.</strong>
          <label>
            <span className="fmr-field__label">초대 링크</span>
            <input
              className="fmr-input"
              value={inviteFallbackUrl}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <Button size="compact" variant="ghost" onClick={() => void copyInvite()}>
            다시 복사
          </Button>
        </Card>
      ) : null}
      {pendingCommand ? (
        <div className="session-loading" role="status" aria-live="polite" aria-busy="true">
          {pendingCommand === 'transport' ? '재생 명령' : '준비 상태'}을 서버에 반영하는 중…
        </div>
      ) : null}
      {snapshot.error ? (
        <div className="connection-alert" role="alert">
          {snapshot.reconnecting ? <RotateCw className="spin" /> : <WifiOff />}
          <span>{snapshot.error}</span>
          <strong>
            {snapshot.connectionState === 'closed'
              ? '로컬 재생도 안전하게 중지했습니다.'
              : '예약된 로컬 재생은 계속됩니다.'}
          </strong>
        </div>
      ) : null}
      {roomLoadError ? (
        <div className="connection-alert" role="alert">
          <WifiOff />
          <span>세션의 템포맵을 불러오지 못했습니다: {roomLoadError}</span>
          <Button
            size="compact"
            variant="ghost"
            onClick={() => {
              setRoomMetadata(undefined);
              setRoomLoadError(undefined);
              setSnapshot(initialSnapshot);
              setRoomLoadAttempt((attempt) => attempt + 1);
            }}
          >
            다시 시도
          </Button>
        </div>
      ) : null}
      {!roomMetadata && !roomLoadError ? (
        <div className="session-loading" role="status" aria-live="polite" aria-busy="true">
          방 정보와 고정된 템포맵 revision을 불러오는 중…
        </div>
      ) : null}
      {bluetoothDetectionStatus === 'unknown' ? (
        <div className="bluetooth-warning" role="status">
          <Bluetooth aria-hidden />
          <div>
            <strong>무선 오디오 상태 미확인</strong>
            <span>
              출력 보정에서 무선 오디오를 확인해 주세요. 확인 전에는 동기 오차가 커질 수 있습니다.
            </span>
          </div>
        </div>
      ) : null}

      <div className="session-layout">
        <Card className="session-stage">
          <div className="session-status" aria-live="polite">
            <StatusBadge tone={connection.tone}>
              {snapshot.connectionState === 'joined' ? (
                <Wifi size={13} />
              ) : snapshot.connectionState === 'connecting' ||
                snapshot.connectionState === 'authenticating' ||
                snapshot.connectionState === 'reconnecting' ? (
                <RotateCw className="spin" size={13} />
              ) : (
                <WifiOff size={13} />
              )}
              {connection.label}
            </StatusBadge>
            <span className="fmr-tabular">
              RTT {Number.isFinite(snapshot.rttMs) ? snapshot.rttMs.toFixed(1) : '—'}ms · offset{' '}
              {snapshot.offsetMs ? (snapshot.offsetMs - performance.timeOrigin).toFixed(1) : '—'}ms
            </span>
          </div>
          <BeatVisualizer
            className="session-visualizer"
            running={metronome.playing}
            frameSource={metronome.frameSource}
          />
          <div className="session-transport-state">
            <strong>
              {playing || transport?.status === 'playing'
                ? '연주 중'
                : transport?.status === 'armed'
                  ? '예비박 대기'
                  : '대기'}
            </strong>
            <span>
              {metronome.playing
                ? metronome.position.measureNumber
                : (transport?.anchor?.measure ?? anchorMeasure)}
              마디 · pass {transport?.anchor?.pass ?? anchorPass} · revision{' '}
              {transport?.revision ?? 1}
            </span>
          </div>
          {canControl ? (
            <div className="session-controls">
              <Field
                label="시작 마디"
                type="number"
                min={1}
                value={anchorMeasure}
                onChange={(event) => setAnchorMeasure(Number(event.target.value))}
                disabled={!controlsEnabled}
              />
              <Field
                label="Pass"
                type="number"
                min={1}
                value={anchorPass}
                onChange={(event) => setAnchorPass(Number(event.target.value))}
                disabled={!controlsEnabled}
              />
              <label className="session-count-in-toggle">
                <input
                  type="checkbox"
                  checked={withCountIn}
                  onChange={(event) => setWithCountIn(event.target.checked)}
                  disabled={!controlsEnabled}
                />
                예비박
              </label>
              {transport?.status === 'playing' || transport?.status === 'armed' ? (
                <Button
                  className="session-controls__desktop-transport"
                  variant="primary"
                  disabled={!controlsEnabled}
                  onClick={sendStop}
                >
                  <Square size={18} fill="currentColor" /> 정지
                </Button>
              ) : (
                <Button
                  className="session-controls__desktop-transport"
                  variant="primary"
                  disabled={!controlsEnabled}
                  onClick={sendStart}
                >
                  <Play size={18} fill="currentColor" /> 3초 뒤 시작
                </Button>
              )}
            </div>
          ) : (
            <p className="member-readonly">리더가 시작하면 같은 예비박부터 자동으로 재생됩니다.</p>
          )}
        </Card>

        <Card className="roster-panel roster-panel--desktop">
          <header>
            <h2>참가자</h2>
            <StatusBadge>{snapshot.roster.length}명</StatusBadge>
          </header>
          <ParticipantList participants={snapshot.roster} />
          <Button
            onClick={toggleReady}
            variant={me?.ready ? 'secondary' : 'primary'}
            disabled={!controlsEnabled}
          >
            {me?.ready ? '준비 취소' : '준비 완료'}
          </Button>
        </Card>
      </div>

      <SessionMobileControls
        participantCount={snapshot.roster.length}
        rosterOpen={rosterOpen}
        ready={Boolean(me?.ready)}
        canControl={canControl}
        controlsEnabled={controlsEnabled}
        transportActive={transport?.status === 'playing' || transport?.status === 'armed'}
        onOpenRoster={() => setRosterOpen(true)}
        onToggleReady={toggleReady}
        onStart={sendStart}
        onStop={sendStop}
      />

      <Modal
        open={rosterOpen}
        onOpenChange={setRosterOpen}
        title="참가자와 준비 상태"
        description={`${snapshot.roster.length}명이 연결되어 있습니다. 연결 상태를 확인하고 내 준비 상태를 바꿀 수 있습니다.`}
      >
        <div className="session-roster-sheet">
          <ParticipantList participants={snapshot.roster} />
          <Button
            onClick={toggleReady}
            variant={me?.ready ? 'secondary' : 'primary'}
            disabled={!controlsEnabled}
          >
            {me?.ready ? '준비 취소' : '준비 완료'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
