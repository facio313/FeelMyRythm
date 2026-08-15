import { canonicalMeasureNumber } from '../../lib/scoreApi';
import type { MeasureRegion, NormalizedRect } from './types';

export function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function pointerPosition(event: {
  currentTarget: { getBoundingClientRect(): DOMRect };
  clientX: number;
  clientY: number;
}): { x: number; y: number } {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: clampUnit((event.clientX - bounds.left) / bounds.width),
    y: clampUnit((event.clientY - bounds.top) / bounds.height),
  };
}

export function rectFromDrag(
  start: { x: number; y: number },
  point: { x: number; y: number },
): NormalizedRect {
  return {
    x: Math.min(point.x, start.x),
    y: Math.min(point.y, start.y),
    w: Math.abs(point.x - start.x),
    h: Math.abs(point.y - start.y),
  };
}

export function isUsableSystemRect(rect: NormalizedRect): boolean {
  return rect.w > 0.03 && rect.h > 0.02;
}

export function toggleBoundary(current: readonly number[], relative: number): number[] {
  if (relative <= 0.02 || relative >= 0.98) return [...current];
  const nearby = current.findIndex((boundary) => Math.abs(boundary - relative) < 0.015);
  if (nearby >= 0) return current.filter((_, index) => index !== nearby);
  return [...current, relative].sort((left, right) => left - right);
}

export function regionContainsPoint(
  region: Pick<MeasureRegion, 'page' | 'rect'>,
  page: number,
  point: { x: number; y: number },
): boolean {
  return (
    region.page === page &&
    point.x >= region.rect.x &&
    point.x <= region.rect.x + region.rect.w &&
    point.y >= region.rect.y &&
    point.y <= region.rect.y + region.rect.h
  );
}

export function mappedMeasuresForKeyboard(
  regions: readonly MeasureRegion[],
  measureNumberOffset: number,
): Array<{ measureNumber: number; canonical: number; page: number }> {
  return [...new Set(regions.map((region) => region.measureNumber))]
    .flatMap((measureNumber) => {
      const canonical = canonicalMeasureNumber(measureNumber, measureNumberOffset);
      return canonical === undefined
        ? []
        : [
            {
              measureNumber,
              canonical,
              page: regions.find((region) => region.measureNumber === measureNumber)?.page ?? 1,
            },
          ];
    })
    .sort((left, right) => left.canonical - right.canonical);
}

export function keyboardMeasureTarget(
  measures: readonly { canonical: number; page: number }[],
  currentMeasure: number,
  key: string,
): { canonical: number; page: number } | undefined {
  const currentIndex = measures.findIndex((entry) => entry.canonical >= currentMeasure);
  const targetIndex =
    key === 'Home'
      ? 0
      : key === 'End'
        ? measures.length - 1
        : key === 'ArrowLeft' || key === 'ArrowUp'
          ? Math.max(0, (currentIndex < 0 ? measures.length : currentIndex) - 1)
          : key === 'ArrowRight' || key === 'ArrowDown'
            ? Math.min(measures.length - 1, Math.max(0, currentIndex + 1))
            : -1;
  return measures[targetIndex];
}

export function percentRectToNormalized(region: NormalizedRect): NormalizedRect | undefined {
  const rect = {
    x: region.x / 100,
    y: region.y / 100,
    w: region.w / 100,
    h: region.h / 100,
  };
  if (
    Object.values(rect).some((value) => !Number.isFinite(value)) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.w <= 0 ||
    rect.h <= 0 ||
    rect.x + rect.w > 1 ||
    rect.y + rect.h > 1
  ) {
    return undefined;
  }
  return rect;
}

export function regionsFromSystem(
  systemRect: NormalizedRect,
  boundaries: readonly number[],
  page: number,
  firstMeasure: number,
  createId: () => string = () => crypto.randomUUID(),
): MeasureRegion[] {
  const cuts = [0, ...boundaries, 1];
  return cuts.slice(0, -1).map((start, index) => {
    const end = cuts[index + 1] ?? 1;
    return {
      id: createId(),
      page,
      measureNumber: firstMeasure + index,
      rect: {
        x: systemRect.x + systemRect.w * start,
        y: systemRect.y,
        w: systemRect.w * (end - start),
        h: systemRect.h,
      },
    };
  });
}
