import type { PracticeAnchorMarker } from '../../lib/practiceApi';
import type { PenPoint } from './types';

export function annotationRevision(annotation: unknown, fallback = 0): number {
  if (typeof annotation !== 'object' || annotation === null || !('revision' in annotation)) {
    return fallback;
  }
  const revision = annotation.revision;
  return typeof revision === 'number' && Number.isInteger(revision) ? revision : fallback;
}

export function localPracticeMarkers(
  repertoireItemId: string,
  scoreId: string,
): PracticeAnchorMarker[] {
  try {
    const raw = localStorage.getItem(`fmr.practice.${repertoireItemId}`);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): PracticeAnchorMarker[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const value = entry as Record<string, unknown>;
      const measureNumber = Number(value.measureNumber);
      if (!Number.isInteger(measureNumber) || measureNumber < 1) return [];
      return [
        {
          logId: typeof value.id === 'string' ? value.id : crypto.randomUUID(),
          authorName: typeof value.authorDisplayName === 'string' ? value.authorDisplayName : '나',
          content: typeof value.bodyMarkdown === 'string' ? value.bodyMarkdown : '',
          measureNumber,
          scoreId,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function penPoints(payload: Record<string, unknown>): PenPoint[] {
  const points = payload.points;
  if (!Array.isArray(points)) return [];
  return points.flatMap((point): PenPoint[] => {
    if (typeof point !== 'object' || point === null) return [];
    const x = Number((point as Record<string, unknown>).x);
    const y = Number((point as Record<string, unknown>).y);
    return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : [];
  });
}
