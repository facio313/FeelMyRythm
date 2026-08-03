import { describe, expect, it } from 'vitest';
import {
  buildCountIn,
  buildPerformanceOrder,
  createDefaultTempoMap,
  expandTimeline,
  locate,
  seekPoint,
  validateTempoMap,
  type TempoMap,
} from '../src/index';

function map(partial: Partial<TempoMap>): TempoMap {
  return createDefaultTempoMap(partial);
}

describe('expandTimeline: 기본', () => {
  it('4/4 ♩=100, 4마디 → 16박, 총 9.6초', () => {
    const tl = expandTimeline(
      map({
        totalMeasures: 4,
        sections: [
          { id: 's1', startMeasure: 1, endMeasure: 4, timeSignature: { num: 4, denom: 4 }, bpm: 100, beatUnit: 'quarter' },
        ],
      }),
    );
    expect(tl.entries).toHaveLength(4);
    expect(tl.entries.flatMap((e) => e.beats)).toHaveLength(16);
    expect(tl.totalDurationSec).toBeCloseTo(4 * 4 * 0.6, 9);
    expect(tl.entries[1]!.startTimeSec).toBeCloseTo(2.4, 9);
    expect(tl.entries[0]!.beats[0]!.accent).toBe(2); // 다운비트
    expect(tl.entries[0]!.beats[1]!.accent).toBe(1);
  });

  it('6/8 ♪.=60 → 마디당 2박, 마디 길이 2초', () => {
    const tl = expandTimeline(
      map({
        totalMeasures: 2,
        sections: [
          { id: 's1', startMeasure: 1, endMeasure: 2, timeSignature: { num: 6, denom: 8 }, bpm: 60, beatUnit: 'dottedQuarter' },
        ],
      }),
    );
    expect(tl.entries[0]!.beats).toHaveLength(2);
    expect(tl.entries[0]!.durationSec).toBeCloseTo(2, 9);
  });

  it('subdivision=2 → 박 사이 분할 클릭 삽입', () => {
    const tl = expandTimeline(
      map({
        totalMeasures: 1,
        sections: [
          { id: 's1', startMeasure: 1, endMeasure: 1, timeSignature: { num: 4, denom: 4 }, bpm: 120, beatUnit: 'quarter', subdivision: 2 },
        ],
      }),
    );
    expect(tl.entries[0]!.beats).toHaveLength(8);
    expect(tl.entries[0]!.beats.filter((b) => b.isSubdivision)).toHaveLength(4);
  });

  it('못갖춘마디: 첫 마디가 1박', () => {
    const tl = expandTimeline(
      map({
        totalMeasures: 2,
        anacrusis: { beats: 1 },
        sections: [
          { id: 's1', startMeasure: 1, endMeasure: 2, timeSignature: { num: 4, denom: 4 }, bpm: 100, beatUnit: 'quarter' },
        ],
      }),
    );
    expect(tl.entries[0]!.beats).toHaveLength(1);
    expect(tl.entries[1]!.beats).toHaveLength(4);
  });
});

