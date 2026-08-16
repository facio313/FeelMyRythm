import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AnnotationSyncClient,
  type AnnotationSyncEvent,
  type AnnotationSyncStatus,
} from './annotationClient';
import type { VersionedAnnotation } from './scoreApi';

type SocketListener = (event: Event | MessageEvent | CloseEvent) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, SocketListener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: SocketListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', new Event('open'));
  }

  message(value: unknown): void {
    this.emit('message', new MessageEvent('message', { data: JSON.stringify(value) }));
  }

  serverClose(code = 1006): void {
    this.readyState = 3;
    const event = new Event('close') as CloseEvent;
    Object.defineProperty(event, 'code', { value: code });
    this.emit('close', event);
  }

  private emit(type: string, event: Event | MessageEvent | CloseEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const annotationRecord = {
  id: 'annotation-1',
  scoreId: 'score-1',
  authorId: 'user-1',
  scope: 'project',
  revision: 2,
  data: {
    kind: 'text',
    page: 1,
    measureNumber: 3,
    payload: { x: 0.4, y: 0.3, text: 'forte', anchorType: 'measure' },
  },
  createdAt: '2026-08-15T00:00:00Z',
  updatedAt: '2026-08-15T00:00:01Z',
};

function sent(socket: FakeWebSocket): Array<{ type: string; payload: Record<string, unknown> }> {
  return socket.sent.map((item) => JSON.parse(item) as never);
}

function joined(socket: FakeWebSocket): void {
  socket.message({
    type: 'ANNOTATION_JOINED',
    payload: { repertoireId: 'repertoire-1', userId: 'user-1' },
  });
}

describe('AnnotationSyncClient', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('joins, validates snapshots, and delivers upsert and delete events', () => {
    const snapshots: VersionedAnnotation[][] = [];
    const events: AnnotationSyncEvent[] = [];
    const statuses: AnnotationSyncStatus[] = [];
    const client = new AnnotationSyncClient('repertoire-1', 'token-1', {
      onSnapshot: (value) => snapshots.push(value),
      onEvent: (value) => events.push(value),
      onStatus: (value) => statuses.push(value),
    });
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url).toContain('/feelmyrythm/ws/repertoires/repertoire-1/annotations');
    socket.open();
    expect(sent(socket)[0]).toMatchObject({
      type: 'JOIN_ANNOTATIONS',
      payload: { repertoireId: 'repertoire-1', accessToken: 'token-1' },
    });

    joined(socket);
    expect(statuses.at(-1)).toEqual({ state: 'live' });
    socket.message({
      type: 'ANNOTATION_SNAPSHOT',
      payload: { repertoireId: 'repertoire-1', annotations: [annotationRecord] },
    });
    expect(snapshots[0]?.[0]).toMatchObject({
      id: 'annotation-1',
      scoreId: 'score-1',
      revision: 2,
      measureNumber: 3,
    });

    socket.message({
      type: 'ANNOTATION_EVENT',
      payload: {
        eventId: 'event-1',
        repertoireId: 'repertoire-1',
        operation: 'upsert',
        annotationId: 'annotation-1',
        revision: 2,
        scope: 'project',
        authorId: 'user-1',
        annotation: annotationRecord,
      },
    });
    socket.message({
      type: 'ANNOTATION_EVENT',
      payload: {
        eventId: 'event-2',
        repertoireId: 'repertoire-1',
        operation: 'delete',
        annotationId: 'annotation-1',
        revision: 2,
        scope: 'project',
        authorId: 'user-1',
        annotation: null,
      },
    });
    expect(events.map((event) => event.operation)).toEqual(['upsert', 'delete']);
    expect(events[0]?.annotation?.payload.text).toBe('forte');

    vi.advanceTimersByTime(15_000);
    expect(sent(socket).some((envelope) => envelope.type === 'ANNOTATION_PING')).toBe(true);
    client.disconnect();
  });

  it('reconnects and accepts a replacement snapshot after a network close', () => {
    const snapshots: VersionedAnnotation[][] = [];
    const statuses: AnnotationSyncStatus[] = [];
    const client = new AnnotationSyncClient('repertoire-1', 'token-1', {
      onSnapshot: (value) => snapshots.push(value),
      onEvent: vi.fn(),
      onStatus: (value) => statuses.push(value),
    });
    client.connect();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    joined(first);
    first.serverClose(1006);
    expect(statuses.at(-1)?.state).toBe('reconnecting');

    vi.advanceTimersByTime(500);
    const second = FakeWebSocket.instances[1]!;
    second.open();
    joined(second);
    second.message({
      type: 'ANNOTATION_SNAPSHOT',
      payload: { repertoireId: 'repertoire-1', annotations: [annotationRecord] },
    });
    expect(snapshots.at(-1)?.map((item) => item.id)).toEqual(['annotation-1']);
    expect(statuses.at(-1)?.state).toBe('live');
    client.disconnect();
  });

  it('refreshes one rejected token and treats a repeated rejection as terminal', async () => {
    const onUnauthorized = vi.fn().mockResolvedValue('token-2');
    const statuses: AnnotationSyncStatus[] = [];
    const client = new AnnotationSyncClient('repertoire-1', 'token-1', {
      onSnapshot: vi.fn(),
      onEvent: vi.fn(),
      onStatus: (value) => statuses.push(value),
      onUnauthorized,
    });
    client.connect();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.serverClose(4401);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    expect(onUnauthorized).toHaveBeenCalledWith('token-1');

    const second = FakeWebSocket.instances[1]!;
    second.open();
    expect(sent(second)[0]).toMatchObject({ payload: { accessToken: 'token-2' } });
    second.serverClose(4401);
    expect(statuses.at(-1)?.state).toBe('closed');
    expect(onUnauthorized).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
