/**
 * 동기 세션 WS 클라이언트 (설계문서 §6.2~6.4).
 * 입장 직후 PING 버스트로 서버 시계 오프셋 추정 → 이후 10초 주기 재측정.
 */
import { ClockSyncEstimator } from '@feelmyrythm/core';
import type { RosterMember, TransportState, WsServerMessage } from '@feelmyrythm/protocol';
import { appPath } from './paths';

const BURST_COUNT = 10;
const BURST_INTERVAL_MS = 150;
const PERIODIC_INTERVAL_MS = 10_000;

export type RoomStatus = 'connecting' | 'open' | 'closed';

export class RoomClient {
  private ws: WebSocket | null = null;
  private timers: number[] = [];
  private pongsReceived = 0;
  readonly clock = new ClockSyncEstimator();

  onTransport: ((s: TransportState) => void) | null = null;
  onRoster: ((m: RosterMember[]) => void) | null = null;
  onTempoMapUpdated: ((revision: number) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  onStatus: ((s: RoomStatus) => void) | null = null;

  connect(roomId: string, token: string): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.onStatus?.('connecting');
    const wsPath = appPath(`/ws/rooms/${roomId}`);
    this.ws = new WebSocket(`${proto}://${location.host}${wsPath}?token=${encodeURIComponent(token)}`);

    this.ws.onopen = () => {
      this.onStatus?.('open');
      for (let i = 0; i < BURST_COUNT; i++) {
        this.timers.push(window.setTimeout(() => this.sendPing(), i * BURST_INTERVAL_MS));
      }
      this.timers.push(window.setInterval(() => this.sendPing(), PERIODIC_INTERVAL_MS));
    };

    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as WsServerMessage;
      switch (msg.type) {
        case 'PONG': {
          this.clock.addPingPong(msg.t0, msg.t1, Date.now());
          this.pongsReceived++;
          if (this.pongsReceived === BURST_COUNT && this.clock.minRttMs !== null) {
            this.send({ type: 'REPORT_RTT', rttMs: Math.round(this.clock.minRttMs) });
          }
          break;
        }
        case 'TRANSPORT':
          this.onTransport?.(msg.state);
          break;
        case 'ROOM_ROSTER':
          this.onRoster?.(msg.members);
          break;
        case 'TEMPOMAP_UPDATED':
          this.onTempoMapUpdated?.(msg.revision);
          break;
        case 'ERROR':
          this.onError?.(msg.message);
          break;
      }
    };

    this.ws.onclose = () => {
      this.clearTimers();
      this.onStatus?.('closed');
    };
  }

  private sendPing(): void {
    this.send({ type: 'PING', t0: Date.now() });
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  cmdStart(measure: number, countIn: boolean): void {
    this.send({ type: 'CMD_START', measure, countIn });
  }

  cmdStop(): void {
    this.send({ type: 'CMD_STOP' });
  }

  /**
   * 서버 epoch ms → 로컬 오디오 클럭 시각(초).
   * calibrationMs: 기기 출력 지연 보정 (§6.5) — 늦게 나는 기기는 그만큼 일찍 예약.
   */
  serverTimeToAudioTime(serverMs: number, engineNowSec: number, calibrationMs = 0): number {
    const clientEpoch = this.clock.serverToClientMs(serverMs);
    return engineNowSec + (clientEpoch - Date.now()) / 1000 - calibrationMs / 1000;
  }

  get ready(): boolean {
    return this.clock.offsetMs !== null;
  }

  private clearTimers(): void {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers = [];
  }

  close(): void {
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
  }
}
