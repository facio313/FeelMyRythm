import { Button, Card, Field, StatusBadge } from '@feelmyrythm/ui';
import {
  ChevronDown,
  Highlighter,
  Map as MapIcon,
  MousePointer2,
  PenLine,
  Play,
  Save,
  Square,
  Stamp,
  Trash2,
  Type,
} from 'lucide-react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { AnnotationConnectionState } from '../../lib/annotationClient';
import type { LocalMeasureMap, LocalScore } from '../../lib/localDb';
import type { OmrDraft, VersionedAnnotation } from '../../lib/scoreApi';
import { scoreMeasureNumber } from '../../lib/scoreApi';
import type { AnnotationMode, AnnotationScope } from './types';

export interface ScoreToolsProps {
  toolsOpen: boolean;
  setToolsOpen: Dispatch<SetStateAction<boolean>>;
  mode: AnnotationMode;
  setMode: Dispatch<SetStateAction<AnnotationMode>>;
  usingOfflineCache: boolean;
  canManageScores: boolean;
  currentMeasure: number;
  setCurrentMeasure: Dispatch<SetStateAction<number>>;
  currentMeasureRef: MutableRefObject<number>;
  measureMap?: LocalMeasureMap | undefined;
  setPage: Dispatch<SetStateAction<number>>;
  selected?: LocalScore | undefined;
  playbackReady: boolean;
  metronomePlaying: boolean;
  togglePlayback: () => void;
  annotationText: string;
  setAnnotationText: Dispatch<SetStateAction<string>>;
  saveAnnotation: (
    point: { x: number; y: number },
    anchorType?: 'page' | 'measure',
  ) => Promise<void>;
  annotationScope: AnnotationScope;
  setAnnotationScope: Dispatch<SetStateAction<AnnotationScope>>;
  visibleEditableAnnotations: VersionedAnnotation[];
  remoteMode: boolean;
  userId?: string | undefined;
  removeAnnotation: (annotation: VersionedAnnotation) => Promise<void>;
  firstMeasure: number;
  setFirstMeasure: Dispatch<SetStateAction<number>>;
  keyboardRegion: { x: number; y: number; w: number; h: number };
  setKeyboardRegion: Dispatch<SetStateAction<{ x: number; y: number; w: number; h: number }>>;
  addKeyboardRegion: () => void;
  finishSystem: () => void;
  measureMapRevision: number;
  annotationConnectionState: AnnotationConnectionState;
  omrDraft?: OmrDraft | undefined;
  omrRequesting: boolean;
  omrPollingError?: string | undefined;
  requestOmrDraft: () => void;
  refreshOmrDraft: () => void;
  showOmrPreview: boolean;
  setShowOmrPreview: Dispatch<SetStateAction<boolean>>;
  applyOmrDraft: () => void;
  scoreKind: 'full' | 'part';
  setScoreKind: Dispatch<SetStateAction<'full' | 'part'>>;
  instrument: string;
  setInstrument: Dispatch<SetStateAction<string>>;
  measureNumberOffset: number;
  setMeasureNumberOffset: Dispatch<SetStateAction<number>>;
  savingMetadata: boolean;
  saveMetadata: () => void;
}

