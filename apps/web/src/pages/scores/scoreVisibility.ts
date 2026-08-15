import type { LocalMeasureMap } from '../../lib/localDb';
import type { PracticeAnchorMarker } from '../../lib/practiceApi';
import { scoreMeasureNumber, type OmrDraft, type VersionedAnnotation } from '../../lib/scoreApi';
import type { MeasureRegion } from './types';

export function visiblePageRegions(
  measureMap: LocalMeasureMap | undefined,
  selectedId: string | undefined,
  page: number,
): MeasureRegion[] {
  if (!measureMap || !selectedId || measureMap.scoreId !== selectedId) return [];
  return measureMap.regions.filter((region) => region.page === page);
}

export function visibleOmrPageRegions(
  omrDraft: OmrDraft | undefined,
  selectedId: string | undefined,
  page: number,
  showPreview: boolean,
): OmrDraft['regions'] {
  if (!showPreview || omrDraft?.status !== 'succeeded' || omrDraft.scoreId !== selectedId) {
    return [];
  }
  return omrDraft.regions.filter((region) => region.page === page);
}

export function visiblePageAnnotations(
  annotations: readonly VersionedAnnotation[],
  selectedId: string | undefined,
  page: number,
): VersionedAnnotation[] {
  return annotations.filter(
    (annotation) =>
      annotation.scoreId === selectedId &&
      annotation.page === page &&
      annotation.payload.anchorType !== 'measure',
  );
}

export function projectedMeasureAnnotations(
  annotations: readonly VersionedAnnotation[],
  visibleRegions: readonly MeasureRegion[],
  measureNumberOffset: number,
): Array<{ annotation: VersionedAnnotation; x: number; y: number }> {
  return annotations.flatMap((annotation) => {
    if (
      annotation.payload.anchorType !== 'measure' ||
      annotation.measureNumber === undefined ||
      (annotation.kind !== 'text' && annotation.kind !== 'stamp')
    ) {
      return [];
    }
    const scoreMeasure = scoreMeasureNumber(annotation.measureNumber, measureNumberOffset);
    const region = visibleRegions.find((candidate) => candidate.measureNumber === scoreMeasure);
    return region
      ? [
          {
            annotation,
            x: region.rect.x + region.rect.w / 2,
            y: region.rect.y + region.rect.h / 2,
          },
        ]
      : [];
  });
}

export function editablePageAnnotations(
  pageAnnotations: readonly VersionedAnnotation[],
  measureAnnotations: readonly { annotation: VersionedAnnotation }[],
  selectedId: string | undefined,
): VersionedAnnotation[] {
  return [
    ...pageAnnotations,
    ...measureAnnotations
      .filter(({ annotation }) => annotation.scoreId === selectedId)
      .map(({ annotation }) => annotation),
  ];
}

export function projectedPracticeMarkers(
  practiceMarkers: readonly PracticeAnchorMarker[],
  visibleRegions: readonly MeasureRegion[],
  selectedId: string | undefined,
  page: number,
  measureNumberOffset: number,
): Array<{ marker: PracticeAnchorMarker; x: number; y: number }> {
  return practiceMarkers.flatMap((marker) => {
    if (
      marker.scoreId === selectedId &&
      marker.page === page &&
      marker.x !== undefined &&
      marker.y !== undefined
    ) {
      return [{ marker, x: marker.x, y: marker.y }];
    }
    if (marker.measureNumber === undefined) return [];
    const scoreMeasure = scoreMeasureNumber(marker.measureNumber, measureNumberOffset);
    const region = visibleRegions.find((candidate) => candidate.measureNumber === scoreMeasure);
    return region
      ? [
          {
            marker,
            x: region.rect.x + region.rect.w - 0.012,
            y: region.rect.y + 0.014,
          },
        ]
      : [];
  });
}

export function currentMeasurePracticeMarkers(
  practiceMarkers: readonly PracticeAnchorMarker[],
  currentMeasure: number,
): PracticeAnchorMarker[] {
  return practiceMarkers.filter((marker) => marker.measureNumber === currentMeasure);
}
