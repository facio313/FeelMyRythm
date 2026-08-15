import { describe, expect, it } from 'vitest';

import {
  isUsableSystemRect,
  keyboardMeasureTarget,
  mappedMeasuresForKeyboard,
  percentRectToNormalized,
  rectFromDrag,
  regionContainsPoint,
  regionsFromSystem,
  toggleBoundary,
} from './scoreGeometry';

describe('score mapping geometry', () => {
  it('builds a normalized system rect from any drag direction', () => {
    expect(rectFromDrag({ x: 0.75, y: 0.5 }, { x: 0.25, y: 0.25 })).toEqual({
      x: 0.25,
      y: 0.25,
      w: 0.5,
      h: 0.25,
    });
    expect(isUsableSystemRect({ x: 0, y: 0, w: 0.02, h: 0.1 })).toBe(false);
    expect(isUsableSystemRect({ x: 0, y: 0, w: 0.2, h: 0.1 })).toBe(true);
  });

  it('toggles nearby boundaries and ignores clicks on the system edge', () => {
    expect(toggleBoundary([], 0.01)).toEqual([]);
    expect(toggleBoundary([0.25], 0.6)).toEqual([0.25, 0.6]);
    expect(toggleBoundary([0.25, 0.6], 0.255)).toEqual([0.6]);
  });

  it('hits a mapped region only on its page and inside the rect', () => {
    const region = { page: 2, rect: { x: 0.1, y: 0.2, w: 0.4, h: 0.1 } };
    expect(regionContainsPoint(region, 2, { x: 0.3, y: 0.25 })).toBe(true);
    expect(regionContainsPoint(region, 1, { x: 0.3, y: 0.25 })).toBe(false);
    expect(regionContainsPoint(region, 2, { x: 0.6, y: 0.25 })).toBe(false);
  });

  it('moves among canonical measures with arrows, Home, and End', () => {
    const measures = mappedMeasuresForKeyboard(
      [
        { id: 'a', page: 1, measureNumber: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.2 } },
        { id: 'b', page: 1, measureNumber: 2, rect: { x: 0.5, y: 0, w: 0.5, h: 0.2 } },
        { id: 'c', page: 2, measureNumber: 3, rect: { x: 0, y: 0, w: 1, h: 0.2 } },
      ],
      10,
    );
    expect(measures.map((entry) => entry.canonical)).toEqual([11, 12, 13]);
    expect(keyboardMeasureTarget(measures, 12, 'Home')?.canonical).toBe(11);
    expect(keyboardMeasureTarget(measures, 12, 'End')?.canonical).toBe(13);
    expect(keyboardMeasureTarget(measures, 12, 'ArrowLeft')?.canonical).toBe(11);
    expect(keyboardMeasureTarget(measures, 12, 'ArrowRight')?.page).toBe(2);
  });

  it('splits a system rect by boundary cuts into sequential measures', () => {
    expect(percentRectToNormalized({ x: 10, y: 20, w: 40, h: 10 })).toEqual({
      x: 0.1,
      y: 0.2,
      w: 0.4,
      h: 0.1,
    });
    expect(percentRectToNormalized({ x: 10, y: 20, w: 100, h: 10 })).toBeUndefined();
    const regions = regionsFromSystem(
      { x: 0.1, y: 0.2, w: 0.8, h: 0.1 },
      [0.5],
      2,
      4,
      () => 'fixed-id',
    );
    expect(regions).toEqual([
      {
        id: 'fixed-id',
        page: 2,
        measureNumber: 4,
        rect: { x: 0.1, y: 0.2, w: 0.4, h: 0.1 },
      },
      {
        id: 'fixed-id',
        page: 2,
        measureNumber: 5,
        rect: { x: 0.5, y: 0.2, w: 0.4, h: 0.1 },
      },
    ]);
  });
});