export function ScoreTools({
  toolsOpen,
  setToolsOpen,
  mode,
  setMode,
  usingOfflineCache,
  canManageScores,
  currentMeasure,
  setCurrentMeasure,
  currentMeasureRef,
  measureMap,
  setPage,
  selected,
  playbackReady,
  metronomePlaying,
  togglePlayback,
  annotationText,
  setAnnotationText,
  saveAnnotation,
  annotationScope,
  setAnnotationScope,
  visibleEditableAnnotations,
  remoteMode,
  userId,
  removeAnnotation,
  firstMeasure,
  setFirstMeasure,
  keyboardRegion,
  setKeyboardRegion,
  addKeyboardRegion,
  finishSystem,
  measureMapRevision,
  annotationConnectionState,
  omrDraft,
  omrRequesting,
  omrPollingError,
  requestOmrDraft,
  refreshOmrDraft,
  showOmrPreview,
  setShowOmrPreview,
  applyOmrDraft,
  scoreKind,
  setScoreKind,
  instrument,
  setInstrument,
  measureNumberOffset,
  setMeasureNumberOffset,
  savingMetadata,
  saveMetadata,
}: ScoreToolsProps) {
  return (
    <Card className="score-toolbar" data-open={toolsOpen || undefined}>
      <Button
        className="score-toolbar__toggle"
        variant="ghost"
        aria-expanded={toolsOpen}
        aria-controls="score-tools"
        onClick={() => setToolsOpen((current) => !current)}
      >
        악보 도구
        <ChevronDown size={18} aria-hidden />
      </Button>
      <div id="score-tools" className="score-toolbar__content">
        <div className="score-toolbar__group">
          <span className="fmr-field__label">도구</span>
          <Button
            variant={mode === 'view' ? 'primary' : 'secondary'}
            aria-pressed={mode === 'view'}
            onClick={() => setMode('view')}
          >
            <MousePointer2 size={17} /> 보기
          </Button>
          <Button
            variant={mode === 'system' || mode === 'boundaries' ? 'primary' : 'secondary'}
            aria-pressed={mode === 'system' || mode === 'boundaries'}
            disabled={usingOfflineCache || !canManageScores}
            onClick={() => setMode('system')}
          >
            <MapIcon size={17} /> 마디 매핑
          </Button>
          <Button
            variant={mode === 'pen' ? 'primary' : 'secondary'}
            aria-pressed={mode === 'pen'}
            disabled={usingOfflineCache}
            onClick={() => setMode('pen')}
          >
            <PenLine size={17} /> 펜
          </Button>
          <Button
            variant={mode === 'text' ? 'primary' : 'secondary'}
            aria-pressed={mode === 'text'}
            disabled={usingOfflineCache}
            onClick={() => setMode('text')}
          >
            <Type size={17} /> 텍스트
          </Button>
          <Button
            variant={mode === 'stamp' ? 'primary' : 'secondary'}
            aria-pressed={mode === 'stamp'}
            disabled={usingOfflineCache}
            onClick={() => setMode('stamp')}
          >
            <Stamp size={17} /> 기호
          </Button>
        </div>
        <Field
          label="현재 마디"
          type="number"
          min={1}
          value={currentMeasure}
          onChange={(event) => {
            const next = Math.max(1, Number(event.target.value));
            currentMeasureRef.current = next;
            setCurrentMeasure(next);
            const scoreMeasure = scoreMeasureNumber(next, measureMap?.measureNumberOffset ?? 0);
            const target = measureMap?.regions.find(
              (region) => region.measureNumber === scoreMeasure,
            );
            if (target) setPage(target.page);
          }}
        />
        <Button
          disabled={!selected || !playbackReady}
          variant={metronomePlaying ? 'primary' : 'secondary'}
          onClick={() => void togglePlayback()}
        >
          {metronomePlaying ? <Square size={17} /> : <Play size={17} />}
          {metronomePlaying ? '악보 재생 정지' : '이 마디부터 재생'}
        </Button>
        {mode === 'pen' || mode === 'text' || mode === 'stamp' ? (
          <div className="score-annotation-settings">
            {mode === 'text' || mode === 'stamp' ? (
              <>
                <Field
                  label={mode === 'text' ? '필기 내용' : '기호'}
                  value={annotationText}
                  onChange={(event) => setAnnotationText(event.target.value)}
                />
                <Button
                  disabled={!annotationText.trim() || usingOfflineCache}
                  onClick={() => void saveAnnotation({ x: 0.5, y: 0.5 }, 'measure')}
                >
                  현재 마디 중앙에 추가
                </Button>
              </>
            ) : null}
            <fieldset>
              <legend className="fmr-field__label">공유 범위</legend>
              <label>
                <input
                  type="radio"
                  name="annotation-scope"
                  checked={annotationScope === 'private'}
                  onChange={() => setAnnotationScope('private')}
                />{' '}
                나만 보기
              </label>
              <label>
                <input
                  type="radio"
                  name="annotation-scope"
                  checked={annotationScope === 'project'}
                  onChange={() => setAnnotationScope('project')}
                />{' '}
                프로젝트 공유
              </label>
            </fieldset>
            {visibleEditableAnnotations.length ? (
              <div className="score-annotation-list" aria-label="이 페이지 필기 목록">
                <strong>이 페이지 필기</strong>
                {visibleEditableAnnotations.map((annotation) => {
                  const text = annotation.payload.text;
                  const label =
                    typeof text === 'string' && text.trim()
                      ? text
                      : annotation.kind === 'pen'
                        ? '펜 스트로크'
                        : '필기';
                  return (
                    <div key={annotation.id}>
                      <span>{label}</span>
                      {!remoteMode || annotation.authorId === userId || canManageScores ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`필기 삭제: ${label}`}
                          disabled={usingOfflineCache}
                          onClick={() => void removeAnnotation(annotation)}
                        >
                          <Trash2 size={16} aria-hidden />
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
        {mode === 'system' ? (
          <div className="stack">
            <div className="mapping-help">
              <PenLine size={18} aria-hidden />
              <p>한 시스템(단) 전체를 드래그하세요.</p>
            </div>
            <details className="keyboard-region-editor">
              <summary>키보드로 마디 영역 추가</summary>
              <Field
                label="마디 번호"
                type="number"
                min={1}
                value={firstMeasure}
                onChange={(event) => setFirstMeasure(Number(event.target.value))}
              />
              {(['x', 'y', 'w', 'h'] as const).map((field) => (
                <Field
                  key={field}
                  label={
                    field === 'x'
                      ? '왼쪽 위치 (%)'
                      : field === 'y'
                        ? '위쪽 위치 (%)'
                        : field === 'w'
                          ? '너비 (%)'
                          : '높이 (%)'
                  }
                  type="number"
                  min={field === 'w' || field === 'h' ? 1 : 0}
                  max={100}
                  value={keyboardRegion[field]}
                  onChange={(event) =>
                    setKeyboardRegion((current) => ({
                      ...current,
                      [field]: Number(event.target.value),
                    }))
                  }
                />
              ))}
              <Button variant="primary" onClick={() => void addKeyboardRegion()}>
                영역 추가
              </Button>
            </details>
          </div>
        ) : null}
        {mode === 'boundaries' ? (
          <div className="stack">
            <Field
              label="첫 마디 번호"
              type="number"
              min={1}
              value={firstMeasure}
              onChange={(event) => setFirstMeasure(Number(event.target.value))}
            />
            <p className="subtle">각 마디 경계를 차례로 클릭한 뒤 완료하세요.</p>
            <Button variant="primary" onClick={() => void finishSystem()}>
              <Save size={17} /> 시스템 완료
            </Button>
          </div>
        ) : null}
        <StatusBadge tone="info">
          <Highlighter size={13} /> {measureMap?.regions.length ?? 0}마디 매핑됨
          {remoteMode ? ` · r${measureMapRevision}` : ''}
        </StatusBadge>
        {remoteMode && selected && !usingOfflineCache ? (
          <StatusBadge
            tone={
              annotationConnectionState === 'live'
                ? 'success'
                : annotationConnectionState === 'offline' || annotationConnectionState === 'closed'
                  ? 'warning'
                  : 'info'
            }
          >
            {annotationConnectionState === 'live'
              ? '공동 필기 실시간 연결됨'
              : annotationConnectionState === 'reconnecting'
                ? '공동 필기 다시 동기화 중…'
                : annotationConnectionState === 'offline'
                  ? '공동 필기 오프라인'
                  : annotationConnectionState === 'closed'
                    ? '공동 필기 권한 확인 필요'
                    : '공동 필기 연결 중…'}
          </StatusBadge>
        ) : null}
        {remoteMode &&
        selected &&
        (selected.mimeType === 'application/pdf' || selected.mimeType.startsWith('image/')) ? (
          <section className="omr-draft-panel" aria-labelledby="omr-draft-heading">
            <strong id="omr-draft-heading">Audiveris OMR 초안</strong>
            <p className="subtle">
              자동 인식은 시작점만 제공합니다. 저장하기 전에 모든 페이지와 마디 영역을 확인하세요.
            </p>
            {!omrDraft ? (
              <Button
                disabled={omrRequesting || usingOfflineCache || !canManageScores}
                onClick={() => void requestOmrDraft()}
              >
                <MapIcon size={17} aria-hidden />
                {omrRequesting ? '요청 중…' : 'OMR 초안 생성'}
              </Button>
            ) : null}
            {omrDraft?.status === 'pending' || omrDraft?.status === 'running' ? (
              <div role="status" aria-live="polite" className="omr-draft-status">
                <span>{omrDraft.status === 'pending' ? '분석 대기 중…' : '악보 분석 중…'}</span>
                {omrPollingError ? (
                  <>
                    <span className="danger-text">{omrPollingError}</span>
                    <Button onClick={() => void refreshOmrDraft()}>상태 다시 확인</Button>
                  </>
                ) : null}
              </div>
            ) : null}
            {omrDraft?.status === 'failed' ? (
              <div role="alert" className="omr-draft-status">
                <span>{omrDraft.error ?? 'OMR 분석에 실패했습니다.'}</span>
                <Button onClick={() => void requestOmrDraft()}>다시 생성</Button>
              </div>
            ) : null}
            {omrDraft?.status === 'succeeded' ? (
              <div className="omr-draft-result">
                <span>{omrDraft.regions.length}개 마디 영역을 인식했습니다.</span>
                {omrDraft.warnings.map((warning) => (
                  <span key={warning} className="subtle">
                    {warning}
                  </span>
                ))}
                <div className="omr-draft-actions">
                  <Button
                    aria-pressed={showOmrPreview}
                    onClick={() => setShowOmrPreview((current) => !current)}
                  >
                    {showOmrPreview ? '초안 미리보기 닫기' : '초안 영역 미리보기'}
                  </Button>
                  <Button
                    variant="primary"
                    disabled={usingOfflineCache || !canManageScores}
                    onClick={() => void applyOmrDraft()}
                  >
                    초안을 마디 맵으로 저장
                  </Button>
                  <Button variant="ghost" onClick={() => void requestOmrDraft()}>
                    다시 분석
                  </Button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}
        {usingOfflineCache ? <StatusBadge tone="warning">오프라인 읽기 전용</StatusBadge> : null}
        <details className="score-metadata">
          <summary>악보 정보 · 번호 보정</summary>
          <label className="fmr-field">
            <span className="fmr-field__label">악보 종류</span>
            <select
              className="fmr-input"
              disabled={!canManageScores || usingOfflineCache}
              value={scoreKind}
              onChange={(event) => setScoreKind(event.target.value as 'full' | 'part')}
            >
              <option value="full">총보</option>
              <option value="part">파트보</option>
            </select>
          </label>
          <Field
            label="악기"
            disabled={!canManageScores || usingOfflineCache}
            value={instrument}
            placeholder={scoreKind === 'full' ? '총보' : '예: Violin 1'}
            onChange={(event) => setInstrument(event.target.value)}
          />
          <Field
            label="공통 마디 번호 오프셋"
            hint="악보의 1마디가 곡의 11마디라면 10을 입력합니다."
            type="number"
            disabled={!canManageScores || usingOfflineCache}
            value={measureNumberOffset}
            onChange={(event) => setMeasureNumberOffset(Number(event.target.value))}
          />
          <Button
            disabled={savingMetadata || usingOfflineCache || !canManageScores}
            onClick={() => void saveMetadata()}
          >
            <Save size={17} aria-hidden /> {savingMetadata ? '저장 중…' : '정보 저장'}
          </Button>
        </details>
      </div>
    </Card>
  );
}
