# Audio quality measurement tools

FeelMyRythm의 실기기 녹음을 같은 절차로 재검사하기 위한 두 개의 독립 CLI다.

- `click_intervals.py`: click onset 간격에서 jitter와 누적/선형 drift를 계산한다.
- `device_offset.py`: 한 stereo WAV의 두 채널 또는 시간축이 정렬된 두 mono WAV의 click
  onset impulse train을 cross-correlation하여 기기 간 offset을 계산한다.

두 도구 모두 성공 결과를 stdout의 JSON으로 출력한다. WAV 분석 오류는 stderr의 JSON과 종료
코드 1, 선택한 품질 기준 미달은 결과 JSON과 종료 코드 2로 나타낸다. 잘못된 CLI 문법은
`argparse` 사용 안내와 종료 코드 2를 사용한다.

## Requirements

Python 3.13 이상과 표준 라이브러리만 사용한다. `apps/server/pyproject.toml`에는 NumPy와 SciPy가
선언되어 있지 않으므로, 개발 머신의 우연한 전역 설치 여부에 의존하지 않는다. RIFF/WAVE의
uncompressed integer PCM 8/16/24/32-bit를 지원한다.

## Recording setup

간격 분석은 30분 재생 전체를 한 WAV로 녹음한다. 자동 gain control, noise suppression, 파일
중간의 편집이나 time-stretch는 끄는 것이 좋다. 녹음 peak가 clipping되지 않으면서 배경보다
충분히 큰지 먼저 짧은 샘플로 확인한다.

기기 간 offset은 두 재생음을 **공통 시간축**으로 녹음해야 의미가 있다. 권장 순서는 다음과 같다.

1. stereo recorder의 왼쪽 채널에 기준 기기, 오른쪽 채널에 대상 기기가 우세하게 들어오도록
   마이크를 배치한다.
2. 또는 같은 multichannel 녹음에서 분리한, 시작 sample이 동일한 두 mono WAV를 사용한다.
3. 서로 독립적으로 시작한 recorder의 두 파일을 그대로 비교하면 recorder 시작 차이까지
   `offsetMs`에 포함되므로 Phase 4의 기기 동기 오차 증거가 될 수 없다.

Bluetooth는 설계상 Phase 4 ±10 ms DoD 대상에서 제외한다. 캘리브레이션 후 내장/유선 출력을
같은 녹음 조건으로 반복 측정한다.

## Click interval, drift, and jitter

```bash
python3 scripts/audio_quality/click_intervals.py recording-30m.wav \
  --bpm 100 \
  --max-rms-jitter-ms 1 \
  --pretty
```

`--bpm`은 인접 click이 quarter-note인 경우에 사용한다. subdivision click이라면 실제 인접
간격을 `--expected-interval-ms`로 전달한다. 기대값을 생략하면 검출 간격의 median이 nominal
interval이 된다.

주요 JSON 필드는 다음과 같다.

- `intervals.rmsJitterMs`: 각 간격과 nominal interval 차이의 RMS.
- `intervals.standardDeviationMs`: 관측 간격 자체의 population standard deviation.
- `intervals.cumulativeDriftMs`: 첫 onset부터 마지막 onset까지의 실제 span과 nominal span 차이.
- `intervals.linearFitDriftPpm`: click index 대 onset 시각 선형 회귀의 interval drift.
- `qualityGate.passed`: `--max-rms-jitter-ms` 또는 `--max-abs-drift-ms`를 준 경우의 판정.

30분 청감 DoD에는 통계와 함께 원본 녹음의 dropout/누락 click도 확인한다. 검출 개수는 예상
click 개수와 반드시 대조한다.

## Inter-device offset

한 stereo 파일:

```bash
python3 scripts/audio_quality/device_offset.py synchronized-stereo.wav \
  --reference-channel 1 \
  --target-channel 2 \
  --max-offset-ms 10 \
  --pretty
```

시간축이 같은 두 mono 파일:

```bash
python3 scripts/audio_quality/device_offset.py reference.wav target.wav \
  --max-offset-ms 10 \
  --pretty
```

`offsetMs`가 양수이면 target click이 reference보다 늦게 도착한다. 음수이면 target이 먼저
도착한다. `peakCorrelation`, `secondPeakCorrelation`, `peakMargin`도 함께 확인한다. 주기적인
click track은 박 간격의 정수배에도 상관 peak가 생길 수 있으므로 `--max-lag-ms`는 알고 있는
최대 지연보다 약간 크게, 가능하면 click 간격의 절반보다 작게 정한다. 기본값은 250 ms다.

cross-correlation은 원본 전체 sample 배열 대신 검출한 onset을 impulse train으로 보고 수행한다.
`--bin-width-ms`는 lag 해상도, `--peak-window-ms`는 실제 녹음 jitter를 모으는 peak 폭이다.
기본값은 각각 0.25 ms와 5 ms다.

## Detection tuning

기본 검출은 첫 pass에서 전체 파일의 median magnitude와 peak를 스트리밍 집계하고, 두 번째
pass에서 자동 threshold, hysteresis, 50 ms refractory interval을 적용한다.

- click을 놓치면 파형을 확인한 뒤 `--threshold 0.1`처럼 normalized threshold를 명시한다.
- 한 click을 여러 번 세면 `--min-separation-ms`를 늘리되 실제 click 간격보다 작게 유지한다.
- stereo에서 위상 상쇄를 피하려면 채널 번호를 직접 고른다. `--channel mix`는 sample frame마다
  채널 magnitude의 최대값을 사용한다.
- 음악이나 말소리의 일반 정렬 도구가 아니라 반복 click 녹음의 품질 측정 도구다.

## Streaming and memory bounds

WAV sample은 기본 65,536 frame 블록으로 읽으며 전체 audio를 메모리에 올리지 않는다.
`click_intervals.py`가 보관하는 것은 고정 크기 level histogram과 onset 시각뿐이다.
`device_offset.py`도 두 onset 목록과 제한된 lag histogram만 보관한다.

기본 50 ms 최소 간격이면 30분 파일 한 채널의 onset은 최대 36,000개다. correlation histogram은
비정상적인 CLI 인자로 메모리가 커지지 않도록 최대 2,000,001 bin으로 제한된다. 테스트에는
헤더상 30분인 합성 WAV를 257-frame 블록으로 분석하고 Python 추적 peak가 8 MiB 미만인지
확인하는 회귀 케이스가 포함되어 있다.

요청한 block은 채널 수와 sample width를 고려해 실제 PCM block당 최대 8 MiB로 제한한다.
파일 길이와 `--min-separation-ms`로 계산한 이론상 onset 수가 250,000개를 넘는 설정도 scan 전에
거부하므로, 잘못된 인자가 전체 파일 크기에 가까운 Python 객체를 만들지 않는다.

## Verification

```bash
python3 -m unittest discover -s scripts/audio_quality/tests -v
python3 -m compileall -q scripts/audio_quality
uv run --project apps/server ruff check scripts/audio_quality
```
