import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type * as UiPackage from '@feelmyrythm/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audio = vi.hoisted(() => ({
  now: vi.fn(() => 0),
  outputLatency: vi.fn(() => 0),
  scheduleClick: vi.fn(),
  start: vi.fn<() => Promise<void>>(),
  stop: vi.fn(),
}));
const database = vi.hoisted(() => ({
  listCalibrations: vi.fn(),
  putCalibration: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  client: {
    get: vi.fn(),
    put: vi.fn(),
  },
  user: null as null | { id: string },
}));
const notify = vi.hoisted(() => vi.fn());

vi.mock('@feelmyrythm/audio', () => ({
  WebAudioEngine: class {
    now = audio.now;
    outputLatency = audio.outputLatency;
    scheduleClick = audio.scheduleClick;
    start = audio.start;
    stop = audio.stop;
  },
}));

vi.mock('../lib/localDb', () => ({
  localDb: database,
}));

vi.mock('../lib/auth', () => ({
  useAuth: () => auth,
}));

vi.mock('@feelmyrythm/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof UiPackage>();
  return {
    ...actual,
    useToast: () => ({ notify }),
  };
});

import { CalibrationPage } from './CalibrationPage';

interface MediaDeviceHarness {
  addEventListener: ReturnType<typeof vi.fn>;
  enumerateDevices: ReturnType<typeof vi.fn>;
  getUserMedia: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

function device(label: string): MediaDeviceInfo {
  return {
    deviceId: label || 'hidden-output',
    groupId: 'group-1',
    kind: 'audiooutput',
    label,
    toJSON: () => ({}),
  };
}

describe('CalibrationPage device and persistence states', () => {
  let values: Map<string, string>;
  let mediaDevices: MediaDeviceHarness;
  let deviceChangeListener: EventListener | null;
  let stopTrack: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    values = new Map();
    deviceChangeListener = null;
    stopTrack = vi.fn();
    mediaDevices = {
      addEventListener: vi.fn((event: string, listener: EventListener) => {
        if (event === 'devicechange') deviceChangeListener = listener;
      }),
      enumerateDevices: vi.fn().mockResolvedValue([device('')]),
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [{ stop: stopTrack }],
      }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('localStorage', {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    });
    vi.stubGlobal('navigator', {
      mediaDevices,
      platform: 'test-platform',
      userAgent: 'test-agent',
    });
    vi.stubGlobal('crypto', {
      subtle: {
        digest: vi.fn().mockResolvedValue(new Uint8Array(32).buffer),
      },
    });
    auth.user = null;
    auth.client.get.mockReset().mockResolvedValue([]);
    auth.client.put.mockReset();
    database.listCalibrations.mockReset().mockResolvedValue([]);
    database.putCalibration.mockReset().mockResolvedValue(undefined);
    audio.start.mockReset().mockResolvedValue(undefined);
    audio.stop.mockReset();
    audio.scheduleClick.mockReset();
    audio.now.mockReset().mockReturnValue(0);
    audio.outputLatency.mockReset().mockReturnValue(0);
    notify.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows IndexedDB loading and an inline retry without rendering a false empty state', async () => {
    let rejectLoad: (reason: Error) => void = () => undefined;
    database.listCalibrations.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectLoad = reject;
        }),
    );
    database.listCalibrations.mockResolvedValueOnce([
      {
        deviceFingerprint: '000000000000000000000000',
        id: 'saved-speaker',
        offsetMs: 18.5,
        outputLabel: '외장 스피커',
        samples: [0, 18, 19],
        updatedAt: '2026-08-14T00:00:00.000Z',
      },
    ]);

    render(<CalibrationPage />);
    expect(screen.getByText('이 기기의 보정값을 불러오는 중…')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(
      screen.queryByText('이 기기에 저장된 출력 장치 보정이 없습니다.'),
    ).not.toBeInTheDocument();

    await waitFor(() => expect(database.listCalibrations).toHaveBeenCalledOnce());
    await act(async () => rejectLoad(new Error('IndexedDB unavailable')));
    expect(await screen.findByRole('alert')).toHaveTextContent('IndexedDB unavailable');
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));

    expect(await screen.findByText('외장 스피커')).toBeInTheDocument();
    expect(database.listCalibrations).toHaveBeenCalledTimes(2);
    expect(database.listCalibrations).toHaveBeenCalledWith('000000000000000000000000');
  });

  it('surfaces audio-engine startup failure, retries inline, and stops on unmount', async () => {
    let rejectStart: (reason: Error) => void = () => undefined;
    audio.start
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectStart = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const { unmount } = render(<CalibrationPage />);
    await screen.findByText('이 기기에 저장된 출력 장치 보정이 없습니다.');
    fireEvent.click(screen.getByRole('button', { name: '측정 시작' }));
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('오디오 엔진을 시작하는 중');

    await act(async () => rejectStart(new Error('AudioContext blocked')));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('AudioContext blocked');
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));

    expect(await screen.findByRole('button', { name: /클릭이 들릴 때 누르세요/ })).toBeEnabled();
    unmount();
    expect(audio.stop).toHaveBeenCalled();
  });

  it('surfaces local save failure and makes the save operation retryable', async () => {
    let rejectSave: (reason: Error) => void = () => undefined;
    database.putCalibration
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectSave = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);
    render(<CalibrationPage />);
    await screen.findByText('이 기기에 저장된 출력 장치 보정이 없습니다.');

    fireEvent.click(screen.getByRole('button', { name: '측정 시작' }));
    const tapButton = await screen.findByRole('button', { name: /클릭이 들릴 때 누르세요/ });
    for (let index = 0; index < 9; index += 1) fireEvent.click(tapButton);

    fireEvent.click(screen.getByRole('button', { name: '이 장치에 저장' }));
    expect(screen.getByText('보정값을 이 기기에 저장하는 중…')).toBeInTheDocument();
    await waitFor(() => expect(database.putCalibration).toHaveBeenCalledOnce());
    await act(async () => rejectSave(new Error('quota exceeded')));
    expect(await screen.findByRole('alert')).toHaveTextContent('quota exceeded');
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));

    await waitFor(() => expect(values.get('fmr.hasCalibration')).toBe('true'));
    expect(database.putCalibration).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: '출력 지연 보정을 저장했습니다.' }),
    );
  });

  it('keeps unknown distinct until permission reveals a labelled wireless output', async () => {
    mediaDevices.enumerateDevices
      .mockResolvedValueOnce([device('')])
      .mockResolvedValueOnce([device('AirPods Pro')]);
    render(<CalibrationPage />);

    expect(await screen.findByText('확인 필요')).toBeInTheDocument();
    expect(values.get('fmr.bluetoothDetectionStatus')).toBe('unknown');
    fireEvent.click(screen.getByRole('button', { name: /권한 허용 후 다시 확인/ }));

    expect(await screen.findByText('무선 장치 감지됨')).toBeInTheDocument();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(values.get('fmr.bluetoothDetectionStatus')).toBe('detected');
    expect(values.get('fmr.bluetoothDetected')).toBe('true');
  });

  it('supports not-detected, manual override, and devicechange while preserving the legacy key', async () => {
    mediaDevices.enumerateDevices.mockResolvedValue([device('MacBook Speakers')]);
    render(<CalibrationPage />);

    expect(await screen.findByText('무선 장치 없음')).toBeInTheDocument();
    const manual = screen.getByRole('checkbox', { name: /무선 출력 사용 중/ });
    fireEvent.click(manual);
    await waitFor(() => expect(values.get('fmr.bluetoothDetected')).toBe('true'));
    expect(values.get('fmr.bluetoothManualWireless')).toBe('true');
    expect(screen.getByText('무선 오디오 출력으로 설정되었습니다.')).toBeInTheDocument();

    fireEvent.click(manual);
    await waitFor(() => expect(values.get('fmr.bluetoothDetected')).toBe('false'));
    mediaDevices.enumerateDevices.mockResolvedValue([device('Bluetooth Headphones')]);
    await act(async () => deviceChangeListener?.(new Event('devicechange')));

    expect(await screen.findByText('무선 장치 감지됨')).toBeInTheDocument();
    expect(values.get('fmr.bluetoothDetected')).toBe('true');
    cleanup();
    expect(mediaDevices.removeEventListener).toHaveBeenCalledWith(
      'devicechange',
      expect.any(Function),
    );
  });
});
