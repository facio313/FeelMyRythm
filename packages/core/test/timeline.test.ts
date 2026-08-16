import { describe, expect, it } from 'vitest';

import {
  TimelineExpansionError,
  buildCountIn,
  expandTimeline,
  locate,
  seekPoint,
} from '../src/index.js';
import { section, tempoMap } from './fixtures.js';

describe('expandTimeline', () => {
  it('expands the 1-25/26 tempo transition with first and second endings', () => {
    const map = tempoMap({
      revision: 7,
      totalMeasures: 30,
      sections: [
        section(1, 25, { id: 'slow', bpm: 100 }),
        section(26, 30, { id: 'fast', bpm: 130 }),
      ],
      jumps: [
        {
          type: 'repeat',
          startMeasure: 23,
          endMeasure: 30,
          times: 2,
          endings: [
            { measures: [29, 29], forPass: [1] },
            { measures: [30, 30], forPass: [2] },
          ],
        },
      ],
    });

    const timeline = expandTimeline(map);
    expect(expandTimeline(map)).toEqual(timeline);
    expect(timeline.tempoMapRevision).toBe(7);
    expect(timeline.entries.slice(-14).map((entry) => entry.measureNumber)).toEqual([
      23, 24, 25, 26, 27, 28, 29, 23, 24, 25, 26, 27, 28, 30,
    ]);

    const firstMeasure26 = timeline.entries.find(
      (entry) => entry.measureNumber === 26 && entry.pass === 1,
    );
    const secondMeasure26 = timeline.entries.find(
      (entry) => entry.measureNumber === 26 && entry.pass === 2,
    );
    expect(firstMeasure26?.sectionId).toBe('fast');
    expect(firstMeasure26?.startTimeSec).toBeCloseTo(60, 10);
    expect(secondMeasure26?.startTimeSec).toBeGreaterThan(firstMeasure26?.startTimeSec ?? 0);
  });

  it('uses two dotted-quarter beats and triplet subdivisions in 6/8', () => {
    const timeline = expandTimeline(
      tempoMap({
        totalMeasures: 1,
        sections: [
          section(1, 1, {
            bpm: 120,
            timeSignature: { num: 6, denom: 8 },
            beatUnit: 'dottedQuarter',
            accentPattern: [2, 0],
            subdivision: 3,
          }),
        ],
      }),
    );

    expect(timeline.totalDurationSec).toBeCloseTo(1, 12);
    expect(timeline.entries[0]?.beats).toHaveLength(6);
    const expectedTimes = [0, 1 / 6, 1 / 3, 1 / 2, 2 / 3, 5 / 6];
    timeline.entries[0]?.beats.forEach((beat, index) => {
      expect(beat.timeSec).toBeCloseTo(expectedTimes[index] ?? Number.NaN, 12);
    });
    expect(timeline.entries[0]?.beats.map((beat) => beat.isSubdivision)).toEqual([
      false,
      true,
      true,
      false,
      true,
      true,
    ]);
  });

  it('shortens the pickup and places it on the final nominal beat', () => {
    const timeline = expandTimeline(
      tempoMap({
        totalMeasures: 2,
        anacrusis: { beats: 1 },
        sections: [section(1, 2, { bpm: 60 })],
      }),
    );

    expect(timeline.entries[0]?.beats).toEqual([
      expect.objectContaining({ timeSec: 0, beatIndex: 3, accent: 0 }),
    ]);
    expect(timeline.entries[1]?.startTimeSec).toBeCloseTo(1, 12);
    expect(timeline.totalDurationSec).toBeCloseTo(5, 12);
  });

  it('integrates a continuous linear accelerando and produces shorter beats', () => {
    const timeline = expandTimeline(
      tempoMap({
        totalMeasures: 1,
        sections: [
          section(1, 1, {
            bpm: 60,
            tempoChange: { type: 'accel', targetBpm: 120 },
          }),
        ],
      }),
    );
    const beatTimes = timeline.entries[0]?.beats.map((beat) => beat.timeSec) ?? [];
    const intervals = [
      beatTimes[1]! - beatTimes[0]!,
      beatTimes[2]! - beatTimes[1]!,
      beatTimes[3]! - beatTimes[2]!,
      timeline.totalDurationSec - beatTimes[3]!,
    ];

    expect(timeline.totalDurationSec).toBeCloseTo(4 * Math.log(2), 12);
    expect(intervals[0]).toBeGreaterThan(intervals[1]!);
    expect(intervals[1]).toBeGreaterThan(intervals[2]!);
    expect(intervals[2]).toBeGreaterThan(intervals[3]!);
  });

  it('integrates a continuous linear ritardando and produces longer beats', () => {
    const timeline = expandTimeline(
      tempoMap({
        totalMeasures: 1,
        sections: [
          section(1, 1, {
            bpm: 120,
            tempoChange: { type: 'rit', targetBpm: 60 },
          }),
        ],
      }),
    );
    const beatTimes = timeline.entries[0]?.beats.map((beat) => beat.timeSec) ?? [];
    const intervals = [
      beatTimes[1]! - beatTimes[0]!,
      beatTimes[2]! - beatTimes[1]!,
      beatTimes[3]! - beatTimes[2]!,
      timeline.totalDurationSec - beatTimes[3]!,
    ];

    expect(intervals[0]).toBeLessThan(intervals[1]!);
    expect(intervals[1]).toBeLessThan(intervals[2]!);
    expect(intervals[2]).toBeLessThan(intervals[3]!);
  });

  it('expands nested repeats deterministically', () => {
    const timeline = expandTimeline(
      tempoMap({
        totalMeasures: 6,
        sections: [section(1, 6)],
        jumps: [
          { type: 'repeat', startMeasure: 1, endMeasure: 6, times: 2 },
          { type: 'repeat', startMeasure: 2, endMeasure: 3, times: 2 },
        ],
      }),
    );

    expect(timeline.entries.map((entry) => entry.measureNumber)).toEqual([
      1, 2, 3, 2, 3, 4, 5, 6, 1, 2, 3, 2, 3, 4, 5, 6,
    ]);
    expect(
      timeline.entries.filter((entry) => entry.measureNumber === 2).map((entry) => entry.pass),
    ).toEqual([1, 2, 3, 4]);
  });

  it('performs D.C. al Fine exactly once', () => {
    const timeline = expandTimeline(
      tempoMap({
        totalMeasures: 8,
        sections: [section(1, 8)],
        jumps: [{ type: 'dc', atMeasure: 8, alFine: 4 }],
      }),
    );

    expect(timeline.entries.map((entry) => entry.measureNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4,
    ]);
  });

  it('performs D.S. al Coda and skips to the coda target', () => {
    const timeline = expandTimeline(
      tempoMap({
        totalMeasures: 8,
        sections: [section(1, 8)],
        jumps: [
          { type: 'ds', atMeasure: 8, segnoMeasure: 3, alCoda: true },
          { type: 'coda', toCodaMeasure: 5, codaMeasure: 7 },
        ],
      }),
    );

    expect(timeline.entries.map((entry) => entry.measureNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 3, 4, 5, 7, 8,
    ]);
  });

  it('enforces the expansion guard before a repeat can exhaust memory', () => {
    const map = tempoMap({
      totalMeasures: 2,
      sections: [section(1, 2)],
      jumps: [{ type: 'repeat', startMeasure: 1, endMeasure: 2, times: 100 }],
    });

    expect(() => expandTimeline(map, { maxEntries: 10 })).toThrow(TimelineExpansionError);
  });
});

