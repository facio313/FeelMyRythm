import { describe, expect, it } from 'vitest';

import {
  TempoMapValidationError,
  assertValidTempoMap,
  beatsPerMeasure,
  validateTempoMap,
  type TempoMap,
} from '../src/index.js';
import { section, tempoMap } from './fixtures.js';

describe('validateTempoMap', () => {
  it('returns structural issues for untrusted JSON instead of throwing', () => {
    const malformed = {
      id: 42,
      sections: [{ id: 'a', timeSignature: null }],
      jumps: [{ type: 'unknown' }],
    };

    expect(() => validateTempoMap(malformed)).not.toThrow();
    expect(validateTempoMap(malformed)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: 'id' }),
        expect.objectContaining({ path: 'repertoireItemId' }),
        expect.objectContaining({ path: 'sections[0].timeSignature' }),
        expect.objectContaining({ path: 'jumps[0].type' }),
        expect.objectContaining({ path: 'countIn' }),
      ]),
    });
  });

  it('accepts a fully covered deterministic map', () => {
    const map = tempoMap({
      totalMeasures: 8,
      anacrusis: { beats: 1 },
      sections: [
        section(1, 4),
        section(5, 8, {
          id: 'section-5',
          timeSignature: { num: 6, denom: 8 },
          beatUnit: 'dottedQuarter',
          accentPattern: [2, 0],
          subdivision: 3,
          tempoChange: { type: 'rit', targetBpm: 90 },
        }),
      ],
      jumps: [
        {
          type: 'repeat',
          startMeasure: 2,
          endMeasure: 7,
          times: 2,
          endings: [
            { measures: [6, 6], forPass: [1] },
            { measures: [7, 7], forPass: [2] },
          ],
        },
      ],
      countIn: { measures: 2, useSectionMeter: true },
    });

    expect(validateTempoMap(map)).toEqual({ valid: true, issues: [] });
    expect(() => assertValidTempoMap(map)).not.toThrow();
  });

  it('reports section gaps, overlaps, duplicates, and missing tail coverage', () => {
    const map = tempoMap({
      totalMeasures: 8,
      sections: [
        section(1, 2, { id: 'same' }),
        section(4, 5, { id: 'same' }),
        section(5, 7, { id: 'last' }),
      ],
    });

    const result = validateTempoMap(map);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['coverage', 'duplicate']),
    );
    expect(() => assertValidTempoMap(map)).toThrow(TempoMapValidationError);
  });

  it('rejects meters that cannot be divided by the beat unit', () => {
    const map = tempoMap({
      sections: [
        section(1, 4, {
          timeSignature: { num: 5, denom: 8 },
          beatUnit: 'dottedQuarter',
        }),
      ],
    });

    expect(validateTempoMap(map).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'meter', path: 'sections[0].beatUnit' }),
      ]),
    );
  });

  it('validates pickup length, tempo direction, accents, and subdivision', () => {
    const badSection = section(1, 4, {
      tempoChange: { type: 'accel', targetBpm: 100 },
      accentPattern: [2, 0],
      subdivision: 4,
    });
    const map: TempoMap = {
      ...tempoMap(),
      anacrusis: { beats: 4 },
      sections: [badSection],
    };
    const paths = validateTempoMap(map).issues.map((issue) => issue.path);

    expect(paths).toEqual(
      expect.arrayContaining([
        'anacrusis.beats',
        'sections[0].tempoChange',
        'sections[0].accentPattern',
      ]),
    );
  });

  it('accepts nested repeats and rejects crossing repeat ranges', () => {
    const nested = tempoMap({
      totalMeasures: 8,
      sections: [section(1, 8)],
      jumps: [
        { type: 'repeat', startMeasure: 1, endMeasure: 8, times: 2 },
        { type: 'repeat', startMeasure: 3, endMeasure: 4, times: 2 },
      ],
    });
    expect(validateTempoMap(nested).valid).toBe(true);

    const crossing = {
      ...nested,
      jumps: [
        { type: 'repeat' as const, startMeasure: 1, endMeasure: 5, times: 2 },
        { type: 'repeat' as const, startMeasure: 4, endMeasure: 8, times: 2 },
      ],
    };
    expect(validateTempoMap(crossing).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'ambiguous' })]),
    );
  });

  it('validates volta passes and requires a coda target for al Coda', () => {
    const map = tempoMap({
      jumps: [
        {
          type: 'repeat',
          startMeasure: 1,
          endMeasure: 4,
          times: 2,
          endings: [{ measures: [3, 4], forPass: [3] }],
        },
        { type: 'dc', atMeasure: 4, alCoda: true },
      ],
    });
    const result = validateTempoMap(map);

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'jumps[0].endings[0].forPass[0]' }),
        expect.objectContaining({ path: 'jumps', message: expect.stringContaining('coda') }),
      ]),
    );
  });
});

describe('beatsPerMeasure', () => {
  it('treats dotted quarters as the two primary beats of 6/8', () => {
    expect(
      beatsPerMeasure(
        section(1, 1, {
          timeSignature: { num: 6, denom: 8 },
          beatUnit: 'dottedQuarter',
        }),
      ),
    ).toBe(2);
  });
});
