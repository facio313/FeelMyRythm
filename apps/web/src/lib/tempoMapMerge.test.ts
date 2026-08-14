import { describe, expect, it } from 'vitest';
import type { TempoMap } from '@feelmyrythm/core';
import { rebaseTempoMapDraft, resolveTempoMaps } from './tempoMapMerge';

function fixture(revision: number, bpm = 100): TempoMap {
  return {
    id: 'map-1',
    repertoireItemId: 'repertoire-1',
    revision,
    totalMeasures: 8,
    sections: [
      {
        id: 'section-1',
        startMeasure: 1,
        endMeasure: 8,
        timeSignature: { num: 4, denom: 4 },
        bpm,
        beatUnit: 'quarter',
        accentPattern: [2, 1, 1, 1],
        subdivision: 1,
      },
    ],
    jumps: [],
    countIn: { measures: 1, useSectionMeter: true },
  };
}

describe('TempoMap revision reconciliation', () => {
  it('keeps the higher revision regardless of cache order', () => {
    expect(resolveTempoMaps(fixture(4), fixture(5)).source).toBe('server');
    expect(resolveTempoMaps(fixture(6), fixture(5)).source).toBe('local');
  });

  it('surfaces divergent contents at an equal revision', () => {
    const result = resolveTempoMaps(fixture(5, 90), fixture(5, 120));
    expect(result.source).toBe('server');
    expect(result.conflict).toBe(true);
    expect(result.map.sections[0]?.bpm).toBe(120);
  });

  it('rebases a local draft without replacing its musical data', () => {
    const latest = { ...fixture(8, 110), id: 'server-map' };
    const rebased = rebaseTempoMapDraft(fixture(5, 132), latest);
    expect(rebased).toMatchObject({ id: 'server-map', revision: 8 });
    expect(rebased.sections[0]?.bpm).toBe(132);
  });

  it('rejects maps from different repertoire items', () => {
    const other = { ...fixture(2), repertoireItemId: 'other' };
    expect(() => resolveTempoMaps(fixture(2), other)).toThrow(/서로 다른/);
  });
});
