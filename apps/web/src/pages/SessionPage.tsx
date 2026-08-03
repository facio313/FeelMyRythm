/**
 * 앙상블 동기 세션 (설계문서 §6, UI_DESIGN.md §7.3).
 * 서버와 시계를 맞춘 뒤 serverStartTime을 로컬 오디오 시각으로 변환해 예비박부터 정확히 스케줄.
 * 시작 후에는 네트워크가 끊겨도 재생이 로컬에서 계속된다.
 */
import type { TempoMap } from '@feelmyrythm/core';
import type { ScheduledBeat } from '@feelmyrythm/audio';
import type { RosterMember, TempoMapOut, TransportState } from '@feelmyrythm/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { BeatVisualizer } from '../components/BeatVisualizer';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { getCalibrationMs } from '../lib/localMaps';
import { RoomClient, type RoomStatus } from '../lib/roomClient';
import { getEngine, useMetronome } from '../lib/useMetronome';

export default function SessionPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const { token, user } = useAuth();
  const { isRunning, timeline, queueRef, start, stop } = useMetronome();

  const clientRef = useRef<RoomClient | null>(null);
  const startedForRef = useRef<number | null>(null);

  const [wsStatus, setWsStatus] = useState<RoomStatus>('connecting');
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [transport, setTransport] = useState<TransportState | null>(null);
  const [map, setMap] = useState<TempoMap | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const [error, setError] = useState('');
  const [display, setDisplay] = useState<{ measure: number | null; countIn: boolean }>({ measure: null, countIn: false });
  const [clockInfo, setClockInfo] = useState<{ offset: number; rtt: number } | null>(null);

  const [startMeasure, setStartMeasure] = useState(1);
  const [useCountIn, setUseCountIn] = useState(true);

  // WS 연결
  useEffect(() => {
    if (!roomId || !token) return;
    const client = new RoomClient();
    clientRef.current = client;
    client.onStatus = setWsStatus;
    client.onRoster = setRoster;
    client.onError = setError;
    client.onTransport = (s) => {
      setTransport(s);
      if (s.status === 'idle') {
        startedForRef.current = null;
      }
    };
    client.onTempoMapUpdated = () => {
      setMap(null); // 재요청 트리거
    };
    client.connect(roomId, token);

    const clockTimer = window.setInterval(() => {
      if (client.clock.offsetMs !== null && client.clock.minRttMs !== null) {
        setClockInfo({ offset: client.clock.offsetMs, rtt: client.clock.minRttMs });
      }
    }, 1000);

    return () => {
      clearInterval(clockTimer);
      client.close();
      clientRef.current = null;
    };
  }, [roomId, token]);

  // 템포맵 로드 (revision 변경 시 재요청 — TEMPOMAP_UPDATED가 setMap(null)로 트리거)
  useEffect(() => {
    if (!transport || map) return;
    api<TempoMapOut>(`/api/repertoire/${transport.repertoireId}/tempomap`)
      .then((r) => setMap(r.data as TempoMap))
      .catch((e) => setError(e.message));
  }, [transport, map]);

  // 동기 시작: TRANSPORT(playing) + 오디오 준비 + 시계 동기 완료가 모두 갖춰지면 스케줄
  useEffect(() => {
    const client = clientRef.current;
    if (!transport || transport.status !== 'playing' || !transport.serverStartTime || !transport.anchor) return;
    if (!audioReady || !map || !client?.ready) return;
    if (startedForRef.current === transport.serverStartTime) return; // 같은 시작 명령 중복 방지

    const engine = getEngine();
    const firstBeatAudioTime = client.serverTimeToAudioTime(
      transport.serverStartTime,
      engine.now(),
      getCalibrationMs(),
    );
    startedForRef.current = transport.serverStartTime;
    void start(map, {
      startMeasure: transport.anchor.measure,
      pass: transport.anchor.pass,
      countIn: transport.countIn,
      firstBeatAudioTime,
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [transport, audioReady, map, start]);

  // 정지 명령 반영
  useEffect(() => {
    if (transport?.status === 'idle' && isRunning) stop();
  }, [transport, isRunning, stop]);

  const onDisplayBeat = useCallback((b: ScheduledBeat | null) => {
    setDisplay({ measure: b?.measureNumber ?? null, countIn: b?.isCountIn ?? false });
  }, []);

  const me = roster.find((m) => m.userId === user?.id);
  const isLeader = me?.isLeader ?? false;
  const calibration = getCalibrationMs();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="section-title m-0">앙상블 세션</h1>
        <button
          className="chip tnum cursor-pointer"
          title="코드 복사"
          onClick={() => navigator.clipboard.writeText(roomId ?? '')}
        >
          코드 {roomId} ⧉
        </button>
        <span
          className="chip"
          style={{ color: wsStatus === 'open' ? 'var(--success)' : 'var(--danger)' }}
        >
          {wsStatus === 'open' ? '연결됨' : wsStatus === 'connecting' ? '연결 중…' : '연결 끊김'}
        </span>
        {clockInfo && (
          <span className="chip tnum" title="서버 시계 오프셋 / 최소 RTT">
            동기 ±{Math.abs(clockInfo.offset).toFixed(0)}ms · RTT {clockInfo.rtt.toFixed(0)}ms
          </span>
        )}
        <span className="chip tnum">보정 {calibration}ms</span>
      </div>

      {/* 참가자 */}
      <div className="flex flex-wrap gap-2">
        {roster.map((m) => (
          <span key={m.userId} className="chip">
            {m.isLeader && <span style={{ color: 'var(--accent)' }}>★</span>}
            {m.displayName}
            {m.rttMs !== undefined && m.rttMs !== null && (
              <span className="tnum" style={{ color: m.rttMs < 50 ? 'var(--success)' : 'var(--danger)' }}>
                {Math.round(m.rttMs)}ms
              </span>
            )}
          </span>
        ))}
      </div>

      {!audioReady && (
        <div className="card flex items-center gap-4">
          <span>브라우저 정책상 오디오는 버튼을 눌러 활성화해야 합니다.</span>
          <button
            className="btn btn-primary"
            onClick={async () => {
              await getEngine().start();
              setAudioReady(true);
            }}
          >
            오디오 준비
          </button>
        </div>
      )}

      <div className="w-full">
        <BeatVisualizer queueRef={queueRef} timeline={timeline} running={isRunning} onDisplayBeat={onDisplayBeat} />
        <div className="tnum text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          {display.countIn
            ? '예비박… 다 같이 들어갑니다'
            : display.measure !== null
              ? `마디 ${display.measure}`
              : transport?.status === 'playing'
                ? '동기 대기 중…'
                : '대기 중 — 리더가 시작하면 전원 동시에 예비박이 울립니다'}
        </div>
      </div>

      {/* 리더 트랜스포트 바 */}
      {isLeader && (
        <div className="card flex flex-wrap items-center gap-3">
          <span className="chip" style={{ color: 'var(--accent)' }}>
            리더
          </span>
          <label className="flex items-center gap-2 text-sm">
            시작 마디
            <input
              type="number"
              min={1}
              max={map?.totalMeasures ?? 999}
              className="input tnum w-24"
              value={startMeasure}
              onChange={(e) => setStartMeasure(Number(e.target.value) || 1)}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={useCountIn} onChange={(e) => setUseCountIn(e.target.checked)} />
            예비박
          </label>
          <button
            className="btn btn-primary"
            disabled={transport?.status === 'playing' || !map}
            onClick={() => clientRef.current?.cmdStart(startMeasure, useCountIn)}
          >
            ▶ 전원 동기 시작
          </button>
          <button
            className="btn btn-danger"
            disabled={transport?.status !== 'playing'}
            onClick={() => clientRef.current?.cmdStop()}
          >
            ■ 정지
          </button>
        </div>
      )}

      {!map && transport && (
        <div style={{ color: 'var(--text-muted)' }}>템포맵 불러오는 중… (revision {transport.tempoMapRevision})</div>
      )}
      {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}

      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        팁: 블루투스 스피커·이어폰은 지연이 커서(100~300ms) 앙상블 동기에 불리합니다. 내장 스피커/유선을
        사용하고, 기기마다 캘리브레이션을 한 번씩 해두세요.
      </p>
    </div>
  );
}
