import { websocketUrl } from './paths';
import { ClockSyncEstimator, type ClockSyncSample } from '@feelmyrythm/core';

export interface TransportAnchor {
  measure: number;
  pass: number;
}

export interface TransportState {
  roomId: string;
  repertoireId: string;
  revision: number;
  status: 'idle' | 'armed' | 'playing' | 'stopped';
  anchor?: TransportAnchor;
  serverStartTime?: number;
  countIn: boolean;
  lateJoin?: {
    serverNowNs: number;
    elapsedNs: number;
    strategy: 'next-measure-boundary';
  };
}

export interface RoomParticipant {
  userId: string;
  displayName: string;
  role: 'owner' | 'leader' | 'member';
  ready: boolean;
  rttMs?: number;
  calibrated: boolean;
  bluetooth: boolean;
}

export type RoomConnectionState =
  'idle' | 'connecting' | 'authenticating' | 'joined' | 'reconnecting' | 'offline' | 'closed';

export interface RoomSnapshot {
  transport: TransportState | null;
  roster: RoomParticipant[];
  connectionState: RoomConnectionState;
  connected: boolean;
  reconnecting: boolean;
  offsetMs: number;
  rttMs: number;
  error: string | undefined;
}

interface Envelope {
  type: string;
  requestId?: string;
  payload?: Record<string, unknown>;
}

type Listener = (snapshot: RoomSnapshot) => void;

export interface RoomClientOptions {
  onUnauthorized?: (rejectedAccessToken: string) => Promise<string | null>;
}

const clientMonotonicNow = (): number => performance.now();

export class RoomClient {
  private socket: WebSocket | null = null;
  private listener: Listener | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private desiredReady = false;
  private pingSamples: ClockSyncSample[] = [];
  private readonly pendingPings = new Set<number>();
  private readonly clockEstimator = new ClockSyncEstimator();
  private networkListenersAttached = false;
  private authRefreshAttempted = false;
  private snapshot: RoomSnapshot = {
    transport: null,
    roster: [],
    connectionState: 'idle',
    connected: false,
    reconnecting: false,
    offsetMs: 0,
    rttMs: Number.POSITIVE_INFINITY,
    error: undefined,
  };

  constructor(
    private readonly roomId: string,
    private token: string,
    private readonly participant: { calibrationId?: string; bluetooth: boolean },
    private readonly options: RoomClientOptions = {},
  ) {}

