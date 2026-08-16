import type { TempoMap } from '@feelmyrythm/core';

export const createDefaultTempoMap = (repertoireItemId = 'local', revision = 1): TempoMap => ({
  id: crypto.randomUUID(),
  repertoireItemId,
  revision,
  totalMeasures: 64,
  sections: [
    {
      id: crypto.randomUUID(),
      label: 'A',
      startMeasure: 1,
      endMeasure: 64,
      timeSignature: { num: 4, denom: 4 },
      bpm: 100,
      beatUnit: 'quarter',
      accentPattern: [2, 1, 1, 1],
      subdivision: 1,
    },
  ],
  jumps: [],
  countIn: { measures: 1, useSectionMeter: true },
});