describe('사용자 시나리오: 템포 변화 + 도돌이/엔딩', () => {
  // "♩=100 4/4로 시작, 26마디에서 ♩=130, 1~8마디 반복(1st: 7마디 / 2nd: 8마디)"
  const scenario = map({
    totalMeasures: 32,
    sections: [
      { id: 'a', startMeasure: 1, endMeasure: 25, timeSignature: { num: 4, denom: 4 }, bpm: 100, beatUnit: 'quarter' },
      { id: 'b', startMeasure: 26, endMeasure: 32, timeSignature: { num: 4, denom: 4 }, bpm: 130, beatUnit: 'quarter' },
    ],
    jumps: [
      {
        type: 'repeat',
        startMeasure: 1,
        endMeasure: 8,
        times: 2,
        endings: [
          { measures: [7, 7], forPass: [1] },
          { measures: [8, 8], forPass: [2] },
        ],
      },
    ],
  });

  it('연주 순서: 1..7, 1..6, 8, 9..32', () => {
    const order = buildPerformanceOrder(scenario).map((o) => o.measure);
    expect(order.slice(0, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(order.slice(7, 14)).toEqual([1, 2, 3, 4, 5, 6, 8]);
    expect(order[14]).toBe(9);
    expect(order[order.length - 1]).toBe(32);
    expect(order).toHaveLength(7 + 7 + 24);
  });

  it('26마디부터는 ♩=130 (박 간격 60/130초)', () => {
    const tl = expandTimeline(scenario);
    const m26 = tl.entries.find((e) => e.measureNumber === 26)!;
    const gap = m26.beats[1]!.timeSec - m26.beats[0]!.timeSec;
    expect(gap).toBeCloseTo(60 / 130, 9);
  });

  it('두 번째 패스의 pass 번호가 2', () => {
    const tl = expandTimeline(scenario);
    const passes = tl.entries.filter((e) => e.measureNumber === 3).map((e) => e.pass);
    expect(passes).toEqual([1, 2]);
    // seekPoint로 특정 패스 시작점 조회
    expect(seekPoint(tl, 3, 2)).toBeGreaterThan(seekPoint(tl, 3, 1));
  });
});

describe('D.C. / D.S. / Coda', () => {
  it('D.C. al Fine: 끝까지 연주 후 처음부터 Fine까지', () => {
    const m = map({
      totalMeasures: 8,
      sections: [
        { id: 's1', startMeasure: 1, endMeasure: 8, timeSignature: { num: 4, denom: 4 }, bpm: 100, beatUnit: 'quarter' },
      ],
      jumps: [{ type: 'dc', atMeasure: 8, alFine: 4 }],
    });
    const order = buildPerformanceOrder(m).map((o) => o.measure);
    expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4]);
  });

  it('D.S. al Coda: 세뇨로 복귀 후 To Coda에서 Coda로 점프', () => {
    const m = map({
      totalMeasures: 10,
      sections: [
        { id: 's1', startMeasure: 1, endMeasure: 10, timeSignature: { num: 4, denom: 4 }, bpm: 100, beatUnit: 'quarter' },
      ],
      jumps: [
        { type: 'ds', atMeasure: 8, segnoMeasure: 3, alCoda: true },
        { type: 'coda', toCodaMeasure: 5, codaMeasure: 9 },
      ],
    });
    const order = buildPerformanceOrder(m).map((o) => o.measure);
    expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 3, 4, 5, 9, 10]);
  });

  it('무한 루프는 명확한 에러로 검출', () => {
    const m = map({
      totalMeasures: 6,
      sections: [
        { id: 's1', startMeasure: 1, endMeasure: 6, timeSignature: { num: 4, denom: 4 }, bpm: 100, beatUnit: 'quarter' },
      ],
      jumps: [
        { type: 'dc', atMeasure: 6, alCoda: true },
        { type: 'coda', toCodaMeasure: 5, codaMeasure: 2 }, // 2→5→2→5... 루프
      ],
    });
    expect(() => buildPerformanceOrder(m)).toThrow(/무한 루프/);
  });
});

describe('locate / countIn / validate', () => {
  const simple = map({
    totalMeasures: 4,
    sections: [
      { id: 's1', startMeasure: 1, endMeasure: 4, timeSignature: { num: 4, denom: 4 }, bpm: 100, beatUnit: 'quarter' },
    ],
  });

  it('locate: 경과 시간으로 마디·박 찾기', () => {
    const tl = expandTimeline(simple);
    expect(locate(tl, 0)).toEqual({ entryIndex: 0, beatIndex: 0 });
    expect(locate(tl, 2.4)).toEqual({ entryIndex: 1, beatIndex: 0 });
    expect(locate(tl, 3.05)).toEqual({ entryIndex: 1, beatIndex: 1 });
    expect(locate(tl, -1)).toBeNull();
    expect(locate(tl, 999)).toBeNull();
  });

  it('예비박: 1마디 4/4@100 → 4박, 음수 오프셋, 카운트다운 4..1', () => {
    const beats = buildCountIn(simple, 1);
    expect(beats).toHaveLength(4);
    expect(beats[0]!.timeSec).toBeCloseTo(-2.4, 9);
    expect(beats.map((b) => b.countdown)).toEqual([4, 3, 2, 1]);
    expect(beats[0]!.accent).toBe(2);
  });

  it('validate: 구간 빈틈 검출', () => {
    const bad = map({
      totalMeasures: 10,
      sections: [
        { id: 'a', startMeasure: 1, endMeasure: 4, timeSignature: { num: 4, denom: 4 }, bpm: 100, beatUnit: 'quarter' },
        { id: 'b', startMeasure: 6, endMeasure: 10, timeSignature: { num: 4, denom: 4 }, bpm: 100, beatUnit: 'quarter' },
      ],
    });
    expect(validateTempoMap(bad).some((i) => i.includes('빈틈'))).toBe(true);
    expect(() => expandTimeline(bad)).toThrow(/검증 실패/);
  });
});
