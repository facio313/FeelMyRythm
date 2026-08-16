import type { PracticeAnchorMarker } from '../../lib/practiceApi';
import { canonicalMeasureNumber, type VersionedAnnotation } from '../../lib/scoreApi';
import { penPoints } from './annotationHelpers';
import type { MeasureRegion, NormalizedRect, PenPoint } from './types';

export function ScoreOverlay({
  visibleRegions,
  measureNumberOffset,
  currentMeasure,
  visibleOmrRegions,
  omrDraftId,
  systemRect,
  boundaries,
  visibleAnnotations,
  visibleMeasureAnnotations,
  activePenPoints,
  visiblePracticeMarkers,
}: {
  visibleRegions: readonly MeasureRegion[];
  measureNumberOffset: number;
  currentMeasure: number;
  visibleOmrRegions: readonly { page: number; measureNumber: number; rect: NormalizedRect }[];
  omrDraftId?: string | undefined;
  systemRect?: NormalizedRect | undefined;
  boundaries: readonly number[];
  visibleAnnotations: readonly VersionedAnnotation[];
  visibleMeasureAnnotations: readonly { annotation: VersionedAnnotation; x: number; y: number }[];
  activePenPoints: readonly PenPoint[];
  visiblePracticeMarkers: readonly { marker: PracticeAnchorMarker; x: number; y: number }[];
}) {
  return (
    <svg
      className="score-overlay"
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      aria-label="마디 매핑과 필기"
    >
      {visibleRegions.map((region) => (
        <rect
          key={region.id}
          className={
            canonicalMeasureNumber(region.measureNumber, measureNumberOffset) === currentMeasure
              ? 'measure-region measure-region--current'
              : 'measure-region'
          }
          x={region.rect.x}
          y={region.rect.y}
          width={region.rect.w}
          height={region.rect.h}
        />
      ))}
      {visibleOmrRegions.map((region, index) => (
        <rect
          key={`omr:${omrDraftId}:${index}`}
          className="measure-region measure-region--omr-draft"
          x={region.rect.x}
          y={region.rect.y}
          width={region.rect.w}
          height={region.rect.h}
        >
          <title>OMR 초안 {region.measureNumber}마디</title>
        </rect>
      ))}
      {systemRect ? (
        <>
          <rect
            className="system-selection"
            x={systemRect.x}
            y={systemRect.y}
            width={systemRect.w}
            height={systemRect.h}
          />
          {boundaries.map((boundary) => (
            <line
              key={boundary}
              className="boundary-line"
              x1={systemRect.x + systemRect.w * boundary}
              y1={systemRect.y}
              x2={systemRect.x + systemRect.w * boundary}
              y2={systemRect.y + systemRect.h}
            />
          ))}
        </>
      ) : null}
      {visibleAnnotations.map((annotation) => {
        const x = Number(annotation.payload.x ?? 0);
        const y = Number(annotation.payload.y ?? 0);
        const annotationText = annotation.payload.text;
        const content =
          typeof annotationText === 'string' || typeof annotationText === 'number'
            ? String(annotationText)
            : '';
        if (annotation.kind === 'pen') {
          const points = penPoints(annotation.payload);
          return points.length > 1 ? (
            <polyline
              key={annotation.id}
              className={`annotation-pen annotation-pen--${annotation.scope}`}
              points={points.map((point) => `${point.x},${point.y}`).join(' ')}
            />
          ) : null;
        }
        return annotation.kind === 'stamp' ? (
          <text key={annotation.id} className="annotation-stamp" x={x} y={y}>
            {content}
          </text>
        ) : (
          <text key={annotation.id} className="annotation-text" x={x} y={y}>
            {content}
          </text>
        );
      })}
      {visibleMeasureAnnotations.map(({ annotation, x, y }) => {
        const text = annotation.payload.text;
        const content = typeof text === 'string' || typeof text === 'number' ? String(text) : '';
        return (
          <text
            key={`transferred:${annotation.id}`}
            className={
              annotation.kind === 'stamp'
                ? 'annotation-stamp annotation-transferred'
                : 'annotation-text annotation-transferred'
            }
            x={x}
            y={y}
          >
            {content}
          </text>
        );
      })}
      {activePenPoints.length > 1 ? (
        <polyline
          className="annotation-pen annotation-pen--draft"
          points={activePenPoints.map((point) => `${point.x},${point.y}`).join(' ')}
        />
      ) : null}
      {visiblePracticeMarkers.map(({ marker, x, y }) => (
        <g
          key={`${marker.logId}:${marker.measureNumber ?? marker.page}:${marker.x ?? x}:${marker.y ?? y}`}
          className="practice-marker"
        >
          <circle cx={x} cy={y} r="0.009" />
          <title>
            {marker.authorName}: {marker.content}
          </title>
        </g>
      ))}
    </svg>
  );
}
