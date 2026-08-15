import { median } from '@feelmyrythm/core';
import { Button, Card, Field, StatusBadge, useToast } from '@feelmyrythm/ui';
import {
  Bluetooth,
  CheckCircle2,
  Headphones,
  Radio,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../lib/auth';
import { createPlatformAudioEngine, type ManagedAudioEngine } from '../lib/audioEngine';
import { localDb, type DeviceCalibration } from '../lib/localDb';
import { useAsync } from '../lib/useAsync';

interface ServerCalibration {
  id: string;
  deviceFingerprint: string;
  outputLabel: string;
  offsetMs: number;
  updatedAt: string;
}

interface CalibrationLoadResult {
  items: DeviceCalibration[];
  syncWarning: string | null;
}

type CalibrationPhase = 'idle' | 'starting' | 'running' | 'saving' | 'complete' | 'error';
type CalibrationAction = 'start' | 'save';
type BluetoothDetectionStatus = 'unknown' | 'detected' | 'not-detected';

const BLUETOOTH_COMPATIBILITY_KEY = 'fmr.bluetoothDetected';
const BLUETOOTH_STATUS_KEY = 'fmr.bluetoothDetectionStatus';
const BLUETOOTH_MANUAL_KEY = 'fmr.bluetoothManualWireless';
const WIRELESS_DEVICE_PATTERN = /bluetooth|airpods|buds|wireless|beats|freebuds|galaxy buds/i;

async function fingerprint(): Promise<string> {
  const source = [
    navigator.userAgent,
    navigator.platform,
    screen.width,
    screen.height,
    window.devicePixelRatio,
  ].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function readBluetoothStatus(): BluetoothDetectionStatus {
  try {
    const stored = localStorage.getItem(BLUETOOTH_STATUS_KEY);
    if (stored === 'detected' || stored === 'not-detected' || stored === 'unknown') return stored;
    return localStorage.getItem(BLUETOOTH_COMPATIBILITY_KEY) === 'true' ? 'detected' : 'unknown';
  } catch {
    return 'unknown';
  }
}

function readManualWirelessSelection(): boolean {
  try {
    return localStorage.getItem(BLUETOOTH_MANUAL_KEY) === 'true';
  } catch {
    return false;
  }
}

function persistBluetoothState(status: BluetoothDetectionStatus, manualWireless: boolean): void {
  try {
    localStorage.setItem(BLUETOOTH_STATUS_KEY, status);
    localStorage.setItem(BLUETOOTH_MANUAL_KEY, String(manualWireless));
    localStorage.setItem(
      BLUETOOTH_COMPATIBILITY_KEY,
      String(status === 'detected' || manualWireless),
    );
  } catch {
    // Storage may be unavailable in a private browsing context. The current page state still works.
  }
}

async function inspectBluetoothOutput(
  requestPermission: boolean,
): Promise<BluetoothDetectionStatus> {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices?.enumerateDevices) {
    throw new Error('이 브라우저에서는 오디오 출력 장치 목록을 확인할 수 없습니다.');
  }

  if (requestPermission) {
    if (!mediaDevices.getUserMedia) {
      throw new Error('장치 이름을 확인할 권한을 요청할 수 없습니다.');
    }
    const stream = await mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
  }

  const outputs = (await mediaDevices.enumerateDevices()).filter(
    (device) => device.kind === 'audiooutput',
  );
  const labelledOutputs = outputs.filter((device) => device.label.trim().length > 0);
  if (labelledOutputs.length === 0) return 'unknown';
  return labelledOutputs.some((device) => WIRELESS_DEVICE_PATTERN.test(device.label))
    ? 'detected'
    : 'not-detected';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CalibrationPage() {
  const { notify } = useToast();
  const { user, client } = useAuth();
  const engineRef = useRef<ManagedAudioEngine | undefined>(undefined);
  const engineGenerationRef = useRef(0);
  const bluetoothGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const savePendingRef = useRef(false);
  const expectedRef = useRef<number[]>([]);
  const [outputLabel, setOutputLabel] = useState('내장 스피커');
  const [phase, setPhase] = useState<CalibrationPhase>('idle');
  const [operationError, setOperationError] = useState<{
    action: CalibrationAction;
    message: string;
  } | null>(null);
  const [samples, setSamples] = useState<number[]>([]);
  const [bluetoothStatus, setBluetoothStatus] =
    useState<BluetoothDetectionStatus>(readBluetoothStatus);
  const [manualWireless, setManualWireless] = useState(readManualWirelessSelection);
  const [bluetoothChecking, setBluetoothChecking] = useState(false);
  const [bluetoothError, setBluetoothError] = useState<string | null>(null);
  const offset = useMemo(() => (samples.length > 1 ? median(samples.slice(1)) : 0), [samples]);
  const calibrations = useAsync<CalibrationLoadResult>(async () => {
    const deviceFingerprint = await fingerprint();
    const local = await localDb.listCalibrations(deviceFingerprint);
    if (!user) return { items: local, syncWarning: null };

    try {
      const remote = await client.get<ServerCalibration[]>('/calibrations');
      const merged = new Map(local.map((item) => [item.outputLabel, item]));
      const remoteForDevice = remote.filter(
        (candidate) => candidate.deviceFingerprint === deviceFingerprint,
      );
      for (const item of remoteForDevice) {
        const calibration: DeviceCalibration = {
          ...item,
          samples: merged.get(item.outputLabel)?.samples ?? [],
        };
        merged.set(item.outputLabel, calibration);
        await localDb.putCalibration(calibration);
      }
      return { items: [...merged.values()], syncWarning: null };
    } catch (error) {
      return {
        items: local,
        syncWarning: `서버 보정값을 동기화하지 못했습니다. ${errorMessage(error)}`,
      };
    }
  }, [client, user?.id]);

  const measuring = phase === 'starting' || phase === 'running';
  const busy = measuring || phase === 'saving';
  const wirelessOutput = bluetoothStatus === 'detected' || manualWireless;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      engineGenerationRef.current += 1;
      bluetoothGenerationRef.current += 1;
      engineRef.current?.stop();
      engineRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    persistBluetoothState(bluetoothStatus, manualWireless);
  }, [bluetoothStatus, manualWireless]);

  useEffect(() => {
    let active = true;
    const mediaDevices = navigator.mediaDevices;

    const refresh = async () => {
      const generation = bluetoothGenerationRef.current + 1;
      bluetoothGenerationRef.current = generation;
      try {
        const status = await inspectBluetoothOutput(false);
        if (active && bluetoothGenerationRef.current === generation) {
          setBluetoothStatus(status);
          setBluetoothError(null);
        }
      } catch (error) {
        if (active && bluetoothGenerationRef.current === generation) {
          setBluetoothStatus('unknown');
          setBluetoothError(errorMessage(error));
        }
      }
    };

    void refresh();
    const handleDeviceChange = () => void refresh();
    mediaDevices?.addEventListener?.('devicechange', handleDeviceChange);
    return () => {
      active = false;
      mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange);
    };
  }, []);

  async function requestBluetoothPermission() {
    const generation = bluetoothGenerationRef.current + 1;
    bluetoothGenerationRef.current = generation;
    setBluetoothChecking(true);
    setBluetoothError(null);
    try {
      const status = await inspectBluetoothOutput(true);
      if (mountedRef.current && bluetoothGenerationRef.current === generation) {
        setBluetoothStatus(status);
      }
    } catch (error) {
      if (mountedRef.current && bluetoothGenerationRef.current === generation) {
        setBluetoothStatus('unknown');
        setBluetoothError(errorMessage(error));
      }
    } finally {
      if (mountedRef.current) setBluetoothChecking(false);
    }
  }

  async function begin() {
    const generation = engineGenerationRef.current + 1;
    engineGenerationRef.current = generation;
    engineRef.current?.stop();
    engineRef.current = undefined;
    setPhase('starting');
    setOperationError(null);

    const engine = createPlatformAudioEngine();
    engineRef.current = engine;
    try {
      await engine.start();
      if (!mountedRef.current || engineGenerationRef.current !== generation) {
        engine.stop();
        return;
      }
      const startAudio = engine.now() + 0.8;
      const audioNow = engine.now();
      const performanceNow = performance.now();
      expectedRef.current = Array.from({ length: 9 }, (_, index) => {
        const at = startAudio + index;
        engine.scheduleClick(at, 'countIn');
        return performanceNow + (at - audioNow + engine.outputLatency()) * 1000;
      });
      setSamples([]);
      setPhase('running');
      notify({
        title: '테스트 클릭을 시작합니다.',
        description: '소리가 들리는 순간마다 아래 큰 버튼을 누르세요.',
        tone: 'info',
      });
    } catch (error) {
      engine.stop();
      if (engineRef.current === engine) engineRef.current = undefined;
      if (mountedRef.current && engineGenerationRef.current === generation) {
        setPhase('error');
        setOperationError({ action: 'start', message: errorMessage(error) });
      }
    }
  }

  function tap() {
    if (phase !== 'running') return;
    const index = samples.length;
    const expected = expectedRef.current[index];
    if (expected === undefined) return;
    const residual = performance.now() - expected;
    const next = [...samples, residual];
    setSamples(next);
    if (next.length >= expectedRef.current.length) {
      engineGenerationRef.current += 1;
      engineRef.current?.stop();
      engineRef.current = undefined;
      setPhase('complete');
    }
  }

  function cancel() {
    engineGenerationRef.current += 1;
    engineRef.current?.stop();
    engineRef.current = undefined;
    setPhase('idle');
    setOperationError(null);
  }

  async function save() {
    if (savePendingRef.current || samples.length < 9 || !outputLabel.trim()) return;
    savePendingRef.current = true;
    setPhase('saving');
    setOperationError(null);
    try {
      const deviceFingerprint = await fingerprint();
      const calibration: DeviceCalibration = {
        id: `${deviceFingerprint}:${outputLabel.trim().toLowerCase()}`,
        deviceFingerprint,
        outputLabel: outputLabel.trim(),
        offsetMs: offset,
        samples,
        updatedAt: new Date().toISOString(),
      };
      await localDb.putCalibration(calibration);
      let serverCalibrationId: string | null = null;
      if (user) {
        try {
          const remote = await client.put<ServerCalibration>('/calibrations', {
            deviceFingerprint,
            outputLabel: calibration.outputLabel,
            offsetMs: offset,
          });
          serverCalibrationId = remote.id;
          localStorage.setItem('fmr.serverCalibrationId', remote.id);
        } catch (error) {
          if (mountedRef.current) {
            notify({
              title: '이 기기에는 저장했지만 서버와 동기하지 못했습니다.',
              description: errorMessage(error),
              tone: 'info',
            });
          }
        }
      }
      localStorage.setItem('fmr.hasCalibration', 'true');
      localStorage.setItem('fmr.calibrationOffsetMs', String(offset));
      if (!mountedRef.current) return;
      calibrations.reload();
      setPhase('complete');
      notify({
        title: '출력 지연 보정을 저장했습니다.',
        description: `양수 ${offset.toFixed(1)}ms는 클릭을 그만큼 앞당겨 예약합니다.${serverCalibrationId ? ' 앙상블 세션에도 적용됩니다.' : ''}`,
        tone: 'success',
      });
    } catch (error) {
      if (mountedRef.current) {
        setPhase('error');
        setOperationError({ action: 'save', message: errorMessage(error) });
      }
    } finally {
      savePendingRef.current = false;
    }
  }

  const bluetoothLabel =
    bluetoothStatus === 'detected'
      ? '무선 장치 감지됨'
      : bluetoothStatus === 'not-detected'
        ? '무선 장치 없음'
        : '확인 필요';
  const bluetoothDescription =
    bluetoothStatus === 'detected'
      ? '현재 출력 목록에서 무선 오디오 장치를 찾았습니다.'
      : bluetoothStatus === 'not-detected'
        ? '권한이 허용된 출력 목록에서 무선 장치를 찾지 못했습니다.'
        : '장치 이름이 가려져 있거나 이 브라우저가 출력 목록을 제공하지 않았습니다.';

  return (
    <div className="page page--narrow calibration-page">
      <PageHeader
        eyebrow="Device latency"
        title="출력 지연 보정"
        description="기기와 출력 장치가 만드는 지연을 측정해 앙상블 클릭 시점을 보정합니다."
      />

      <Card className="calibration-device" aria-labelledby="calibration-device-title">
        <div className="calibration-device__heading">
          <Radio size={24} aria-hidden />
          <div>
            <div className="cluster">
              <h2 id="calibration-device-title">출력 장치 확인</h2>
              <StatusBadge
                tone={
                  bluetoothStatus === 'detected'
                    ? 'warning'
                    : bluetoothStatus === 'not-detected'
                      ? 'success'
                      : 'neutral'
                }
              >
                {bluetoothLabel}
              </StatusBadge>
            </div>
            <p className="subtle">{bluetoothDescription}</p>
          </div>
        </div>
        {bluetoothError ? (
          <p className="calibration-device__error" role="alert">
            {bluetoothError}
          </p>
        ) : null}
        <div className="calibration-device__actions">
          <Button onClick={() => void requestBluetoothPermission()} disabled={bluetoothChecking}>
            <RotateCcw size={17} aria-hidden />
            {bluetoothChecking ? '장치 확인 중…' : '권한 허용 후 다시 확인'}
          </Button>
          <label className="calibration-wireless-toggle">
            <input
              type="checkbox"
              checked={manualWireless}
              onChange={(event) => setManualWireless(event.target.checked)}
            />
            <span>
              <strong>무선 출력 사용 중</strong>
              <small>자동 감지가 어려우면 직접 선택하세요.</small>
            </span>
          </label>
        </div>
      </Card>

      {wirelessOutput ? (
        <div className="bluetooth-warning" role="alert">
          <Bluetooth aria-hidden />
          <div>
            <strong>무선 오디오 출력으로 설정되었습니다.</strong>
            <span>
              블루투스는 보통 100–300ms 지연됩니다. 합주에는 유선 또는 내장 스피커를 권장합니다.
            </span>
          </div>
        </div>
      ) : null}

      <Card className="calibration-card" aria-busy={phase === 'starting' || phase === 'saving'}>
        <div className="calibration-card__heading">
          <Headphones size={28} aria-hidden />
          <div>
            <h2>탭 캘리브레이션</h2>
            <p className="subtle">첫 탭은 적응 표본으로 제외하고 나머지 중앙값을 사용합니다.</p>
          </div>
        </div>
        <Field
          label="출력 장치 이름"
          value={outputLabel}
          onChange={(event) => setOutputLabel(event.target.value)}
          disabled={busy}
        />
        <div className="cluster calibration-actions">
          <Button variant="primary" onClick={() => void begin()} disabled={busy}>
            <RotateCcw size={18} aria-hidden />
            {phase === 'starting' ? '오디오 시작 중…' : samples.length ? '다시 측정' : '측정 시작'}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={measuring || phase === 'saving' || samples.length < 9 || !outputLabel.trim()}
          >
            <CheckCircle2 size={18} aria-hidden />
            {phase === 'saving' ? '저장 중…' : '이 장치에 저장'}
          </Button>
          <Button variant="ghost" onClick={cancel} disabled={!measuring}>
            측정 취소
          </Button>
        </div>
        {phase === 'starting' || phase === 'running' || phase === 'saving' ? (
          <p className="calibration-operation-status" role="status" aria-live="polite">
            {phase === 'starting'
              ? '오디오 엔진을 시작하는 중…'
              : phase === 'running'
                ? '측정 중입니다. 클릭이 들릴 때마다 탭 버튼을 누르세요.'
                : '보정값을 이 기기에 저장하는 중…'}
          </p>
        ) : null}
        {operationError ? (
          <div className="calibration-operation-error" role="alert">
            <span>
              {operationError.action === 'start'
                ? '오디오 엔진을 시작하지 못했습니다.'
                : '보정값을 저장하지 못했습니다.'}{' '}
              {operationError.message}
            </span>
            <Button
              size="compact"
              onClick={() => (operationError.action === 'start' ? void begin() : void save())}
            >
              다시 시도
            </Button>
          </div>
        ) : null}
        <button
          className={
            phase === 'running' ? 'calibration-tap calibration-tap--running' : 'calibration-tap'
          }
          type="button"
          onClick={tap}
          disabled={phase !== 'running'}
        >
          <span className="fmr-tabular">{phase === 'running' ? samples.length + 1 : 'TAP'}</span>
          <small>
            {phase === 'running' ? '클릭이 들릴 때 누르세요' : '먼저 측정을 시작하세요'}
          </small>
        </button>
        <div
          className="calibration-result"
          role="progressbar"
          aria-label="캘리브레이션 진행률"
          aria-valuemin={0}
          aria-valuemax={9}
          aria-valuenow={samples.length}
          aria-valuetext={`${samples.length} / 9 탭, 유효 표본 ${Math.max(0, samples.length - 1)} / 8`}
        >
          <div>
            <span>유효 표본</span>
            <strong className="fmr-tabular">{Math.max(0, samples.length - 1)} / 8</strong>
          </div>
          <div>
            <span>중앙값 보정</span>
            <strong className="fmr-tabular">{offset.toFixed(1)} ms</strong>
          </div>
        </div>
      </Card>

      <section className="saved-calibrations" aria-labelledby="saved-calibrations-title">
        <h2 id="saved-calibrations-title">저장된 보정</h2>
        {calibrations.loading && calibrations.data === null ? (
          <div className="loading-panel" role="status" aria-live="polite" aria-busy="true">
            이 기기의 보정값을 불러오는 중…
          </div>
        ) : null}
        {calibrations.error ? (
          <Card className="error-panel" role="alert">
            <h3>저장된 보정값을 불러오지 못했습니다.</h3>
            <p>{calibrations.error.message}</p>
            <Button onClick={calibrations.reload}>다시 시도</Button>
          </Card>
        ) : null}
        {calibrations.data?.syncWarning ? (
          <p className="calibration-sync-warning" role="status">
            {calibrations.data.syncWarning}
          </p>
        ) : null}
        {calibrations.data && calibrations.data.items.length === 0 ? (
          <p className="subtle">이 기기에 저장된 출력 장치 보정이 없습니다.</p>
        ) : null}
        {calibrations.data?.items.map((item) => (
          <Card key={item.id} className="saved-calibration">
            <SlidersHorizontal aria-hidden />
            <span>
              <strong>{item.outputLabel}</strong>
              <small>{new Date(item.updatedAt).toLocaleDateString('ko-KR')}</small>
            </span>
            <StatusBadge tone="success">{item.offsetMs.toFixed(1)}ms</StatusBadge>
          </Card>
        ))}
      </section>
    </div>
  );
}
