import { describe, expect, it } from 'vitest';
import {
  buildCountIn,
  expandTimeline,
  seekPoint,
  tempoAtMeasureStart,
  validateTempoMap,
} from '../src/index.js';
import { section, tempoMap } from './fixtures.js';

describe('measure expressions', () => {
  it('places independent expressions inside one unchanged section', () => {
    const map = tempoMap({
      totalMeasures: 10,
      sections: [section(1, 10, { bpm: 120 })],
      measureExpressions: [
        { measure: 8, breath: { durationSec: 1.5, countIn: true } },
        { measure: 3, tempoChange: { type: 'rit', targetBpm: 60, endMeasure: 4 } },
        { measure: 7, fermata: { beat: 2, extraBeats: 2 } },
        { measure: 5, tempoChange: { type: 'aTempo', targetBpm: 120 } },
      ],
    });
    const original = JSON.stringify(map);
    const timeline = expandTimeline(map);
    expect(JSON.stringify(map)).toBe(original);
    expect(map.sections).toHaveLength(1);
    expect(timeline.entries.every((entry) => entry.sectionId === map.sections[0]!.id)).toBe(true);
    expect(tempoAtMeasureStart(map, 3)).toBe(120);
    expect(tempoAtMeasureStart(map, 4)).toBe(90);
    expect(tempoAtMeasureStart(map, 5)).toBe(120);
    expect(seekPoint(timeline, 5)).toBeCloseTo(4 + 8 * Math.log(2), 10);
    const held = timeline.entries[6]!;
    held.beats.forEach((beat, index) => {
      expect(beat.timeSec - held.startTimeSec).toBeCloseTo([0, 0.5, 2, 2.5][index]!, 10);
    });
    expect(held.fermata?.startTimeSec).toBeCloseTo(held.startTimeSec + 0.5, 10);
    expect(held.fermata?.endTimeSec).toBeCloseTo(held.startTimeSec + 2, 10);
    expect(timeline.entries[7]!.resumeCountIn?.map((beat) => beat.countdown)).toEqual([4, 3, 2, 1]);
    expect(timeline.totalDurationSec).toBeCloseTo(20 - 4 + 8 * Math.log(2) + 1 + 1.5 + 2, 10);
    const cues = buildCountIn(map, seekPoint(timeline, 4));
    expect(cues[1]!.timeSec - cues[0]!.timeSec).toBeCloseTo(60 / 90, 10);
  });

  it('carries a spanning ramp across section boundaries and resets only at a later section', () => {
    const map = tempoMap({
      totalMeasures: 6,
      sections: [
        section(1, 2, { id: 'a', bpm: 120 }),
        section(3, 4, { id: 'b', bpm: 80 }),
        section(5, 6, { id: 'c', bpm: 100 }),
      ],
      measureExpressions: [
        { measure: 2, tempoChange: { type: 'rit', targetBpm: 60, endMeasure: 3 } },
      ],
    });
    expect([1, 2, 3, 4, 5, 6].map((measure) => tempoAtMeasureStart(map, measure))).toEqual([
      120, 120, 90, 60, 100, 100,
    ]);
    expect(
      expandTimeline(map).entries[3]!.beats[1]!.timeSec -
        expandTimeline(map).entries[3]!.beats[0]!.timeSec,
    ).toBeCloseTo(1);
    const prior = map.measureExpressions![0]!;
    expect(
      validateTempoMap({
        ...map,
        measureExpressions: [prior, { measure: 4, tempoChange: { type: 'accel', targetBpm: 70 } }],
      }).valid,
    ).toBe(true);
    expect(
      validateTempoMap({
        ...map,
        measureExpressions: [prior, { measure: 4, tempoChange: { type: 'rit', targetBpm: 70 } }],
      }).valid,
    ).toBe(false);
  });

  it('uses the effective tempo within legacy ramps when validating a new instruction', () => {
    const map = tempoMap({
      totalMeasures: 6,
      sections: [section(1, 6, { bpm: 120, tempoChange: { type: 'rit', targetBpm: 60 } })],
    });
    expect(tempoAtMeasureStart(map, 4)).toBe(90);
    expect(
      validateTempoMap({
        ...map,
        measureExpressions: [{ measure: 4, tempoChange: { type: 'accel', targetBpm: 100 } }],
      }).valid,
    ).toBe(true);
    expect(
      validateTempoMap({
        ...map,
        measureExpressions: [{ measure: 4, tempoChange: { type: 'rit', targetBpm: 100 } }],
      }).valid,
    ).toBe(false);
  });

  it.each([
    { bpm: 107, totalMeasures: 11, measure: 10, expectedBpm: 44, type: 'accel' as const },
    { bpm: 120, totalMeasures: 10, measure: 8, expectedBpm: 57, type: 'rit' as const },
  ])('rejects an equal target at the effective ramp boundary: %j', (example) => {
    const map = tempoMap({
      totalMeasures: example.totalMeasures,
      sections: [
        section(1, example.totalMeasures, {
          bpm: example.bpm,
          tempoChange: { type: 'rit', targetBpm: 30 },
        }),
      ],
    });
    expect(tempoAtMeasureStart(map, example.measure)).toBe(example.expectedBpm);
    const result = validateTempoMap({
      ...map,
      measureExpressions: [
        {
          measure: example.measure,
          tempoChange: { type: example.type, targetBpm: example.expectedBpm },
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'tempo', path: 'measureExpressions[0].tempoChange' }),
    );
  });

  it('keeps selected beat holds, pauses and silent reentry deterministic through repeats', () => {
    const map = tempoMap({
      totalMeasures: 2,
      sections: [
        section(1, 2, {
          bpm: 120,
          fermata: { extraBeats: 2 },
          breath: { durationSec: 3, countIn: true },
        }),
      ],
      measureExpressions: [
        {
          measure: 1,
          fermata: { beat: 2, extraBeats: 1 },
          breath: { durationSec: 1, countIn: false },
        },
        { measure: 2 },
      ],
      jumps: [{ type: 'repeat', startMeasure: 1, endMeasure: 2, times: 2 }],
    });
    const timeline = expandTimeline(map);
    expect(timeline.entries.map((entry) => entry.startTimeSec)).toEqual([0, 3.5, 5.5, 9]);
    expect(timeline.totalDurationSec).toBe(11);
    expect(
      timeline.entries
        .filter((entry) => entry.measureNumber === 2)
        .every((entry) => !entry.fermata && !entry.breath),
    ).toBe(true);
    expect(timeline.entries.every((entry) => entry.resumeCountIn === undefined)).toBe(true);
    expect(seekPoint(timeline, 1, 2)).toBe(5.5);
  });

  it('uses pickup beat positions and does not split a held beat into subdivision clicks', () => {
    const map = tempoMap({
      totalMeasures: 2,
      anacrusis: { beats: 1 },
      sections: [section(1, 2, { bpm: 120, subdivision: 4 })],
      measureExpressions: [
        {
          measure: 1,
          tempoChange: { type: 'rit', targetBpm: 60, endMeasure: 2 },
          fermata: { beat: 4, extraBeats: 1 },
        },
      ],
    });
    const timeline = expandTimeline(map);
    expect(timeline.entries[0]!.beats).toHaveLength(1);
    expect(timeline.entries[0]!.beats[0]!.beatIndex).toBe(3);
    expect(tempoAtMeasureStart(map, 2)).toBe(108);
    expect(timeline.entries[1]!.startTimeSec).toBeCloseTo(2 * 5 * Math.log(120 / 108), 10);
    expect(
      validateTempoMap({
        ...map,
        measureExpressions: [{ measure: 1, fermata: { beat: 1, extraBeats: 1 } }],
      }).valid,
    ).toBe(false);
  });

  it.each(
    [
      [{ measure: 0 }],
      [{ measure: 11 }],
      [{ measure: 2 }, { measure: 2 }],
      [{ measure: 2, tempoChange: { type: 'rit', targetBpm: 60, endMeasure: 1 } }],
      [{ measure: 2, tempoChange: { type: 'rit', targetBpm: 60, endMeasure: 11 } }],
      [{ measure: 2, tempoChange: { type: 'aTempo', targetBpm: 120, endMeasure: 2 } }],
      [
        { measure: 2, tempoChange: { type: 'rit', targetBpm: 60, endMeasure: 4 } },
        { measure: 4, tempoChange: { type: 'aTempo', targetBpm: 120 } },
      ],
      [{ measure: 3, fermata: { extraBeats: 1, beat: 0 } }],
      [{ measure: 3, fermata: { extraBeats: 1, beat: 5 } }],
      [{ measure: 3, fermata: { extraBeats: 1, beat: 1.5 } }],
      [{ measure: '3' }],
      [{ measure: 3, breath: { durationSec: 1, countIn: 'false' } }],
    ].map((measureExpressions) => ({ measureExpressions })),
  )('rejects ambiguous or invalid measure instructions: %j', ({ measureExpressions }) => {
    const map = tempoMap({ totalMeasures: 10, sections: [section(1, 10)] });
    expect(() => validateTempoMap({ ...map, measureExpressions })).not.toThrow();
    expect(validateTempoMap({ ...map, measureExpressions }).valid).toBe(false);
  });
});
