/** 설계문서 §4.2의 템포맵 도메인 타입. 순수 데이터 — 플랫폼 의존성 없음. */

export type NoteValue =
  | 'whole'
  | 'half'
  | 'quarter'
  | 'dottedQuarter'
  | 'eighth'
  | 'dottedEighth'
  | 'sixteenth';

/** 온음표를 1로 봤을 때 각 음가의 길이 */
export const NOTE_VALUE_FRACTION: Record<NoteValue, number> = {
  whole: 1,
  half: 1 / 2,
  quarter: 1 / 4,
  dottedQuarter: 3 / 8,
  eighth: 1 / 8,
  dottedEighth: 3 / 16,
  sixteenth: 1 / 16,
};

export interface TimeSignature {
  num: number;
  denom: number;
}

/** 못갖춘마디: 첫 마디가 몇 박(beatUnit 단위)으로 시작하는지 */
export interface Anacrusis {
  beats: number;
}

export interface TempoSection {
  id: string;
  label?: string;
  /** 1-base, 포함 */
  startMeasure: number;
  /** 포함 */
  endMeasure: number;
  timeSignature: TimeSignature;
  bpm: number;
  /** 무엇을 1박으로 셀지 (6/8은 보통 dottedQuarter) */
  beatUnit: NoteValue;
  /** 구간 내 선형 템포 변화 (rit./accel.) */
  tempoChange?: { type: 'rit' | 'accel'; targetBpm: number };
  /** 박별 강세 0~2. 생략 시 첫박 2, 나머지 1 */
  accentPattern?: number[];
  /** 박 분할 클릭 (2=8분, 3=셋잇단...) */
  subdivision?: 1 | 2 | 3 | 4;
}

export interface RepeatEnding {
  /** [시작마디, 끝마디] (포함) */
  measures: [number, number];
  /** 이 엔딩을 연주하는 패스 번호 (1-base) */
  forPass: number[];
}

export type JumpDirective =
  | {
      type: 'repeat';
      startMeasure: number;
      endMeasure: number;
      /** 총 연주 횟수 (2 = 한 번 반복) */
      times: number;
      endings?: RepeatEnding[];
    }
  | { type: 'dc'; atMeasure: number; alFine?: number; alCoda?: boolean }
  | { type: 'ds'; atMeasure: number; segnoMeasure: number; alFine?: number; alCoda?: boolean }
  | { type: 'coda'; toCodaMeasure: number; codaMeasure: number };

export interface CountInPolicy {
  measures: 1 | 2;
  useSectionMeter: true;
}

export interface TempoMap {
  id: string;
  repertoireItemId?: string;
  title?: string;
  revision: number;
  totalMeasures: number;
  anacrusis?: Anacrusis;
  sections: TempoSection[];
  jumps: JumpDirective[];
  countIn: CountInPolicy;
}

// ---------- 전개(컴파일) 결과 ----------

export interface TimelineBeat {
  /** 타임라인 t=0 기준 절대 오프셋 (초) */
  timeSec: number;
  accent: 0 | 1 | 2;
  isSubdivision: boolean;
}

export interface TimelineMeasure {
  /** 악보상 마디 번호 */
  measureNumber: number;
  /** 몇 번째로 지나가는가 (1st/2nd 엔딩 구분) */
  pass: number;
  sectionId: string;
  startTimeSec: number;
  durationSec: number;
  beats: TimelineBeat[];
}

export interface PerformanceTimeline {
  tempoMapRevision: number;
  entries: TimelineMeasure[];
  totalDurationSec: number;
}

/** 예비박: 앵커(본 재생 시작) 기준 음수 오프셋 */
export interface CountInBeat {
  timeSec: number;
  accent: 0 | 1 | 2;
  /** 남은 박 수 표시용 (4·3·2·1 카운트다운) */
  countdown: number;
}

/** 기본값 채운 새 템포맵 */
export function createDefaultTempoMap(partial?: Partial<TempoMap>): TempoMap {
  return {
    id: crypto.randomUUID?.() ?? String(Math.random()).slice(2),
    revision: 0,
    totalMeasures: 32,
    sections: [
      {
        id: 's1',
        startMeasure: 1,
        endMeasure: 32,
        timeSignature: { num: 4, denom: 4 },
        bpm: 100,
        beatUnit: 'quarter',
      },
    ],
    jumps: [],
    countIn: { measures: 1, useSectionMeter: true },
    ...partial,
  };
}
