import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RoomClient, type RoomSnapshot } from './roomClient';

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

  serverClose(code = 1006): void {
    this.readyState = 3;
    const event = new Event('close') as CloseEvent;
    Object.defineProperty(event, 'code', { value: code });
    this.emit('close', event);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', new Event('open'));
  }

  message(value: unknown): void {
    this.emit('message', new MessageEvent('message', { data: JSON.stringify(value) }));
  }

  private emit(type: string, event: Event | MessageEvent | CloseEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function envelopes(socket: FakeWebSocket): Array<{
  type: string;
  payload: Record<string, unknown>;
}> {
  return socket.sent.map((value) => JSON.parse(value) as never);
}

describe('RoomClient protocol', () => {
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

  it('advertises Bluetooth and restores desired READY state after JOINED', () => {
    const client = new RoomClient('room-1', 'token-1', {
      calibrationId: 'calibration-1',
      bluetooth: true,
    });
    expect(client.setReady(true)).toBe(false);
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    expect(envelopes(socket)[0]).toMatchObject({
      type: 'JOIN_ROOM',
      payload: {
        roomId: 'room-1',
        accessToken: 'token-1',
        calibrationId: 'calibration-1',
        bluetooth: true,
      },
    });
    socket.message({ type: 'JOINED', payload: { userId: 'user-1', role: 'member' } });
    expect(envelopes(socket)).toContainEqual(
      expect.objectContaining({ type: 'READY', payload: { ready: true } }),
    );
    expect(envelopes(socket).filter(({ type }) => type === 'READY')).toHaveLength(1);
  });

  it('rejects transport commands until JOINED and after disconnect', () => {
    const client = new RoomClient('room-1', 'token-1', { bluetooth: false });

    expect(client.start({ measure: 2, pass: 1 })).toBe(false);
    expect(client.seek({ measure: 4, pass: 2 })).toBe(false);
    expect(client.stop()).toBe(false);

    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    expect(client.start({ measure: 2, pass: 1 })).toBe(false);
    expect(envelopes(socket).map(({ type }) => type)).toEqual(['JOIN_ROOM']);

    socket.message({ type: 'JOINED', payload: { userId: 'user-1', role: 'leader' } });
    expect(client.start({ measure: 2, pass: 1 }, false)).toBe(true);
    expect(client.seek({ measure: 4, pass: 2 })).toBe(true);
    expect(client.stop()).toBe(true);
    expect(envelopes(socket)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'CMD_START',
          payload: { measure: 2, pass: 1, countIn: false },
        }),
        expect.objectContaining({ type: 'CMD_SEEK', payload: { measure: 4, pass: 2 } }),
        expect.objectContaining({ type: 'CMD_STOP', payload: {} }),
      ]),
    );

    client.disconnect();
    expect(client.start({ measure: 8, pass: 1 })).toBe(false);
    expect(client.setReady(true)).toBe(false);
  });

  it('distinguishes connecting, joined, and reconnecting states', () => {
    const client = new RoomClient('room-1', 'token-1', { bluetooth: false });
    const states: RoomSnapshot['connectionState'][] = [];
    client.subscribe((snapshot) => states.push(snapshot.connectionState));

    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    expect(states.at(-1)).toBe('connecting');
    socket.open();
    expect(states.at(-1)).toBe('connecting');
    socket.message({ type: 'JOINED', payload: { userId: 'user-1', role: 'member' } });
    expect(states.at(-1)).toBe('joined');

    socket.serverClose();
    expect(states.at(-1)).toBe('reconnecting');
  });

  it.each([4000, 4400, 4404])(
    'treats close code %d as terminal and never starts a reconnect loop',
    (code) => {
      const client = new RoomClient('room-1', 'token-1', { bluetooth: false });
      let snapshot: RoomSnapshot | undefined;
      client.subscribe((value) => {
        snapshot = value;
      });
      client.connect();
      const socket = FakeWebSocket.instances[0]!;
      socket.open();
      socket.serverClose(code);

      expect(snapshot?.connectionState).toBe('closed');
      expect(snapshot?.reconnecting).toBe(false);
      vi.advanceTimersByTime(60_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    },
  );

  it('refreshes a rejected WebSocket token once and then makes a repeated 4401 terminal', async () => {
    const onUnauthorized = vi.fn().mockResolvedValue('token-2');
    const client = new RoomClient('room-1', 'token-1', { bluetooth: false }, { onUnauthorized });
    let snapshot: RoomSnapshot | undefined;
    client.subscribe((value) => {
      snapshot = value;
    });
    client.connect();
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.open();
    firstSocket.serverClose(4401);

    expect(snapshot?.connectionState).toBe('authenticating');
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(onUnauthorized).toHaveBeenCalledWith('token-1');

    const secondSocket = FakeWebSocket.instances[1]!;
    secondSocket.open();
    expect(envelopes(secondSocket)[0]).toMatchObject({
      type: 'JOIN_ROOM',
      payload: { accessToken: 'token-2' },
    });
    secondSocket.serverClose(4401);
    expect(snapshot?.connectionState).toBe('closed');
    expect(onUnauthorized).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('waits offline without opening a socket and reconnects when the browser returns online', () => {
    let online = false;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    const client = new RoomClient('room-1', 'token-1', { bluetooth: false });
    let snapshot: RoomSnapshot | undefined;
    client.subscribe((value) => {
      snapshot = value;
    });

    client.connect();
    expect(snapshot?.connectionState).toBe('offline');
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(client.start({ measure: 1, pass: 1 })).toBe(false);

    online = true;
    window.dispatchEvent(new Event('online'));
    expect(snapshot?.connectionState).toBe('connecting');
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.message({ type: 'JOINED', payload: { userId: 'user-1', role: 'member' } });
    expect(snapshot?.connectionState).toBe('joined');

    online = false;
    window.dispatchEvent(new Event('offline'));
    expect(snapshot?.connectionState).toBe('offline');
    expect(client.seek({ measure: 2, pass: 1 })).toBe(false);
  });

  it('uses only correlated PONG frames and initializes from the minimum-RTT burst', () => {
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const client = new RoomClient('room-1', 'token-1', { bluetooth: false });
    let snapshot: RoomSnapshot | undefined;
    client.subscribe((value) => {
      snapshot = value;
    });
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    expect(envelopes(socket)[0]?.payload.calibrationId).toBeNull();
    socket.message({ type: 'JOINED', payload: { userId: 'user-1', role: 'member' } });

    for (let index = 0; index < 10; index += 1) {
      const ping = envelopes(socket)
        .filter((envelope) => envelope.type === 'PING')
        .at(-1)!;
      const t0 = Number(ping.payload.t0);
      const rtt = index === 4 ? 2 : 10;
      now = t0 + rtt;
      socket.message({
        type: 'PONG',
        payload: {
          t0,
          serverReceiveTimeNs: (t0 + rtt / 2 + 1_000) * 1_000_000,
        },
      });
      if (index < 9) {
        now += 80;
        vi.advanceTimersByTime(80);
      }
    }

    expect(snapshot).toMatchObject({ offsetMs: 1_000, rttMs: 2, error: undefined });
    expect(envelopes(socket)).toContainEqual(
      expect.objectContaining({ type: 'REPORT_RTT', payload: { rttMs: 2 } }),
    );

    socket.message({
      type: 'PONG',
      payload: { t0: 999_999, serverReceiveTimeNs: 1_000_000 },
    });
    expect(snapshot?.error).toBe('잘못된 시계 동기 응답입니다.');
  });

  it('requires the roster Bluetooth field instead of inventing a default', () => {
    const client = new RoomClient('room-1', 'token-1', { bluetooth: false });
    let snapshot: RoomSnapshot | undefined;
    client.subscribe((value) => {
      snapshot = value;
    });
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.message({
      type: 'TRANSPORT',
      payload: {
        roomId: 'room-1',
        repertoireId: 'repertoire-1',
        tempoMapRevision: 1,
        status: 'idle',
        anchor: null,
        serverStartTimeNs: null,
        countIn: true,
        lateJoin: null,
      },
    });
    expect(snapshot?.transport).not.toHaveProperty('serverStartTime');
    socket.message({
      type: 'ROOM_ROSTER',
      payload: {
        members: [
          {
            userId: 'user-1',
            displayName: 'Player',
            role: 'member',
            ready: false,
            calibrated: true,
            bluetooth: true,
          },
        ],
      },
    });
    expect(snapshot?.roster[0]?.bluetooth).toBe(true);

    socket.message({
      type: 'ROOM_ROSTER',
      payload: {
        members: [
          {
            userId: 'user-1',
            displayName: 'Player',
            role: 'member',
            ready: false,
            calibrated: true,
          },
        ],
      },
    });
    expect(snapshot?.error).toBe('잘못된 참가자 목록 응답입니다.');
  });
});
