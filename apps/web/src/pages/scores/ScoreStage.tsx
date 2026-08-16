import { Button, Card } from '@feelmyrythm/ui';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
  SetStateAction,
} from 'react';
import { MarkdownContent } from '../../components/MarkdownContent';
import type { LocalMeasureMap, LocalScore } from '../../lib/localDb';
import type { PracticeAnchorMarker } from '../../lib/practiceApi';
import {
  canonicalMeasureNumber,
  scoreMeasureNumber,
  type VersionedAnnotation,
} from '../../lib/scoreApi';
import { ScoreOverlay } from './ScoreOverlay';
import { ScoreSurface } from './ScoreSurface';
import type { AnnotationMode, MeasureRegion, NormalizedRect, PenPoint } from './types';

export function ScoreStage({
  scoreZoom,
  setScoreZoom,
  metronomePlaying,
  autoPageFollowing,
  setAutoPageFollowing,
  measureMap,
  setPage,
  viewerRef,
  mode,
  scoreSurfaceKeyDown,
  pointerDown,
  pointerMove,
  pointerUp,
  pointerCancel,
  selected,
  page,
  setPageCount,
  currentMeasure,
  selectCanonicalMeasure,
  visibleRegions,
  visibleOmrRegions,
  omrDraftId,
  systemRect,
  boundaries,
  visibleAnnotations,
  visibleMeasureAnnotations,
  activePenPoints,
  visiblePracticeMarkers,
  currentPracticeMarkers,
  pageCount,
  metronomeMeasureNumber,
}: {
  scoreZoom: number;
  setScoreZoom: Dispatch<SetStateAction<number>>;
  metronomePlaying: boolean;
  autoPageFollowing: boolean;
  setAutoPageFollowing: Dispatch<SetStateAction<boolean>>;
  measureMap?: LocalMeasureMap | undefined;
  setPage: Dispatch<SetStateAction<number>>;
  viewerRef: RefObject<HTMLDivElement | null>;
  mode: AnnotationMode;
  scoreSurfaceKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  pointerDown: (event: ReactPointerEvent) => void;
  pointerMove: (event: ReactPointerEvent) => void;
  pointerUp: (event: ReactPointerEvent) => void;
  pointerCancel: (event: ReactPointerEvent) => void;
  selected?: LocalScore | undefined;
  page: number;
  setPageCount: Dispatch<SetStateAction<number>>;
  currentMeasure: number;
  selectCanonicalMeasure: (canonical: number, page?: number) => void;
  visibleRegions: MeasureRegion[];
  visibleOmrRegions: Array<{ page: number; measureNumber: number; rect: NormalizedRect }>;
  omrDraftId?: string | undefined;
  systemRect?: NormalizedRect | undefined;
  boundaries: number[];
  visibleAnnotations: VersionedAnnotation[];
  visibleMeasureAnnotations: Array<{ annotation: VersionedAnnotation; x: number; y: number }>;
  activePenPoints: PenPoint[];
  visiblePracticeMarkers: Array<{ marker: PracticeAnchorMarker; x: number; y: number }>;
  currentPracticeMarkers: PracticeAnchorMarker[];
  pageCount: number;
  metronomeMeasureNumber: number;
}) {
  return (
    <div className="score-stage-wrap">
      <div className="score-view-controls" aria-label="악보 보기 설정">
        <Button
          size="icon"
          aria-label="악보 축소"
          disabled={scoreZoom <= 1}
          onClick={() => setScoreZoom((current) => Math.max(1, current - 0.25))}
        >
          <ZoomOut size={18} aria-hidden />
        </Button>
        <span className="fmr-tabular" aria-live="polite">
          {Math.round(scoreZoom * 100)}%
        </span>
        <Button
          size="icon"
          aria-label="악보 확대"
          disabled={scoreZoom >= 2}
          onClick={() => setScoreZoom((current) => Math.min(2, current + 0.25))}
        >
          <ZoomIn size={18} aria-hidden />
        </Button>
        {metronomePlaying && !autoPageFollowing ? (
          <Button
            onClick={() => {
              setAutoPageFollowing(true);
              const scoreMeasure = scoreMeasureNumber(
                metronomeMeasureNumber,
                measureMap?.measureNumberOffset ?? 0,
              );
              const target = measureMap?.regions.find(
                (region) => region.measureNumber === scoreMeasure,
              );
              if (target) setPage(target.page);
            }}
          >
            재생 위치로 돌아가기
          </Button>
        ) : null}
      </div>
      <div ref={viewerRef} className={`score-stage score-stage--${mode}`}>
        <div
          className="score-page-surface"
          style={{ width: `${scoreZoom * 100}%` }}
          role="group"
          tabIndex={0}
          aria-label={`${page}페이지 악보. 화살표 키로 매핑된 마디를 이동합니다.`}
          onKeyDown={scoreSurfaceKeyDown}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerCancel}
        >
          {selected ? (
            <ScoreSurface
              key={`${selected.id}:${scoreZoom}`}
              score={selected}
              page={page}
              onPageCount={setPageCount}
            />
          ) : null}
          <ScoreOverlay
            visibleRegions={visibleRegions}
            measureNumberOffset={measureMap?.measureNumberOffset ?? 0}
            currentMeasure={currentMeasure}
            visibleOmrRegions={visibleOmrRegions}
            omrDraftId={omrDraftId}
            systemRect={systemRect}
            boundaries={boundaries}
            visibleAnnotations={visibleAnnotations}
            visibleMeasureAnnotations={visibleMeasureAnnotations}
            activePenPoints={activePenPoints}
            visiblePracticeMarkers={visiblePracticeMarkers}
          />
        </div>
      </div>
      {visibleRegions.length ? (
        <nav className="score-measure-index" aria-label={`${page}페이지 마디 선택`}>
          {visibleRegions.flatMap((region) => {
            const canonical = canonicalMeasureNumber(
              region.measureNumber,
              measureMap?.measureNumberOffset ?? 0,
            );
            return canonical === undefined
              ? []
              : [
                  <button
                    key={region.id}
                    type="button"
                    aria-current={canonical === currentMeasure ? 'true' : undefined}
                    onClick={() => void selectCanonicalMeasure(canonical, region.page)}
                  >
                    {canonical}마디
                  </button>,
                ];
          })}
        </nav>
      ) : null}
      {currentPracticeMarkers.length ? (
        <Card className="score-practice-notes" aria-label={`${currentMeasure}마디 연습 메모`}>
          <strong>{currentMeasure}마디 연습 메모</strong>
          {currentPracticeMarkers.map((marker) => (
            <article key={`${marker.logId}:${marker.measureNumber}`}>
              <span className="subtle">{marker.authorName}</span>
              <MarkdownContent>{marker.content}</MarkdownContent>
            </article>
          ))}
        </Card>
      ) : null}
      {pageCount > 1 ? (
        <div className="score-pagination">
          <Button
            size="icon"
            aria-label="이전 페이지"
            disabled={page <= 1}
            onClick={() => {
              setAutoPageFollowing(false);
              setPage((current) => Math.max(1, current - 1));
            }}
          >
            <ChevronLeft size={18} />
          </Button>
          <span className="fmr-tabular">
            {page} / {pageCount}
          </span>
          <Button
            size="icon"
            aria-label="다음 페이지"
            disabled={page >= pageCount}
            onClick={() => {
              setAutoPageFollowing(false);
              setPage((current) => Math.min(pageCount, current + 1));
            }}
          >
            <ChevronRight size={18} />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
