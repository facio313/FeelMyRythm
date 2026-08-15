import { describe, expect, it } from 'vitest';

import {
  currentMeasurePracticeMarkers,
  editablePageAnnotations,
  projectedMeasureAnnotations,
  projectedPracticeMarkers,
  visibleOmrPageRegions,
  visiblePageAnnotations,
  visiblePageRegions,
} from './scoreVisibility';
import type { MeasureRegion } from './types';

const region: MeasureRegion = {
  id: 'r1',
  page: 1,
  measureNumber: 2,
  rect: { x: 0.1, y: 0.2, w: 0.4, h: 0.1 },
};

describe('score overlay visibility', () => {
  it('keeps mapped regions on the selected score page only', () => {
    expect(
      visiblePageRegions(
        { scoreId: 'score-a', measureNumberOffset: 0, regions: [region], updatedAt: '' },
        'score-a',
        1,
      ),
    ).toEqual([region]);
    expect(
      visiblePageRegions(
        { scoreId: 'score-a', measureNumberOffset: 0, regions: [region], updatedAt: '' },
        'score-b',
        1,
      ),
    ).toEqual([]);
  });

  it('projects measure-anchored notes onto the matching region and keeps page notes local', () => {
    const pageNote = {
      id: 'a1',
      scoreId: 'score-a',
      scope: 'project' as const,
      kind: 'text' as const,
      page: 1,
      payload: { x: 0.2, y: 0.3, text: 'page' },
      updatedAt: '',
    };
    const measureNote = {
      id: 'a2',
      scoreId: 'score-b',
      scope: 'project' as const,
      kind: 'stamp' as const,
      page: 9,
      measureNumber: 12,
      payload: { text: 'mf', anchorType: 'measure' },
      updatedAt: '',
    };
    expect(visiblePageAnnotations([pageNote, measureNote], 'score-a', 1)).toEqual([pageNote]);
    const projected = projectedMeasureAnnotations([measureNote], [region], 10);
    expect(projected).toHaveLength(1);
    expect(projected[0]?.annotation).toBe(measureNote);
    expect(projected[0]?.x).toBeCloseTo(0.3);
    expect(projected[0]?.y).toBeCloseTo(0.25);
    expect(editablePageAnnotations([pageNote], [{ annotation: measureNote }], 'score-a')).toEqual([
      pageNote,
    ]);
  });

  it('shows OMR drafts only while preview is on for the current score', () => {
    const draft = {
      id: 'omr-1',
      scoreId: 'score-a',
      requestedById: 'user',
      expectedMeasureMapRevision: 1,
      status: 'succeeded' as const,
      regions: [{ page: 1, measureNumber: 2, rect: region.rect }],
      warnings: [],
      error: null,
      createdAt: '',
      updatedAt: '',
    };
    expect(visibleOmrPageRegions(draft, 'score-a', 1, true)).toHaveLength(1);
    expect(visibleOmrPageRegions(draft, 'score-a', 1, false)).toEqual([]);
  });

  it('places practice markers on page coordinates or the matching measure', () => {
    const pageMarker = {
      logId: 'log-1',
      authorName: 'A',
      content: 'bowing',
      scoreId: 'score-a',
      page: 1,
      x: 0.8,
      y: 0.1,
    };
    const measureMarker = {
      logId: 'log-2',
      authorName: 'B',
      content: 'breath',
      measureNumber: 12,
    };
    const projected = projectedPracticeMarkers(
      [pageMarker, measureMarker],
      [region],
      'score-a',
      1,
      10,
    );
    expect(projected).toHaveLength(2);
    expect(projected[0]).toEqual({ marker: pageMarker, x: 0.8, y: 0.1 });
    expect(projected[1]?.marker).toBe(measureMarker);
    expect(projected[1]?.x).toBeCloseTo(0.488);
    expect(projected[1]?.y).toBeCloseTo(0.214);
    expect(currentMeasurePracticeMarkers([pageMarker, measureMarker], 12)).toEqual([measureMarker]);
  });
});
