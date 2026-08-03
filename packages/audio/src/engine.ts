/** 플랫폼 어댑터 인터페이스 (설계문서 §5.1). 모바일 지연 문제 시 이 구현체만 교체한다. */

export type ClickKind = 'downbeat' | 'beat' | 'sub' | 'countIn';

export interface AudioEngine {
  /** 절대 시각(오디오 클럭 기준, 초)에 클릭음 예약 */
  scheduleClick(atAudioTime: number, kind: ClickKind): void;
  /** 예약됐지만 아직 울리지 않은 클릭 전부 취소 */
  cancelScheduled(): void;
  /** 오디오 클럭 현재 시각 (초) */
  now(): number;
  /** 추정 출력 지연 (초) */
  outputLatencySec(): number;
  /** 사용자 제스처 안에서 호출 필요 (AudioContext 정책) */
  start(): Promise<void>;
  stop(): void;
  setVolume(v: number): void;
}