  subscribe(listener: Listener): () => void {
    this.listener = listener;
    listener(this.snapshot);
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  connect(): void {
    if (this.socket || this.reconnectTimer) return;
    this.closedByUser = false;
    this.attachNetworkListeners();
    if (!this.isOnline()) {
      this.patch({
        connectionState: 'offline',
        connected: false,
        reconnecting: false,
        error: '네트워크가 오프라인입니다. 연결이 복구되면 자동으로 다시 시도합니다.',
      });
      return;
    }
    this.patch({
      connectionState: 'connecting',
      connected: false,
      reconnecting: false,
      error: undefined,
    });
    this.openSocket();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.socket?.close(1000, 'client disconnect');
    this.socket = null;
    this.detachNetworkListeners();
    this.patch({
      connectionState: 'idle',
      connected: false,
      reconnecting: false,
      error: undefined,
    });
  }

  start(anchor: TransportAnchor, countIn = true): boolean {
    return this.sendControl('CMD_START', {
      measure: anchor.measure,
      pass: anchor.pass,
      countIn,
    });
  }

  stop(): boolean {
    return this.sendControl('CMD_STOP', {});
  }

  seek(anchor: TransportAnchor): boolean {
    return this.sendControl('CMD_SEEK', { measure: anchor.measure, pass: anchor.pass });
  }

  setReady(ready: boolean): boolean {
    this.desiredReady = ready;
    return this.sendControl('READY', { ready });
  }

  serverNow(): number {
    return clientMonotonicNow() + this.snapshot.offsetMs;
  }

  private openSocket(): void {
    if (this.closedByUser || this.socket) return;
    if (!this.isOnline()) {
      this.patch({
        connectionState: 'offline',
        connected: false,
        reconnecting: false,
        error: '네트워크가 오프라인입니다. 연결이 복구되면 자동으로 다시 시도합니다.',
      });
      return;
    }
    this.patch({
      connectionState: this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting',
      connected: false,
      reconnecting: this.reconnectAttempt > 0,
    });
    const url = new URL(websocketUrl(`/rooms/${this.roomId}`));
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.pingSamples = [];
      this.pendingPings.clear();
      this.clockEstimator.reset();
      this.patch({ connected: false, error: undefined });
      this.send('JOIN_ROOM', {
        roomId: this.roomId,
        accessToken: this.token,
        calibrationId: this.participant.calibrationId ?? null,
        bluetooth: this.participant.bluetooth,
      });
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      try {
        this.handle(JSON.parse(String(event.data)) as Envelope);
      } catch (error) {
        this.patch({ error: error instanceof Error ? error.message : '잘못된 실시간 메시지' });
      }
    });

    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.pingTimer) clearTimeout(this.pingTimer);
      this.pingTimer = null;
      if (this.closedByUser) return;
      const online = this.isOnline();
      if (!online) {
        this.patch({
          connectionState: 'offline',
          connected: false,
          reconnecting: false,
          error: '네트워크가 오프라인입니다. 연결이 복구되면 자동으로 다시 시도합니다.',
        });
        return;
      }
      if (event.code === 4401) {
        this.refreshAuthorization();
        return;
      }
      const terminalMessage = this.terminalCloseMessage(event.code);
      if (terminalMessage) {
        this.closeTerminal(terminalMessage);
        return;
      }
      this.patch({
        connectionState: 'reconnecting',
        connected: false,
        reconnecting: true,
        error:
          event.code === 1000
            ? '세션 연결이 종료되었습니다. 다시 연결하는 중입니다.'
            : '세션 연결이 끊겼습니다. 다시 연결하는 중입니다.',
      });
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (this.socket !== socket) return;
      this.patch({ error: '동기 세션 서버에 연결하지 못했습니다.' });
    });
  }

  private pingBurst(index: number): void {
    if (this.snapshot.connectionState !== 'joined') return;
    if (index >= 10) {
      this.pingTimer = setTimeout(() => this.pingBurst(0), 10_000);
      return;
    }
    const t0 = Math.round(clientMonotonicNow());
    this.pendingPings.add(t0);
    this.send('PING', { t0 });
    this.pingTimer = setTimeout(() => this.pingBurst(index + 1), 80);
  }

  private handle(message: Envelope): void {
    const payload = message.payload ?? {};
    switch (message.type) {
      case 'JOINED':
        this.reconnectAttempt = 0;
        this.authRefreshAttempted = false;
        this.patch({
          connectionState: 'joined',
          connected: true,
          reconnecting: false,
          error: undefined,
        });
        this.send('READY', { ready: this.desiredReady });
        if (this.pingTimer) clearTimeout(this.pingTimer);
        this.pingBurst(0);
        break;
      case 'PONG': {
        const t2 = clientMonotonicNow();
        const t0 = Number(payload.t0);
        const t1 = Number(payload.serverReceiveTimeNs) / 1_000_000;
        if (!Number.isFinite(t0) || !Number.isFinite(t1) || !this.pendingPings.delete(t0)) {
          this.patch({ error: '잘못된 시계 동기 응답입니다.' });
          return;
        }
        const sample = {
          clientSendTimeMs: t0,
          serverTimeMs: t1,
          clientReceiveTimeMs: t2,
        };
        if (this.pingSamples.length < this.clockEstimator.initialBurstSize) {
          this.pingSamples.push(sample);
          if (this.pingSamples.length === this.clockEstimator.initialBurstSize) {
            const state = this.clockEstimator.initialize(this.pingSamples);
            this.patch({ offsetMs: state.offsetMs, rttMs: state.latestRttMs });
            this.send('REPORT_RTT', { rttMs: state.latestRttMs });
          }
          return;
        }
        const observation = this.clockEstimator.observe(sample);
        if (observation.accepted) {
          this.patch({
            offsetMs: observation.state.offsetMs,
            rttMs: observation.state.latestRttMs,
          });
          this.send('REPORT_RTT', { rttMs: observation.state.latestRttMs });
        }
        break;
      }
      case 'TRANSPORT': {
        const anchor = payload.anchor as TransportAnchor | undefined;
        const serverStartTimeNs =
          typeof payload.serverStartTimeNs === 'number' ? payload.serverStartTimeNs : Number.NaN;
        const status = payload.status;
        if (
          typeof payload.roomId !== 'string' ||
          typeof payload.repertoireId !== 'string' ||
          typeof payload.tempoMapRevision !== 'number' ||
          (status !== 'idle' && status !== 'armed' && status !== 'playing' && status !== 'stopped')
        ) {
          this.patch({ error: '잘못된 재생 상태 응답입니다.' });
          break;
        }
        this.patch({
          transport: {
            roomId: payload.roomId,
            repertoireId: payload.repertoireId,
            revision: payload.tempoMapRevision,
            status,
            countIn: payload.countIn !== false,
            ...(anchor ? { anchor } : {}),
            ...(Number.isFinite(serverStartTimeNs)
              ? { serverStartTime: serverStartTimeNs / 1_000_000 }
              : {}),
            ...(payload.lateJoin
              ? { lateJoin: payload.lateJoin as NonNullable<TransportState['lateJoin']> }
              : {}),
          },
        });
        break;
      }
      case 'ROOM_ROSTER': {
        if (!Array.isArray(payload.members)) {
          this.patch({ error: '잘못된 참가자 목록 응답입니다.' });
          break;
        }
        const roster = payload.members.map(parseParticipant);
        this.patch({ roster });
        break;
      }
      case 'TEMPOMAP_UPDATED':
        window.dispatchEvent(new CustomEvent('fmr:tempomap-updated', { detail: payload }));
        break;
      case 'ERROR': {
        const detail = payload.message ?? payload.code;
        const error =
          typeof detail === 'string' || typeof detail === 'number' ? String(detail) : '세션 오류';
        this.patch({ error });
        break;
      }
    }
  }

  private sendControl(type: string, payload: Record<string, unknown>): boolean {
    if (this.snapshot.connectionState !== 'joined') return false;
    return this.send(type, payload);
  }

  private refreshAuthorization(): void {
    if (this.authRefreshAttempted || !this.options.onUnauthorized) {
      this.closeTerminal('세션 인증이 만료되었거나 참가 권한이 없습니다. 다시 로그인해 주세요.');
      return;
    }
    this.authRefreshAttempted = true;
    const rejectedAccessToken = this.token;
    this.patch({
      connectionState: 'authenticating',
      connected: false,
      reconnecting: false,
      error: '세션 인증을 갱신하는 중입니다.',
    });
    void this.options
      .onUnauthorized(rejectedAccessToken)
      .then((accessToken) => {
        if (this.closedByUser) return;
        if (!accessToken) {
          this.closeTerminal('세션 인증을 갱신하지 못했습니다. 다시 로그인해 주세요.');
          return;
        }
        this.token = accessToken;
        this.patch({
          connectionState: 'connecting',
          connected: false,
          reconnecting: false,
          error: undefined,
        });
        this.openSocket();
      })
      .catch((error: unknown) => {
        if (this.closedByUser) return;
        this.closeTerminal(
          error instanceof Error
            ? `세션 인증을 갱신하지 못했습니다: ${error.message}`
            : '세션 인증을 갱신하지 못했습니다. 다시 로그인해 주세요.',
        );
      });
  }

  private terminalCloseMessage(code: number): string | undefined {
    switch (code) {
      case 4000:
        return '더 새 탭 또는 기기의 연결이 이 세션 연결을 대체했습니다.';
      case 4400:
        return '세션 연결 요청이 올바르지 않아 서버가 연결을 종료했습니다.';
      case 4404:
        return '세션을 찾을 수 없거나 세션이 만료되었습니다.';
      default:
        return undefined;
    }
  }

  private closeTerminal(message: string): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.closedByUser = true;
    this.detachNetworkListeners();
    this.patch({
      connectionState: 'closed',
      connected: false,
      reconnecting: false,
      error: message,
    });
  }

  private send(type: string, payload: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    const envelope: Envelope = {
      type,
      requestId: crypto.randomUUID(),
      payload,
    };
    this.socket.send(JSON.stringify(envelope));
    return true;
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt += 1;
    const delay = Math.min(10_000, 500 * 2 ** (this.reconnectAttempt - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private readonly onOnline = (): void => {
    if (this.closedByUser || this.socket || this.reconnectTimer) return;
    this.patch({
      connectionState: this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting',
      connected: false,
      reconnecting: this.reconnectAttempt > 0,
      error: undefined,
    });
    this.openSocket();
  };

  private readonly onOffline = (): void => {
    if (this.closedByUser) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(4000, 'network offline');
    this.patch({
      connectionState: 'offline',
      connected: false,
      reconnecting: false,
      error: '네트워크가 오프라인입니다. 연결이 복구되면 자동으로 다시 시도합니다.',
    });
  };

  private isOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  }

  private attachNetworkListeners(): void {
    if (this.networkListenersAttached) return;
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    this.networkListenersAttached = true;
  }

  private detachNetworkListeners(): void {
    if (!this.networkListenersAttached) return;
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    this.networkListenersAttached = false;
  }

  private patch(patch: Partial<RoomSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listener?.(this.snapshot);
  }
}

function parseParticipant(value: unknown): RoomParticipant {
  if (typeof value !== 'object' || value === null) {
    throw new Error('잘못된 참가자 목록 응답입니다.');
  }
  const member = value as Record<string, unknown>;
  const role = member.role;
  if (
    typeof member.userId !== 'string' ||
    typeof member.displayName !== 'string' ||
    (role !== 'owner' && role !== 'leader' && role !== 'member') ||
    typeof member.ready !== 'boolean' ||
    typeof member.calibrated !== 'boolean' ||
    typeof member.bluetooth !== 'boolean' ||
    (member.rttMs !== undefined && member.rttMs !== null && typeof member.rttMs !== 'number')
  ) {
    throw new Error('잘못된 참가자 목록 응답입니다.');
  }
  return {
    userId: member.userId,
    displayName: member.displayName,
    role,
    ready: member.ready,
    calibrated: member.calibrated,
    bluetooth: member.bluetooth,
    ...(typeof member.rttMs === 'number' ? { rttMs: member.rttMs } : {}),
  };
}