describe('timeline navigation helpers', () => {
  it('locates measure and click boundaries with binary search semantics', () => {
    const timeline = expandTimeline(
      tempoMap({
        totalMeasures: 2,
        sections: [section(1, 2, { bpm: 60, subdivision: 2 })],
      }),
    );

    expect(locate(timeline, -5)).toEqual({ entryIndex: 0, beatIndex: 0 });
    expect(locate(timeline, 0.5)).toEqual({ entryIndex: 0, beatIndex: 1 });
    expect(locate(timeline, 4)).toEqual({ entryIndex: 1, beatIndex: 0 });
    expect(locate(timeline, timeline.totalDurationSec)).toEqual({ entryIndex: 1, beatIndex: 7 });
  });

  it('matches a linear reference locator over dense boundary samples', () => {
    const timeline = expandTimeline(
      tempoMap({
        totalMeasures: 20,
        sections: [section(1, 20, { bpm: 137, subdivision: 4 })],
      }),
    );

    for (let elapsedSec = 0; elapsedSec <= timeline.totalDurationSec; elapsedSec += 0.03125) {
      const entryIndex = Math.max(
        0,
        timeline.entries.findLastIndex((entry) => entry.startTimeSec <= elapsedSec),
      );
      const entry = timeline.entries[entryIndex]!;
      const beatIndex = Math.max(
        0,
        entry.beats.findLastIndex((beat) => beat.timeSec <= elapsedSec),
      );
      expect(locate(timeline, elapsedSec)).toEqual({ entryIndex, beatIndex });
    }
  });

  it('seeks repeated measures by pass and defaults to the first visit', () => {
    const timeline = expandTimeline(
      tempoMap({ jumps: [{ type: 'repeat', startMeasure: 2, endMeasure: 3, times: 2 }] }),
    );

    expect(seekPoint(timeline, 2)).toBeCloseTo(2, 12);
    expect(seekPoint(timeline, 2, 2)).toBeCloseTo(6, 12);
    expect(() => seekPoint(timeline, 2, 3)).toThrow(RangeError);
  });

  it('builds two full count-in measures at the anchor section tempo', () => {
    const map = tempoMap({
      totalMeasures: 2,
      sections: [section(1, 1, { id: 'slow', bpm: 60 }), section(2, 2, { id: 'fast', bpm: 120 })],
      countIn: { measures: 2, useSectionMeter: true },
    });
    const timeline = expandTimeline(map);
    const anchor = seekPoint(timeline, 2);
    const countIn = buildCountIn(map, anchor);

    expect(anchor).toBeCloseTo(4, 12);
    expect(countIn).toHaveLength(8);
    expect(countIn[0]?.timeSec).toBeCloseTo(0, 12);
    expect(countIn[7]?.timeSec).toBeCloseTo(3.5, 12);
    expect(countIn.map((beat) => beat.accent)).toEqual([2, 0, 0, 0, 2, 0, 0, 0]);
    expect(() => buildCountIn(map, 1)).toThrow(RangeError);
  });

  it('counts compound meter in dotted-quarter beats, not denominator units', () => {
    const map = tempoMap({
      totalMeasures: 1,
      sections: [
        section(1, 1, {
          bpm: 120,
          timeSignature: { num: 6, denom: 8 },
          beatUnit: 'dottedQuarter',
          accentPattern: [2, 0],
        }),
      ],
      countIn: { measures: 2, useSectionMeter: true },
    });

    const countIn = buildCountIn(map, 0);
    expect(countIn).toHaveLength(4);
    expect(countIn.map((beat) => beat.timeSec)).toEqual([-2, -1.5, -1, -0.5]);
  });
});
