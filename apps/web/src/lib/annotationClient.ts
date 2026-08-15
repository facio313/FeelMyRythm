import { annotationFromRecord, type AnnotationRecord, type VersionedAnnotation } from './scoreApi';
import { websocketUrl } from './paths';

export type AnnotationConnectionState =
  'idle' | 'connecting' | 'live' | 'reconnecting' | 'offline' | 'closed';

export interface AnnotationSyncStatus {
  state: AnnotationConnectionState;
  error?: string;
}

export interface AnnotationSyncEvent {
  eventId: string;
  repertoireId: string;
  operation: 'upsert' | 'delete';
  annotationId: string;
  revision: number;
  scope: 'private' | 'project';
  authorId: string;
  annotation?: VersionedAnnotation;
}

export interface AnnotationSyncClientOptions {
  onSnapshot: (annotations: VersionedAnnotation[]) => void;
  onEvent: (event: AnnotationSyncEvent) => void;
  onStatus?: (status: AnnotationSyncStatus) => void;
  onUnauthorized?: (rejectedAccessToken: string) => Promise<string | null>;
}

interface Envelope {
  type: string;
  requestId?: string;
  payload?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`잘못된 ${label}입니다.`);
  return value;
}

export class AnnotationSyncClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private closedByUser = false;
  private authRefreshAttempted = false;
  private networkListenersAttached = false;
  private status: AnnotationSyncStatus = { state: 'idle' };

  constructor(
    private readonly repertoireId: string,
    private token: string,
    private readonly options: AnnotationSyncClientOptions,
  ) {}

  connect(): void {
    if (this.socket || this.reconnectTimer) return;
    this.closedByUser = false;
    this.attachNetworkListeners();
    if (!this.isOnline()) {
      this.patchStatus('offline', '네트워크가 복구되면 공동 필기를 다시 동기화합니다.');
      return;
    }
    this.patchStatus('connecting');
    this.openSocket();
  }

  disconnect(): void {
    this.closedByUser = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'client disconnect');
    this.detachNetworkListeners();
    this.patchStatus('idle');
  }

  private openSocket(): void {
    if (this.closedByUser || this.socket) return;
    if (!this.isOnline()) {
      this.patchStatus('offline', '네트워크가 복구되면 공동 필기를 다시 동기화합니다.');
      return;
    }
    this.patchStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
    const socket = new WebSocket(
      websocketUrl(`/repertoires/${encodeURIComponent(this.repertoireId)}/annotations`),
    );
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.send('JOIN_ANNOTATIONS', {
        repertoireId: this.repertoireId,
        accessToken: this.token,
      });
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      try {
        this.handle(JSON.parse(String(event.data)) as Envelope);
      } catch (error) {
        this.patchStatus(
          this.status.state,
          error instanceof Error ? error.message : '잘못된 공동 필기 메시지입니다.',
        );
      }
    });

    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearPingTimer();
      if (this.closedByUser) return;
      if (!this.isOnline()) {
        this.patchStatus('offline', '네트워크가 복구되면 공동 필기를 다시 동기화합니다.');
        return;
      }
      if (event.code === 4401) {
        this.refreshAuthorization();
        return;
      }
      const terminal = this.terminalMessage(event.code);
      if (terminal) {
        this.closeTerminal(terminal);
        return;
      }
      this.patchStatus('reconnecting', '공동 필기 연결이 끊겨 최신 상태를 다시 불러옵니다.');
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (this.socket === socket) {
        this.patchStatus(this.status.state, '공동 필기 서버에 연결하지 못했습니다.');
      }
    });
  }

  private handle(message: Envelope): void {
    if (!isRecord(message.payload)) throw new Error('잘못된 공동 필기 응답입니다.');
    const payload = message.payload;
    switch (message.type) {
      case 'ANNOTATION_JOINED':
        if (payload.repertoireId !== this.repertoireId) {
          throw new Error('다른 레퍼토리의 공동 필기 연결 응답입니다.');
        }
        this.reconnectAttempt = 0;
        this.authRefreshAttempted = false;
        this.patchStatus('live');
        this.schedulePing();
        break;
      case 'ANNOTATION_SNAPSHOT': {
        if (payload.repertoireId !== this.repertoireId || !Array.isArray(payload.annotations)) {
          throw new Error('잘못된 공동 필기 스냅샷입니다.');
        }
        this.options.onSnapshot(
          payload.annotations.map((item) => {
            if (!isRecord(item)) throw new Error('잘못된 필기 데이터입니다.');
            return annotationFromRecord(item as unknown as AnnotationRecord);
          }),
        );
        break;
      }
      case 'ANNOTATION_EVENT':
        this.options.onEvent(this.parseEvent(payload));
        break;
      case 'ANNOTATION_PONG':
        break;
      case 'ERROR': {
        const detail = payload.message ?? payload.code;
        this.patchStatus(
          this.status.state,
          typeof detail === 'string' ? detail : '공동 필기 동기화 오류가 발생했습니다.',
        );
        break;
      }
    }
  }

  private parseEvent(payload: Record<string, unknown>): AnnotationSyncEvent {
    const operation = payload.operation;
    const scope = payload.scope;
    if (operation !== 'upsert' && operation !== 'delete') {
      throw new Error('잘못된 공동 필기 작업입니다.');
    }
    if (scope !== 'private' && scope !== 'project') {
      throw new Error('잘못된 공동 필기 공개 범위입니다.');
    }
    if (payload.repertoireId !== this.repertoireId) {
      throw new Error('다른 레퍼토리의 공동 필기 이벤트입니다.');
    }
    const revision = Number(payload.revision);
    if (!Number.isInteger(revision) || revision < 1) {
      throw new Error('잘못된 공동 필기 revision입니다.');
    }
    const annotation = payload.annotation;
    if (operation === 'upsert' && !isRecord(annotation)) {
      throw new Error('공동 필기 갱신 데이터가 없습니다.');
    }
    return {
      eventId: requiredString(payload.eventId, '공동 필기 이벤트 ID'),
      repertoireId: this.repertoireId,
      operation,
      annotationId: requiredString(payload.annotationId, '필기 ID'),
      revision,
      scope,
      authorId: requiredString(payload.authorId, '필기 작성자'),
      ...(isRecord(annotation)
        ? { annotation: annotationFromRecord(annotation as unknown as AnnotationRecord) }
        : {}),
    };
  }

  private schedulePing(): void {
    this.clearPingTimer();
    this.pingTimer = setTimeout(() => {
      this.pingTimer = null;
      if (this.status.state !== 'live') return;
      this.send('ANNOTATION_PING', { nonce: crypto.randomUUID() });
      this.schedulePing();
    }, 15_000);
  }

  private refreshAuthorization(): void {
    if (this.authRefreshAttempted || !this.options.onUnauthorized) {
      this.closeTerminal('공동 필기 인증이 만료되었거나 레퍼토리 권한이 없습니다.');
      return;
    }
    this.authRefreshAttempted = true;
    const rejected = this.token;
    this.patchStatus('connecting', '공동 필기 인증을 갱신하는 중입니다.');
    void this.options
      .onUnauthorized(rejected)
      .then((token) => {
        if (this.closedByUser) return;
        if (!token) {
          this.closeTerminal('공동 필기 인증을 갱신하지 못했습니다.');
          return;
        }
        this.token = token;
        this.openSocket();
      })
      .catch(() => {
        if (!this.closedByUser) this.closeTerminal('공동 필기 인증을 갱신하지 못했습니다.');
      });
  }

  private send(type: string, payload: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(
      JSON.stringify({
        type,
        requestId: crypto.randomUUID(),
        payload,
      }),
    );
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

  private terminalMessage(code: number): string | undefined {
    if (code === 4000) return '다른 연결이 공동 필기 연결을 대체했습니다.';
    if (code === 4400) return '공동 필기 연결 요청이 올바르지 않습니다.';
    if (code === 4404) return '공동 필기 대상 레퍼토리를 찾을 수 없습니다.';
    return undefined;
  }

  private closeTerminal(message: string): void {
    this.closedByUser = true;
    this.clearTimers();
    this.detachNetworkListeners();
    this.patchStatus('closed', message);
  }

  private patchStatus(state: AnnotationConnectionState, error?: string): void {
    this.status = { state, ...(error ? { error } : {}) };
    this.options.onStatus?.(this.status);
  }

  private clearPingTimer(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearPingTimer();
  }

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

  private readonly onOnline = (): void => {
    if (this.closedByUser || this.socket || this.reconnectTimer) return;
    this.patchStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
    this.openSocket();
  };

  private readonly onOffline = (): void => {
    if (this.closedByUser) return;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close(4000, 'network offline');
    this.patchStatus('offline', '네트워크가 복구되면 공동 필기를 다시 동기화합니다.');
  };
}
