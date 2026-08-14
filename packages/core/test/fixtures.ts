import type { TempoMap, TempoSection } from '../src/index.js';

export function section(
  startMeasure: number,
  endMeasure: number,
  overrides: Partial<TempoSection> = {},
): TempoSection {
  return {
    id: `section-${String(startMeasure)}`,
    startMeasure,
    endMeasure,
    timeSignature: { num: 4, denom: 4 },
    bpm: 120,
    beatUnit: 'quarter',
    ...overrides,
  };
}

export function tempoMap(overrides: Partial<TempoMap> = {}): TempoMap {
  return {
    id: 'tempo-map',
    repertoireItemId: 'repertoire-item',
    revision: 1,
    totalMeasures: 4,
    sections: [section(1, 4)],
    jumps: [],
    countIn: { measures: 1, useSectionMeter: true },
    ...overrides,
  };
}
