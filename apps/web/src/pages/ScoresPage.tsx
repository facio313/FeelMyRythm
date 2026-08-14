import { assertValidTempoMap, type TempoMap } from '@feelmyrythm/core';
import type { components } from '@feelmyrythm/protocol';
import { Button, Card, EmptyState, Field, StatusBadge, useToast } from '@feelmyrythm/ui';
import {
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileMusic,
  FileText,
  Highlighter,
  Map,
  MousePointer2,
  PenLine,
  Play,
  Save,
  Square,
  Stamp,
  Trash2,
  Type,
  Upload,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { MarkdownContent } from '../components/MarkdownContent';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { localDb, type LocalMeasureMap, type LocalScore } from '../lib/localDb';
import { musicXmlToTempoMap, readMusicXml, renderMusicXml } from '../lib/musicxml';
import {
  listPracticeLogs,
  practiceAnchorMarkers,
  type PracticeAnchorMarker,
} from '../lib/practiceApi';
import {
  canonicalMeasureNumber,
  createAnnotation,
  createMusicXmlDraft,
  deleteAnnotation as deleteRemoteAnnotation,
  downloadScore,
  getMeasureMap as getRemoteMeasureMap,
  getScore as getRemoteScore,
  listRepertoireAnnotations,
  listScores as listRemoteScores,
  localScoreListItem,
  putMeasureMap as putRemoteMeasureMap,
  scoreMeasureNumber,
  scoreListItem,
  tempoMapFromMusicXmlDraft,
  updateAnnotation,
  updateScoreSettings,
  uploadScore,
  type MusicXmlDraft,
  type ScoreListItem,
  type ScoreRecord,
  type VersionedAnnotation,
} from '../lib/scoreApi';
import { useAsync } from '../lib/useAsync';
import { createDefaultTempoMap } from '../lib/defaultTempoMap';
import { useMetronome } from '../lib/useMetronome';

interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type ServerTempoMap = components['schemas']['TempoMapOut'];
type AnnotationMode = 'view' | 'system' | 'boundaries' | 'pen' | 'text' | 'stamp';
type AnnotationScope = 'private' | 'project';

interface PenPoint {
  x: number;
  y: number;
}

interface PendingTempoDraft {
  draft: MusicXmlDraft;
  filename: string;
  repertoireItemId: string;
}

function localPracticeMarkers(repertoireItemId: string, scoreId: string): PracticeAnchorMarker[] {
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

function penPoints(payload: Record<string, unknown>): PenPoint[] {
  const points = payload.points;
  if (!Array.isArray(points)) return [];
  return points.flatMap((point): PenPoint[] => {
    if (typeof point !== 'object' || point === null) return [];
    const x = Number((point as Record<string, unknown>).x);
    const y = Number((point as Record<string, unknown>).y);
    return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : [];
  });
}

const MUSIC_XML_MIME = 'application/vnd.recordare.musicxml+xml';

const isMusicXmlName = (name: string): boolean => /\.(?:musicxml|mxl|xml)$/i.test(name);

function scoreContentType(file: File): string {
  if (file.type && file.type !== 'application/octet-stream') return file.type;
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.mxl')) return 'application/zip';
  if (lower.endsWith('.musicxml') || lower.endsWith('.xml')) return MUSIC_XML_MIME;
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return file.type;
}

function supportsScore(file: File, contentType: string): boolean {
  return (
    contentType === 'application/pdf' ||
    contentType.startsWith('image/') ||
    contentType.includes('musicxml') ||
    isMusicXmlName(file.name)
  );
}

function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && /fetch|network|load/i.test(error.message);
}

function nextMeasureNumber(map?: LocalMeasureMap): number {
  return Math.max(0, ...(map?.regions.map((region) => region.measureNumber) ?? [])) + 1;
}

function draftSectionSummary(section: Record<string, unknown>, index: number): string {
  const start = Number(section.startMeasure);
  const end = Number(section.endMeasure);
  const bpm = Number(section.bpm);
  const signature = section.timeSignature;
  const signatureRecord =
    typeof signature === 'object' && signature !== null
      ? (signature as Record<string, unknown>)
      : undefined;
  const num = signatureRecord?.num;
  const denom = signatureRecord?.denom;
  const meter = `${typeof num === 'number' || typeof num === 'string' ? num : '?'}/${
    typeof denom === 'number' || typeof denom === 'string' ? denom : '?'
  }`;
  return `구간 ${index + 1}: ${Number.isFinite(start) ? start : '?'}–${Number.isFinite(end) ? end : '?'}마디 · ${meter} · ${Number.isFinite(bpm) ? bpm : '?'} BPM`;
}

function draftJumpSummary(jump: Record<string, unknown>, index: number): string {
  const type = typeof jump.type === 'string' ? jump.type : `이동 ${index + 1}`;
  const details = ['startMeasure', 'endMeasure', 'fromMeasure', 'targetMeasure', 'times', 'pass']
    .flatMap((key) =>
      typeof jump[key] === 'number' || typeof jump[key] === 'string'
        ? [`${key} ${String(jump[key])}`]
        : [],
    )
    .join(' · ');
  return details ? `${type} · ${details}` : type;
}

export async function localScoreFromRemote(
  record: ScoreRecord,
  downloaded: Blob,
): Promise<LocalScore> {
  let blob = downloaded;
  let mimeType = record.contentType;
  if (isMusicXmlName(record.filename)) {
    const source = new File([downloaded], record.filename, { type: record.contentType });
    const xml = await readMusicXml(source);
    blob = new Blob([xml], { type: MUSIC_XML_MIME });
    mimeType = MUSIC_XML_MIME;
  }
  return localScoreWithMetadata(record, blob, mimeType);
}

function localScoreWithMetadata(record: ScoreRecord, blob: Blob, mimeType: string): LocalScore {
  return {
    id: record.id,
    repertoireItemId: record.repertoireId,
    name: record.filename,
    kind: record.kind,
    ...(record.instrument ? { instrument: record.instrument } : {}),
    mimeType,
    blob,
    updatedAt: record.updatedAt,
  };
}

export function mergeRemoteScoreMetadata(record: ScoreRecord, score: LocalScore): LocalScore {
  return localScoreWithMetadata(record, score.blob, score.mimeType);
}

function useObjectUrl(blob?: Blob) {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : undefined), [blob]);
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);
  return url;
}

function PdfPage({
  blob,
  pageNumber,
  onPageCount,
}: {
  blob: Blob;
  pageNumber: number;
  onPageCount: (count: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderError, setRenderError] = useState<string>();
  const [renderAttempt, setRenderAttempt] = useState(0);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let destroyLoadingTask: (() => Promise<void>) | undefined;
    void (async () => {
      try {
        const data = await blob.arrayBuffer();
        if (cancelled) return;
        const [{ GlobalWorkerOptions, getDocument }, pdfWorker] = await Promise.all([
          import('pdfjs-dist'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
        ]);
        if (cancelled) return;
        GlobalWorkerOptions.workerSrc = pdfWorker.default;
        const loadingTask = getDocument({ data });
        destroyLoadingTask = () => loadingTask.destroy();
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        onPageCount(pdf.numPages);
        const page = await pdf.getPage(Math.min(pageNumber, pdf.numPages));
        const base = page.getViewport({ scale: 1 });
        const width = canvas.parentElement?.clientWidth ?? 800;
        const viewport = page.getViewport({ scale: Math.min(2.5, width / base.width) });
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.round(viewport.width * ratio);
        canvas.height = Math.round(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext('2d');
        if (!context) return;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        if (!cancelled) setRenderError(undefined);
      } catch (error) {
        if (!cancelled) {
          setRenderError(error instanceof Error ? error.message : 'PDF를 렌더링하지 못했습니다.');
        }
      }
    })();
    return () => {
      cancelled = true;
      void destroyLoadingTask?.();
    };
  }, [blob, onPageCount, pageNumber, renderAttempt]);
  return (
    <>
      {renderError ? (
        <div className="score-render-error" role="alert">
          <strong>PDF 페이지를 표시하지 못했습니다.</strong>
          <span>{renderError}</span>
          <Button
            onClick={() => {
              setRenderError(undefined);
              setRenderAttempt((current) => current + 1);
            }}
          >
            다시 시도
          </Button>
        </div>
      ) : null}
      <canvas
        ref={canvasRef}
        className="score-canvas"
        aria-label={`PDF ${pageNumber}페이지`}
        hidden={Boolean(renderError)}
      />
    </>
  );
}

function MusicXmlPage({ blob }: { blob: Blob }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderError, setRenderError] = useState<string>();
  const [renderAttempt, setRenderAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void blob
      .text()
      .then(async (xml) => {
        if (!cancelled && containerRef.current) await renderMusicXml(containerRef.current, xml);
        if (!cancelled) setRenderError(undefined);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRenderError(
            error instanceof Error ? error.message : 'MusicXML을 렌더링하지 못했습니다.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [blob, renderAttempt]);
  return (
    <>
      {renderError ? (
        <div className="score-render-error" role="alert">
          <strong>MusicXML 악보를 표시하지 못했습니다.</strong>
          <span>{renderError}</span>
          <Button
            onClick={() => {
              setRenderError(undefined);
              setRenderAttempt((current) => current + 1);
            }}
          >
            다시 시도
          </Button>
        </div>
      ) : null}
      <div ref={containerRef} className="musicxml-sheet" hidden={Boolean(renderError)} />
    </>
  );
}

function ScoreSurface({
  score,
  page,
  onPageCount,
}: {
  score: LocalScore;
  page: number;
  onPageCount: (count: number) => void;
}) {
  const imageUrl = useObjectUrl(score.mimeType.startsWith('image/') ? score.blob : undefined);
  if (score.mimeType === 'application/pdf') {
    return <PdfPage blob={score.blob} pageNumber={page} onPageCount={onPageCount} />;
  }
  if (score.mimeType.includes('musicxml') || score.name.endsWith('.musicxml')) {
    return <MusicXmlPage blob={score.blob} />;
  }
  if (imageUrl) {
    return <img className="score-image" src={imageUrl} alt={score.name} draggable={false} />;
  }
  return <div className="unsupported-score">이 악보 형식은 미리보기를 지원하지 않습니다.</div>;
}

export function ScoresPage() {
  const { scoreId, repertoireItemId: routeRepertoireId } = useParams<{
    scoreId?: string;
    repertoireItemId?: string;
  }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { notify } = useToast();
  const { client, user } = useAuth();
  const queryString = searchParams.toString();
  const queryRepertoireId = searchParams.get('repertoire')?.trim() || undefined;
  const requestedMeasure = Number(searchParams.get('measure'));
  const initialMeasure =
    Number.isInteger(requestedMeasure) && requestedMeasure > 0 ? requestedMeasure : 1;
  const repertoireItemId = routeRepertoireId ?? queryRepertoireId;
  const activeRepertoireIdRef = useRef(repertoireItemId);
  const remoteMode = Boolean(user && repertoireItemId);
  const remoteCacheScope = useMemo(() => ({ userId: user?.id ?? '' }), [user?.id]);
  const inputRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const keyboardPartFocusIdRef = useRef<string | null>(null);
  const [selected, setSelected] = useState<LocalScore>();
  const activeScoreIdRef = useRef(scoreId);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [measureMap, setMeasureMap] = useState<LocalMeasureMap>();
  const [measureMapRevision, setMeasureMapRevision] = useState(0);
  const [annotations, setAnnotations] = useState<VersionedAnnotation[]>([]);
  const [currentMeasure, setCurrentMeasure] = useState(initialMeasure);
  const currentMeasureRef = useRef(initialMeasure);
  const [mode, setMode] = useState<AnnotationMode>('view');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [annotationScope, setAnnotationScope] = useState<AnnotationScope>('private');
  const [systemRect, setSystemRect] = useState<NormalizedRect>();
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>();
  const [activePenPoints, setActivePenPoints] = useState<PenPoint[]>([]);
  const activeSurfacePointerIdRef = useRef<number | null>(null);
  const [boundaries, setBoundaries] = useState<number[]>([]);
  const [firstMeasure, setFirstMeasure] = useState(1);
  const [keyboardRegion, setKeyboardRegion] = useState({ x: 10, y: 10, w: 80, h: 15 });
  const [annotationText, setAnnotationText] = useState('crescendo');
  const [practiceMarkers, setPracticeMarkers] = useState<PracticeAnchorMarker[]>([]);
  const [scoreKind, setScoreKind] = useState<'full' | 'part'>('full');
  const [instrument, setInstrument] = useState('');
  const [measureNumberOffset, setMeasureNumberOffset] = useState(0);
  const [pendingTempoDraft, setPendingTempoDraft] = useState<PendingTempoDraft>();
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [usingOfflineCache, setUsingOfflineCache] = useState(false);
  const [playbackMap, setPlaybackMap] = useState<TempoMap>(() => createDefaultTempoMap());
  const [playbackReady, setPlaybackReady] = useState(false);
  const [playbackNotice, setPlaybackNotice] = useState<{
    message: string;
    tone: 'warning' | 'danger';
  }>();
  const [uploading, setUploading] = useState(false);
  const [scoreLoadError, setScoreLoadError] = useState<string>();
  const [scoreDataWarnings, setScoreDataWarnings] = useState<string[]>([]);
  const [scoreReloadToken, setScoreReloadToken] = useState(0);
  const [autoPageFollowing, setAutoPageFollowing] = useState(true);
  const [scoreZoom, setScoreZoom] = useState(1);
  const metronome = useMetronome(playbackMap);

  useLayoutEffect(() => {
    activeScoreIdRef.current = scoreId;
  }, [scoreId]);

  useEffect(() => {
    const pendingScoreId = keyboardPartFocusIdRef.current;
    if (!pendingScoreId || pendingScoreId !== scoreId) return;
    const frame = window.requestAnimationFrame(() => {
      const tab = document.getElementById(`score-part-tab-${pendingScoreId}`);
      tab?.focus({ preventScroll: true });
      if (document.activeElement === tab) keyboardPartFocusIdRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scoreId]);

  useLayoutEffect(() => {
    activeRepertoireIdRef.current = repertoireItemId;
  }, [repertoireItemId]);

  const scorePath = useCallback(
    (nextScoreId?: string): string => {
      if (routeRepertoireId) {
        const root = `/repertoire/${encodeURIComponent(routeRepertoireId)}/scores`;
        return nextScoreId ? `${root}/${encodeURIComponent(nextScoreId)}` : root;
      }
      const root = nextScoreId ? `/scores/${encodeURIComponent(nextScoreId)}` : '/scores';
      if (!queryRepertoireId) return root;
      const params = new URLSearchParams(queryString);
      params.set('repertoire', queryRepertoireId);
      if (nextScoreId) params.set('measure', String(currentMeasureRef.current));
      return `${root}?${params.toString()}`;
    },
    [queryRepertoireId, queryString, routeRepertoireId],
  );

  const scores = useAsync<ScoreListItem[]>(async () => {
    if (remoteMode && repertoireItemId) {
      try {
        const records = await listRemoteScores(client, repertoireItemId);
        try {
          const remoteIds = new Set(records.map((record) => record.id));
          const cached = await localDb.listScores(repertoireItemId, remoteCacheScope);
          await Promise.all(
            cached
              .filter((score) => !remoteIds.has(score.id))
              .map((score) => localDb.deleteScore(score.id, remoteCacheScope)),
          );
        } catch (cacheError) {
          notify({
            title: '오프라인 악보 목록을 정리하지 못했습니다.',
            description: cacheError instanceof Error ? cacheError.message : String(cacheError),
            tone: 'info',
          });
        }
        return records.filter((score) => score.uploadStatus === 'ready').map(scoreListItem);
      } catch (error) {
        if (!isNetworkFailure(error)) throw error;
        const cached = await localDb.listScores(repertoireItemId, remoteCacheScope);
        if (cached.length) return cached.map(localScoreListItem);
        throw error;
      }
    }
    return (await localDb.listScores()).map(localScoreListItem);
  }, [client, notify, remoteCacheScope, remoteMode, repertoireItemId]);

  const repertoireAccess = useAsync<{ role: 'owner' | 'leader' | 'member' }>(
    async () =>
      remoteMode && repertoireItemId
        ? client.get(`/repertoire/${encodeURIComponent(repertoireItemId)}/access`)
        : { role: 'owner' },
    [client, remoteMode, repertoireItemId],
  );
  const canManageScores =
    !remoteMode ||
    repertoireAccess.data?.role === 'owner' ||
    repertoireAccess.data?.role === 'leader';

  useEffect(() => {
    let active = true;
    void (async () => {
      await Promise.resolve();
      if (!active) return;
      setPlaybackReady(false);
      setPlaybackNotice(undefined);
      try {
        if (remoteMode && repertoireItemId) {
          const response = await client.get<ServerTempoMap>(
            `/repertoire/${encodeURIComponent(repertoireItemId)}/tempomap`,
          );
          const data: unknown = response.data;
          assertValidTempoMap(data);
          const map = { ...data, repertoireItemId, revision: response.revision };
          if (!active) return;
          setPlaybackMap(map);
          setPlaybackReady(true);
          try {
            await localDb.putTempoMap(map, remoteCacheScope);
          } catch (cacheError) {
            if (active) {
              notify({
                title: '재생은 준비됐지만 템포맵 사본을 저장하지 못했습니다.',
                description: cacheError instanceof Error ? cacheError.message : String(cacheError),
                tone: 'info',
              });
            }
          }
          return;
        }
        if (!selected) return;
        const localMap = selected.tempoMapId
          ? await localDb.getTempoMap(selected.tempoMapId)
          : createDefaultTempoMap(selected.repertoireItemId);
        if (!active) return;
        if (!localMap) {
          setPlaybackNotice({
            message: '이 악보에 연결된 로컬 템포맵을 찾지 못했습니다.',
            tone: 'danger',
          });
          return;
        }
        setPlaybackMap(localMap);
        setPlaybackReady(true);
      } catch (error) {
        if (!active) return;
        if (!remoteMode || !repertoireItemId || !isNetworkFailure(error)) {
          setPlaybackNotice({
            message: error instanceof Error ? error.message : String(error),
            tone: 'danger',
          });
          return;
        }
        const cached = await localDb.getTempoMapForRepertoire(repertoireItemId, remoteCacheScope);
        if (!active) return;
        if (!cached) {
          setPlaybackNotice({
            message: '네트워크에 연결할 수 없고 저장된 템포맵도 없습니다.',
            tone: 'danger',
          });
          return;
        }
        setPlaybackMap(cached);
        setPlaybackReady(true);
        setPlaybackNotice({
          message: '네트워크에 연결할 수 없어 저장된 템포맵으로 재생합니다.',
          tone: 'warning',
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [client, notify, remoteCacheScope, remoteMode, repertoireItemId, scoreReloadToken, selected]);

  useEffect(() => {
    if (!Number.isInteger(requestedMeasure) || requestedMeasure < 1) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      currentMeasureRef.current = requestedMeasure;
      setCurrentMeasure(requestedMeasure);
      const scoreMeasure = scoreMeasureNumber(
        requestedMeasure,
        measureMap?.measureNumberOffset ?? 0,
      );
      const target = measureMap?.regions.find((region) => region.measureNumber === scoreMeasure);
      if (target) setPage(target.page);
    });
    return () => {
      active = false;
    };
  }, [measureMap, requestedMeasure]);

  useEffect(() => {
    if (!metronome.playing) return;
    const next = metronome.position.measureNumber;
    if (next === currentMeasureRef.current) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      currentMeasureRef.current = next;
      setCurrentMeasure(next);
      const scoreMeasure = scoreMeasureNumber(next, measureMap?.measureNumberOffset ?? 0);
      const target = measureMap?.regions.find((region) => region.measureNumber === scoreMeasure);
      if (target && autoPageFollowing) setPage(target.page);
    });
    return () => {
      active = false;
    };
  }, [autoPageFollowing, measureMap, metronome.playing, metronome.position.measureNumber]);

  useEffect(() => {
    let active = true;
    const requestedScoreId = scoreId;

    void (async () => {
      await Promise.resolve();
      if (!active) return;
      setSelected(undefined);
      setMeasureMap(undefined);
      setMeasureMapRevision(0);
      setAnnotations([]);
      setPracticeMarkers([]);
      setUsingOfflineCache(false);
      setSavingMetadata(false);
      setScoreLoadError(undefined);
      setScoreDataWarnings([]);
      setPage(1);
      setPageCount(1);
      setAutoPageFollowing(true);
      setScoreZoom(1);
      setSystemRect(undefined);
      setBoundaries([]);
      setFirstMeasure(1);
      if (!requestedScoreId) return;
      try {
        if (remoteMode && repertoireItemId) {
          const record = await getRemoteScore(client, requestedScoreId);
          if (record.repertoireId !== repertoireItemId) {
            throw new Error('이 악보는 현재 레퍼토리에 속하지 않습니다.');
          }
          const downloaded = await downloadScore(client, record);
          const score = await localScoreFromRemote(record, downloaded);
          const [mapResult, annotationResult] = await Promise.allSettled([
            getRemoteMeasureMap(client, requestedScoreId),
            listRepertoireAnnotations(client, repertoireItemId),
          ]);
          if (!active) return;
          const warnings: string[] = [];
          const useCachedMap =
            mapResult.status === 'rejected' && isNetworkFailure(mapResult.reason);
          const remoteMap =
            mapResult.status === 'fulfilled'
              ? mapResult.value
              : useCachedMap
                ? await localDb
                    .getMeasureMap(requestedScoreId, remoteCacheScope)
                    .then((map) => (map ? { map, revision: 0 } : undefined))
                : undefined;
          if (mapResult.status === 'rejected') {
            warnings.push(
              useCachedMap
                ? '마디 맵을 갱신하지 못해 저장된 사본을 표시합니다.'
                : '마디 맵을 불러오지 못해 이번 화면에서는 표시하지 않습니다.',
            );
          }
          const useCachedAnnotations =
            annotationResult.status === 'rejected' && isNetworkFailure(annotationResult.reason);
          const notes =
            annotationResult.status === 'fulfilled'
              ? annotationResult.value
              : useCachedAnnotations
                ? (
                    await Promise.all(
                      (scores.data ?? [{ id: requestedScoreId }]).map((item) =>
                        localDb.listAnnotations(item.id, remoteCacheScope),
                      ),
                    )
                  ).flat()
                : [];
          if (annotationResult.status === 'rejected') {
            warnings.push(
              useCachedAnnotations
                ? '필기를 갱신하지 못해 저장된 사본을 표시합니다.'
                : '필기를 불러오지 못해 이번 화면에서는 표시하지 않습니다.',
            );
          }
          try {
            const cacheOperations: Promise<void>[] = [localDb.putScore(score, remoteCacheScope)];
            if (mapResult.status === 'fulfilled') {
              cacheOperations.push(
                remoteMap
                  ? localDb.putMeasureMap(remoteMap.map, remoteCacheScope)
                  : localDb.deleteMeasureMap(score.id, remoteCacheScope),
              );
            }
            if (annotationResult.status === 'fulfilled') {
              const scoreIds = new Set([
                requestedScoreId,
                ...(scores.data ?? []).map((item) => item.id),
                ...notes.map((note) => note.scoreId),
              ]);
              cacheOperations.push(
                ...[...scoreIds].map((id) =>
                  localDb.replaceAnnotations(
                    id,
                    notes.filter((note) => note.scoreId === id),
                    remoteCacheScope,
                  ),
                ),
              );
            }
            await Promise.all(cacheOperations);
          } catch (cacheError) {
            notify({
              title: '오프라인 사본을 갱신하지 못했습니다.',
              description: cacheError instanceof Error ? cacheError.message : String(cacheError),
              tone: 'info',
            });
          }
          if (!active) return;
          setUsingOfflineCache(useCachedMap || useCachedAnnotations);
          setSelected(score);
          setScoreKind(record.kind);
          setInstrument(record.instrument);
          setMeasureMap(remoteMap?.map);
          setFirstMeasure(nextMeasureNumber(remoteMap?.map));
          setMeasureMapRevision(remoteMap?.revision ?? 0);
          setMeasureNumberOffset(remoteMap?.map.measureNumberOffset ?? 0);
          setAnnotations(notes);
          setScoreDataWarnings(warnings);
          setPage(
            remoteMap?.map.regions.find(
              (region) =>
                canonicalMeasureNumber(region.measureNumber, remoteMap.map.measureNumberOffset) ===
                currentMeasureRef.current,
            )?.page ?? 1,
          );
          return;
        }
        const score = await localDb.getScore(requestedScoreId);
        if (!score) throw new Error('로컬 악보를 찾지 못했습니다.');
        const [map, annotationGroups] = await Promise.all([
          localDb.getMeasureMap(score.id),
          Promise.all(
            (scores.data ?? [{ id: score.id }]).map((item) => localDb.listAnnotations(item.id)),
          ),
        ]);
        const notes = annotationGroups.flat();
        if (!active) return;
        setSelected(score);
        setScoreKind(score.kind);
        setInstrument(score.instrument ?? '');
        setMeasureMap(map);
        setFirstMeasure(nextMeasureNumber(map));
        setMeasureNumberOffset(map?.measureNumberOffset ?? 0);
        setAnnotations(notes);
        setPage(
          map?.regions.find(
            (region) =>
              canonicalMeasureNumber(region.measureNumber, map.measureNumberOffset) ===
              currentMeasureRef.current,
          )?.page ?? 1,
        );
      } catch (error) {
        if (!active) return;
        if (
          remoteMode &&
          requestedScoreId &&
          error instanceof ApiError &&
          (error.status === 403 || error.status === 404)
        ) {
          await localDb.deleteScore(requestedScoreId, remoteCacheScope);
        }
        if (remoteMode && requestedScoreId && isNetworkFailure(error)) {
          const cached = await localDb.getScore(requestedScoreId, remoteCacheScope);
          if (cached) {
            const [map, annotationGroups] = await Promise.all([
              localDb.getMeasureMap(cached.id, remoteCacheScope),
              Promise.all(
                (scores.data ?? [{ id: cached.id }]).map((item) =>
                  localDb.listAnnotations(item.id, remoteCacheScope),
                ),
              ),
            ]);
            const notes = annotationGroups.flat();
            if (!active) return;
            setSelected(cached);
            setScoreKind(cached.kind);
            setInstrument(cached.instrument ?? '');
            setMeasureMap(map);
            setFirstMeasure(nextMeasureNumber(map));
            setMeasureNumberOffset(map?.measureNumberOffset ?? 0);
            setAnnotations(notes);
            setUsingOfflineCache(true);
            setMode('view');
            setPage(
              map?.regions.find(
                (region) =>
                  canonicalMeasureNumber(region.measureNumber, map.measureNumberOffset) ===
                  currentMeasureRef.current,
              )?.page ?? 1,
            );
            notify({
              title: '저장된 오프라인 악보를 열었습니다.',
              description: '네트워크가 복구될 때까지 서버 필기와 마디 맵 수정은 잠깁니다.',
              tone: 'info',
            });
            return;
          }
        }
        setScoreLoadError(error instanceof Error ? error.message : String(error));
        notify({
          title: '악보를 불러오지 못했습니다.',
          description: error instanceof Error ? error.message : String(error),
          tone: 'danger',
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [
    client,
    notify,
    remoteCacheScope,
    remoteMode,
    repertoireItemId,
    scoreId,
    scoreReloadToken,
    scores.data,
  ]);

  useEffect(() => {
    let active = true;
    if (!selected) return;
    void (async () => {
      try {
        let markers: PracticeAnchorMarker[];
        if (remoteMode && repertoireItemId) {
          let logs;
          if (usingOfflineCache) {
            logs = await localDb.getPracticeLogs(repertoireItemId, remoteCacheScope);
          } else {
            try {
              logs = await listPracticeLogs(client, repertoireItemId);
              await localDb.putPracticeLogs(repertoireItemId, logs, remoteCacheScope);
            } catch (error) {
              if (!isNetworkFailure(error)) throw error;
              logs = await localDb.getPracticeLogs(repertoireItemId, remoteCacheScope);
            }
          }
          markers = practiceAnchorMarkers(logs, selected.id);
        } else {
          markers = localPracticeMarkers(
            repertoireItemId ?? selected.repertoireItemId,
            selected.id,
          );
        }
        if (active) setPracticeMarkers(markers);
      } catch (error) {
        if (!active) return;
        setPracticeMarkers([]);
        notify({
          title: '연습일지 앵커를 불러오지 못했습니다.',
          description: error instanceof Error ? error.message : String(error),
          tone: 'danger',
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [client, notify, remoteCacheScope, remoteMode, repertoireItemId, selected, usingOfflineCache]);

  useEffect(() => {
    const first = scores.data?.[0];
    if (scoreId || scores.loading || !first) return;
    if (repertoireItemId && first.repertoireItemId !== repertoireItemId) return;
    void navigate(scorePath(first.id), { replace: true });
  }, [navigate, repertoireItemId, scoreId, scorePath, scores.data, scores.loading]);

  useEffect(() => {
    if (!scores.error) return;
    notify({
      title: remoteMode
        ? '서버 악보 목록을 불러오지 못했습니다.'
        : '로컬 악보 목록을 불러오지 못했습니다.',
      description: scores.error.message,
      tone: 'danger',
    });
  }, [notify, remoteMode, scores.error]);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      if (remoteMode && !canManageScores) {
        throw new Error('리더 이상만 프로젝트 악보를 업로드할 수 있습니다.');
      }
      if (file.size <= 0) throw new Error('빈 파일은 올릴 수 없습니다.');
      let mimeType = scoreContentType(file);
      let storedBlob: Blob = file;
      let localTempoMapId: string | undefined;
      let remoteTempoDraft: PendingTempoDraft | undefined;
      if (!supportsScore(file, mimeType)) {
        throw new Error('PDF, 이미지, MusicXML(.musicxml/.mxl)만 올릴 수 있습니다.');
      }
      if (
        remoteMode &&
        isMusicXmlName(file.name) &&
        pendingTempoDraft &&
        !window.confirm('검토 중인 MusicXML 초안을 새 파일로 바꿀까요?')
      ) {
        return;
      }
      if (isMusicXmlName(file.name)) {
        if (remoteMode && repertoireItemId) {
          const targetRepertoireId = repertoireItemId;
          const draft = await createMusicXmlDraft(client, targetRepertoireId, file);
          if (activeRepertoireIdRef.current !== targetRepertoireId) return;
          remoteTempoDraft = {
            draft,
            filename: file.name,
            repertoireItemId: targetRepertoireId,
          };
        } else {
          const xml = await readMusicXml(file);
          const draft = musicXmlToTempoMap(xml, file.name.replace(/\.[^.]+$/, ''));
          await localDb.putTempoMap(draft);
          localTempoMapId = draft.id;
          storedBlob = new Blob([xml], { type: MUSIC_XML_MIME });
          mimeType = MUSIC_XML_MIME;
          notify({
            title: 'MusicXML에서 템포맵 초안을 만들었습니다.',
            description: `${draft.totalMeasures}마디와 ${draft.sections.length}개 구간을 인식했습니다.`,
            tone: 'success',
          });
        }
      }
      const kind = scores.data?.length ? 'part' : 'full';
      if (remoteMode && repertoireItemId) {
        const score = await uploadScore(client, repertoireItemId, file, {
          contentType: mimeType,
          kind,
        });
        if (activeRepertoireIdRef.current !== repertoireItemId) return;
        if (
          remoteTempoDraft &&
          activeRepertoireIdRef.current === remoteTempoDraft.repertoireItemId
        ) {
          setPendingTempoDraft(remoteTempoDraft);
          notify({
            title: '서버에서 MusicXML 템포맵 초안을 만들었습니다.',
            description: `${remoteTempoDraft.draft.totalMeasures}마디와 ${remoteTempoDraft.draft.sections.length}개 구간을 인식했습니다. 검토 후 템포맵으로 저장하세요.${remoteTempoDraft.draft.warnings.length ? ` 경고 ${remoteTempoDraft.draft.warnings.length}건` : ''}`,
            tone: 'success',
          });
        }
        scores.reload();
        void navigate(scorePath(score.id));
        notify({ title: '악보를 서버에 저장했습니다.', tone: 'success' });
        return;
      }
      const score: LocalScore = {
        id: crypto.randomUUID(),
        repertoireItemId: 'local',
        name: file.name,
        kind,
        mimeType,
        blob: storedBlob,
        ...(localTempoMapId ? { tempoMapId: localTempoMapId } : {}),
        updatedAt: new Date().toISOString(),
      };
      await localDb.putScore(score);
      scores.reload();
      void navigate(scorePath(score.id));
    } catch (error) {
      notify({
        title: '악보를 가져오지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  }

  const pointerPosition = (event: ReactPointerEvent): { x: number; y: number } => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    };
  };

  const scoreSurfaceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && mode !== 'view') {
      event.preventDefault();
      setMode('view');
      return;
    }
    if ((mode === 'text' || mode === 'stamp') && event.key === 'Enter') {
      event.preventDefault();
      void saveAnnotation({ x: 0.5, y: 0.5 }, 'measure');
      return;
    }
    if (mode !== 'view' || !measureMap) return;
    const measures = [...new Set(measureMap.regions.map((region) => region.measureNumber))]
      .flatMap((measureNumber) => {
        const canonical = canonicalMeasureNumber(measureNumber, measureMap.measureNumberOffset);
        return canonical === undefined
          ? []
          : [
              {
                measureNumber,
                canonical,
                page: measureMap.regions.find((region) => region.measureNumber === measureNumber)
                  ?.page,
              },
            ];
      })
      .sort((left, right) => left.canonical - right.canonical);
    const currentIndex = measures.findIndex((entry) => entry.canonical >= currentMeasure);
    const targetIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? measures.length - 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? Math.max(0, (currentIndex < 0 ? measures.length : currentIndex) - 1)
            : event.key === 'ArrowRight' || event.key === 'ArrowDown'
              ? Math.min(measures.length - 1, Math.max(0, currentIndex + 1))
              : -1;
    const target = measures[targetIndex];
    if (!target) return;
    event.preventDefault();
    void selectCanonicalMeasure(target.canonical, target.page);
  };

  const pointerDown = (event: ReactPointerEvent) => {
    if (activeSurfacePointerIdRef.current !== null) return;
    if (mode === 'system') {
      event.preventDefault();
      activeSurfacePointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragStart(pointerPosition(event));
      return;
    }
    if (mode === 'pen') {
      event.preventDefault();
      activeSurfacePointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      setActivePenPoints([pointerPosition(event)]);
    }
  };

  const pointerMove = (event: ReactPointerEvent) => {
    if (
      mode !== 'pen' ||
      activeSurfacePointerIdRef.current !== event.pointerId ||
      !event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      return;
    }
    const point = pointerPosition(event);
    setActivePenPoints((current) => {
      const previous = current.at(-1);
      if (previous && Math.hypot(previous.x - point.x, previous.y - point.y) < 0.002) {
        return current;
      }
      return [...current, point];
    });
  };

  async function updateOfflineCopy(operation: Promise<void>, description: string): Promise<void> {
    try {
      await operation;
    } catch (error) {
      notify({
        title: '서버 저장은 완료됐지만 오프라인 사본을 갱신하지 못했습니다.',
        description: `${description}: ${error instanceof Error ? error.message : String(error)}`,
        tone: 'info',
      });
    }
  }

  async function refreshScoreSettingsAfterConflict(targetScore: LocalScore): Promise<boolean> {
    const [latestRecord, latestMap] = await Promise.all([
      getRemoteScore(client, targetScore.id),
      getRemoteMeasureMap(client, targetScore.id),
    ]);
    const latestScore = mergeRemoteScoreMetadata(latestRecord, targetScore);
    await updateOfflineCopy(
      Promise.all([
        localDb.putScore(latestScore, remoteCacheScope),
        latestMap
          ? localDb.putMeasureMap(latestMap.map, remoteCacheScope)
          : localDb.deleteMeasureMap(targetScore.id, remoteCacheScope),
      ]).then(() => undefined),
      '최신 악보 정보',
    );
    if (activeScoreIdRef.current !== targetScore.id) return false;
    setSelected(latestScore);
    setScoreKind(latestRecord.kind);
    setInstrument(latestRecord.instrument);
    setMeasureMap(latestMap?.map);
    setMeasureMapRevision(latestMap?.revision ?? 0);
    setMeasureNumberOffset(latestMap?.map.measureNumberOffset ?? 0);
    setFirstMeasure(nextMeasureNumber(latestMap?.map));
    scores.reload();
    return true;
  }

  async function saveAnnotation(
    point: { x: number; y: number },
    anchorType: 'page' | 'measure' = 'page',
  ): Promise<void> {
    if ((mode !== 'text' && mode !== 'stamp') || !selected || usingOfflineCache) return;
    const targetScore = selected;
    const editableNearby = annotations.find((annotation) => {
      if (
        annotation.scoreId !== targetScore.id ||
        annotation.kind !== mode ||
        annotation.page !== page ||
        annotation.scope !== annotationScope
      )
        return false;
      if ((annotation.payload.anchorType ?? 'page') !== anchorType) return false;
      if (anchorType === 'measure' && annotation.measureNumber !== currentMeasure) return false;
      if (remoteMode && annotation.authorId !== user?.id) return false;
      const x = Number(annotation.payload.x);
      const y = Number(annotation.payload.y);
      return (
        Number.isFinite(x) && Number.isFinite(y) && Math.hypot(x - point.x, y - point.y) < 0.035
      );
    });
    const annotation: VersionedAnnotation = editableNearby
      ? {
          ...editableNearby,
          measureNumber: currentMeasure,
          payload: { x: point.x, y: point.y, text: annotationText, anchorType },
          updatedAt: new Date().toISOString(),
        }
      : {
          id: crypto.randomUUID(),
          scoreId: targetScore.id,
          scope: annotationScope,
          kind: mode,
          page,
          measureNumber: currentMeasure,
          payload: { x: point.x, y: point.y, text: annotationText, anchorType },
          updatedAt: new Date().toISOString(),
        };
    try {
      if (remoteMode) {
        const saved = editableNearby
          ? await updateAnnotation(client, annotation)
          : await createAnnotation(client, annotation);
        await updateOfflineCopy(localDb.putAnnotation(saved, remoteCacheScope), '필기');
        if (activeScoreIdRef.current !== targetScore.id) return;
        setAnnotations((current) =>
          editableNearby
            ? current.map((item) => (item.id === saved.id ? saved : item))
            : [...current, saved],
        );
        return;
      }
      await localDb.putAnnotation(annotation);
      if (activeScoreIdRef.current !== targetScore.id) return;
      setAnnotations((current) =>
        editableNearby
          ? current.map((item) => (item.id === annotation.id ? annotation : item))
          : [...current, annotation],
      );
    } catch (error) {
      if (activeScoreIdRef.current !== targetScore.id) return;
      if (remoteMode && error instanceof ApiError && error.status === 409) {
        try {
          const latest = await listRepertoireAnnotations(client, targetScore.repertoireItemId);
          const scoreIds = new Set([
            ...(scores.data ?? []).map((score) => score.id),
            ...latest.map((annotation) => annotation.scoreId),
          ]);
          scoreIds.add(targetScore.id);
          await updateOfflineCopy(
            Promise.all(
              [...scoreIds].map((id) =>
                localDb.replaceAnnotations(
                  id,
                  latest.filter((annotation) => annotation.scoreId === id),
                  remoteCacheScope,
                ),
              ),
            ).then(() => undefined),
            '필기 목록',
          );
          if (activeScoreIdRef.current !== targetScore.id) return;
          setAnnotations(latest);
          notify({
            title: '필기가 다른 곳에서 수정되었습니다.',
            description: `최신 목록을 불러왔습니다. 서버 revision ${error.payload.actualRevision ?? '확인 필요'}`,
            tone: 'danger',
          });
        } catch (reloadError) {
          notify({
            title: '필기 충돌 후 최신 목록을 불러오지 못했습니다.',
            description: reloadError instanceof Error ? reloadError.message : String(reloadError),
            tone: 'danger',
          });
        }
        return;
      }
      notify({
        title: '필기를 저장하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  }

  async function savePenAnnotation(points: PenPoint[]): Promise<void> {
    if (!selected || points.length < 2 || usingOfflineCache) return;
    const targetScore = selected;
    const annotation: VersionedAnnotation = {
      id: crypto.randomUUID(),
      scoreId: targetScore.id,
      scope: annotationScope,
      kind: 'pen',
      page,
      measureNumber: currentMeasure,
      payload: { points },
      updatedAt: new Date().toISOString(),
    };
    try {
      let saved: VersionedAnnotation = annotation;
      if (remoteMode) saved = await createAnnotation(client, annotation);
      else await localDb.putAnnotation(annotation);
      if (remoteMode)
        await updateOfflineCopy(localDb.putAnnotation(saved, remoteCacheScope), '펜 필기');
      if (activeScoreIdRef.current !== targetScore.id) return;
      setAnnotations((current) => [...current, saved]);
    } catch (error) {
      if (activeScoreIdRef.current !== targetScore.id) return;
      if (remoteMode && error instanceof ApiError && error.status === 409) {
        try {
          if (!(await refreshScoreSettingsAfterConflict(targetScore))) return;
        } catch (reloadError) {
          notify({
            title: '마디 맵 충돌 후 최신 정보를 불러오지 못했습니다.',
            description: reloadError instanceof Error ? reloadError.message : String(reloadError),
            tone: 'danger',
          });
          return;
        }
      }
      notify({
        title: '펜 필기를 저장하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  }

  async function removeAnnotation(annotation: VersionedAnnotation): Promise<void> {
    if (!selected || annotation.scoreId !== selected.id || usingOfflineCache) return;
    if (remoteMode && annotation.authorId !== user?.id && !canManageScores) return;
    const label =
      typeof annotation.payload.text === 'string'
        ? annotation.payload.text
        : annotation.kind === 'pen'
          ? '펜 스트로크'
          : '필기';
    if (!window.confirm(`“${label}”을(를) 삭제할까요?`)) return;
    const targetScore = selected;
    try {
      if (remoteMode) {
        await deleteRemoteAnnotation(client, annotation.id);
        await updateOfflineCopy(
          localDb.deleteAnnotation(annotation.id, remoteCacheScope),
          '삭제한 필기',
        );
      } else {
        await localDb.deleteAnnotation(annotation.id);
      }
      if (activeScoreIdRef.current !== targetScore.id) return;
      setAnnotations((current) => current.filter((item) => item.id !== annotation.id));
      notify({ title: '필기를 삭제했습니다.', tone: 'success' });
    } catch (error) {
      if (activeScoreIdRef.current !== targetScore.id) return;
      notify({
        title: '필기를 삭제하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  }

  const pointerUp = (event: ReactPointerEvent) => {
    if (
      (mode === 'pen' || mode === 'system') &&
      activeSurfacePointerIdRef.current !== event.pointerId
    ) {
      return;
    }
    const point = pointerPosition(event);
    if (
      activeSurfacePointerIdRef.current === event.pointerId &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (activeSurfacePointerIdRef.current === event.pointerId) {
      activeSurfacePointerIdRef.current = null;
    }
    if (mode === 'pen') {
      const points = [...activePenPoints, point];
      setActivePenPoints([]);
      void savePenAnnotation(points);
      return;
    }
    if (mode === 'view') {
      const target = measureMap?.regions.find(
        (region) =>
          region.page === page &&
          point.x >= region.rect.x &&
          point.x <= region.rect.x + region.rect.w &&
          point.y >= region.rect.y &&
          point.y <= region.rect.y + region.rect.h,
      );
      if (target) {
        const canonical = canonicalMeasureNumber(
          target.measureNumber,
          measureMap?.measureNumberOffset ?? 0,
        );
        if (canonical !== undefined) void selectCanonicalMeasure(canonical, target.page);
      }
      return;
    }
    if (mode === 'system' && dragStart) {
      const rect = {
        x: Math.min(point.x, dragStart.x),
        y: Math.min(point.y, dragStart.y),
        w: Math.abs(point.x - dragStart.x),
        h: Math.abs(point.y - dragStart.y),
      };
      if (rect.w > 0.03 && rect.h > 0.02) {
        setSystemRect(rect);
        setBoundaries([]);
        setMode('boundaries');
      }
      setDragStart(undefined);
      return;
    }
    if (mode === 'boundaries' && systemRect) {
      const relative = (point.x - systemRect.x) / systemRect.w;
      if (relative > 0.02 && relative < 0.98) {
        setBoundaries((current) => {
          const nearby = current.findIndex((boundary) => Math.abs(boundary - relative) < 0.015);
          if (nearby >= 0) return current.filter((_, index) => index !== nearby);
          return [...current, relative].sort((a, b) => a - b);
        });
      }
      return;
    }
    if ((mode === 'text' || mode === 'stamp') && selected) {
      void saveAnnotation(point);
    }
  };

  const pointerCancel = (event: ReactPointerEvent) => {
    if (activeSurfacePointerIdRef.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activeSurfacePointerIdRef.current = null;
    setDragStart(undefined);
    setActivePenPoints([]);
  };

  const finishSystem = async () => {
    if (!selected || !systemRect || usingOfflineCache || !canManageScores) return;
    const targetScore = selected;
    const normalizedFirstMeasure = Math.max(1, Math.trunc(firstMeasure));
    const cuts = [0, ...boundaries, 1];
    const regions = cuts.slice(0, -1).map((start, index) => {
      const end = cuts[index + 1] ?? 1;
      return {
        id: crypto.randomUUID(),
        page,
        measureNumber: normalizedFirstMeasure + index,
        rect: {
          x: systemRect.x + systemRect.w * start,
          y: systemRect.y,
          w: systemRect.w * (end - start),
          h: systemRect.h,
        },
      };
    });
    const next: LocalMeasureMap = {
      scoreId: targetScore.id,
      measureNumberOffset: measureMap?.measureNumberOffset ?? 0,
      regions: [...(measureMap?.regions ?? []), ...regions],
      updatedAt: new Date().toISOString(),
    };
    try {
      if (remoteMode) {
        const saved = await putRemoteMeasureMap(client, next, measureMapRevision);
        await updateOfflineCopy(localDb.putMeasureMap(saved.map, remoteCacheScope), '마디 맵');
        if (activeScoreIdRef.current !== targetScore.id) return;
        setMeasureMap(saved.map);
        setMeasureMapRevision(saved.revision);
      } else {
        await localDb.putMeasureMap(next);
        if (activeScoreIdRef.current !== targetScore.id) return;
        setMeasureMap(next);
      }
      setFirstMeasure(nextMeasureNumber(next));
      setSystemRect(undefined);
      setBoundaries([]);
      setMode('system');
      notify({ title: `${regions.length}개 마디를 매핑했습니다.`, tone: 'success' });
    } catch (error) {
      if (activeScoreIdRef.current !== targetScore.id) return;
      if (remoteMode && error instanceof ApiError && error.status === 409) {
        try {
          if (!(await refreshScoreSettingsAfterConflict(targetScore))) return;
          notify({
            title: '마디 맵이 다른 곳에서 수정되었습니다.',
            description: `최신 맵을 불러왔습니다. 서버 revision ${error.payload.actualRevision ?? '확인 필요'}`,
            tone: 'danger',
          });
        } catch (reloadError) {
          notify({
            title: '마디 맵 충돌 후 최신 맵을 불러오지 못했습니다.',
            description: reloadError instanceof Error ? reloadError.message : String(reloadError),
            tone: 'danger',
          });
        }
        return;
      }
      notify({
        title: '마디 맵을 저장하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  };

  const addKeyboardRegion = async () => {
    if (!selected || usingOfflineCache || !canManageScores) return;
    const targetScore = selected;
    const rect = {
      x: keyboardRegion.x / 100,
      y: keyboardRegion.y / 100,
      w: keyboardRegion.w / 100,
      h: keyboardRegion.h / 100,
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
      notify({
        title: '마디 영역 값을 확인해 주세요.',
        description: '위치와 크기는 0~100% 안에서 페이지를 벗어나지 않아야 합니다.',
        tone: 'danger',
      });
      return;
    }
    const measureNumber = Math.max(1, Math.trunc(firstMeasure));
    const next: LocalMeasureMap = {
      scoreId: targetScore.id,
      measureNumberOffset: measureMap?.measureNumberOffset ?? 0,
      regions: [
        ...(measureMap?.regions ?? []),
        { id: crypto.randomUUID(), page, measureNumber, rect },
      ],
      updatedAt: new Date().toISOString(),
    };
    try {
      if (remoteMode) {
        const saved = await putRemoteMeasureMap(client, next, measureMapRevision);
        await updateOfflineCopy(localDb.putMeasureMap(saved.map, remoteCacheScope), '마디 맵');
        if (activeScoreIdRef.current !== targetScore.id) return;
        setMeasureMap(saved.map);
        setMeasureMapRevision(saved.revision);
      } else {
        await localDb.putMeasureMap(next);
        if (activeScoreIdRef.current !== targetScore.id) return;
        setMeasureMap(next);
      }
      setFirstMeasure(nextMeasureNumber(next));
      notify({ title: `${measureNumber}마디 영역을 추가했습니다.`, tone: 'success' });
    } catch (error) {
      if (activeScoreIdRef.current !== targetScore.id) return;
      if (remoteMode && error instanceof ApiError && error.status === 409) {
        try {
          if (!(await refreshScoreSettingsAfterConflict(targetScore))) return;
        } catch (reloadError) {
          notify({
            title: '마디 맵 충돌 후 최신 정보를 불러오지 못했습니다.',
            description: reloadError instanceof Error ? reloadError.message : String(reloadError),
            tone: 'danger',
          });
          return;
        }
      }
      notify({
        title: '마디 영역을 저장하지 못했습니다.',
        description:
          error instanceof ApiError && error.status === 409
            ? '다른 사용자가 마디 맵을 수정했습니다. 다시 동기화해 주세요.'
            : error instanceof Error
              ? error.message
              : String(error),
        tone: 'danger',
      });
    }
  };

  const saveMetadata = async () => {
    if (!selected || usingOfflineCache || !canManageScores) return;
    const targetScore = selected;
    const offset = Math.trunc(measureNumberOffset);
    const nextScore: LocalScore = {
      ...targetScore,
      kind: scoreKind,
      updatedAt: new Date().toISOString(),
    };
    if (instrument.trim()) nextScore.instrument = instrument.trim();
    else delete nextScore.instrument;
    const nextMap: LocalMeasureMap = {
      scoreId: targetScore.id,
      measureNumberOffset: offset,
      regions: measureMap?.regions ?? [],
      updatedAt: new Date().toISOString(),
    };
    setSavingMetadata(true);
    try {
      if (remoteMode) {
        const saved = await updateScoreSettings(client, targetScore.id, {
          kind: scoreKind,
          instrument: instrument.trim(),
          measureMap: nextMap,
          expectedMeasureMapRevision: measureMapRevision,
        });
        const savedScore = mergeRemoteScoreMetadata(saved.score, targetScore);
        await updateOfflineCopy(
          Promise.all([
            localDb.putScore(savedScore, remoteCacheScope),
            localDb.putMeasureMap(saved.measureMap.map, remoteCacheScope),
          ]).then(() => undefined),
          '악보 정보',
        );
        if (activeScoreIdRef.current !== targetScore.id) return;
        setSelected(savedScore);
        setMeasureMap(saved.measureMap.map);
        setFirstMeasure(nextMeasureNumber(saved.measureMap.map));
        setMeasureMapRevision(saved.measureMap.revision);
      } else {
        await Promise.all([localDb.putScore(nextScore), localDb.putMeasureMap(nextMap)]);
        if (activeScoreIdRef.current !== targetScore.id) return;
        setSelected(nextScore);
        setMeasureMap(nextMap);
        setFirstMeasure(nextMeasureNumber(nextMap));
      }
      setMeasureNumberOffset(offset);
      scores.reload();
      notify({ title: '악보 정보와 마디 번호 보정을 저장했습니다.', tone: 'success' });
    } catch (error) {
      if (activeScoreIdRef.current !== targetScore.id) return;
      if (remoteMode && error instanceof ApiError && error.status === 409) {
        try {
          await refreshScoreSettingsAfterConflict(targetScore);
        } catch (reloadError) {
          notify({
            title: '충돌 후 최신 악보 정보를 불러오지 못했습니다.',
            description: reloadError instanceof Error ? reloadError.message : String(reloadError),
            tone: 'danger',
          });
          return;
        }
      }
      notify({
        title: '악보 정보를 저장하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      if (activeScoreIdRef.current === targetScore.id) setSavingMetadata(false);
    }
  };

  const savePendingTempoDraft = async () => {
    if (!pendingTempoDraft || pendingTempoDraft.repertoireItemId !== repertoireItemId) return;
    const targetDraft = pendingTempoDraft;
    const targetRepertoireId = targetDraft.repertoireItemId;
    setSavingDraft(true);
    try {
      let current: ServerTempoMap | undefined;
      try {
        current = await client.get<ServerTempoMap>(
          `/repertoire/${encodeURIComponent(targetRepertoireId)}/tempomap`,
        );
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
      const map = tempoMapFromMusicXmlDraft(
        targetDraft.draft,
        targetRepertoireId,
        current?.revision ?? 0,
        current?.data.id ?? crypto.randomUUID(),
      );
      const response = await client.put<ServerTempoMap>(
        `/repertoire/${encodeURIComponent(targetRepertoireId)}/tempomap`,
        { expectedRevision: current?.revision ?? 0, data: map },
      );
      const data: unknown = response.data;
      assertValidTempoMap(data);
      const saved = { ...data, repertoireItemId: targetRepertoireId, revision: response.revision };
      await localDb.putTempoMap(saved, remoteCacheScope);
      if (activeRepertoireIdRef.current !== targetRepertoireId) return;
      setPlaybackMap(saved);
      setPlaybackReady(true);
      setPendingTempoDraft((current) => (current === targetDraft ? undefined : current));
      notify({ title: 'MusicXML 초안을 템포맵으로 저장했습니다.', tone: 'success' });
    } catch (error) {
      notify({
        title: 'MusicXML 템포맵 초안을 저장하지 못했습니다.',
        description:
          error instanceof ApiError && error.status === 409
            ? '다른 사용자가 템포맵을 먼저 수정했습니다. 초안을 다시 검토해 주세요.'
            : error instanceof Error
              ? error.message
              : String(error),
        tone: 'danger',
      });
    } finally {
      setSavingDraft(false);
    }
  };

  const togglePlayback = async () => {
    if (metronome.playing) {
      metronome.stop();
      return;
    }
    try {
      await metronome.start(currentMeasure, 1, true);
    } catch (error) {
      notify({
        title: '악보 재생을 시작하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  };

  async function selectCanonicalMeasure(canonical: number, targetPage?: number): Promise<void> {
    currentMeasureRef.current = canonical;
    setCurrentMeasure(canonical);
    if (targetPage !== undefined) setPage(targetPage);
    if (!metronome.playing) return;
    try {
      await metronome.start(canonical, 1, false);
    } catch (error) {
      notify({
        title: '선택한 마디로 이동하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  }

  const visibleRegions =
    measureMap && selected && measureMap.scoreId === selected.id
      ? measureMap.regions.filter((region) => region.page === page)
      : [];
  const visibleAnnotations = annotations.filter(
    (annotation) =>
      annotation.scoreId === selected?.id &&
      annotation.page === page &&
      annotation.payload.anchorType !== 'measure',
  );
  const visibleMeasureAnnotations = annotations.flatMap((annotation) => {
    if (
      annotation.payload.anchorType !== 'measure' ||
      annotation.measureNumber === undefined ||
      (annotation.kind !== 'text' && annotation.kind !== 'stamp')
    ) {
      return [];
    }
    const scoreMeasure = scoreMeasureNumber(
      annotation.measureNumber,
      measureMap?.measureNumberOffset ?? 0,
    );
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
  const visibleEditableAnnotations = [
    ...visibleAnnotations,
    ...visibleMeasureAnnotations
      .filter(({ annotation }) => annotation.scoreId === selected?.id)
      .map(({ annotation }) => annotation),
  ];
  const currentPracticeMarkers = practiceMarkers.filter(
    (marker) => marker.measureNumber === currentMeasure,
  );
  const visiblePracticeMarkers = practiceMarkers.flatMap((marker) => {
    if (
      marker.scoreId === selected?.id &&
      marker.page === page &&
      marker.x !== undefined &&
      marker.y !== undefined
    ) {
      return [{ marker, x: marker.x, y: marker.y }];
    }
    if (marker.measureNumber === undefined) return [];
    const scoreMeasure = scoreMeasureNumber(
      marker.measureNumber,
      measureMap?.measureNumberOffset ?? 0,
    );
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
  const parts = scores.data ?? [];
  const selectPartFromKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    const lastIndex = parts.length - 1;
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? lastIndex
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? (currentIndex - 1 + parts.length) % parts.length
            : event.key === 'ArrowRight' || event.key === 'ArrowDown'
              ? (currentIndex + 1) % parts.length
              : -1;
    const next = parts[nextIndex];
    if (!next) return;
    event.preventDefault();
    keyboardPartFocusIdRef.current = next.id;
    document.getElementById(`score-part-tab-${next.id}`)?.focus({ preventScroll: true });
    if (next.id === scoreId) {
      keyboardPartFocusIdRef.current = null;
      return;
    }
    void navigate(scorePath(next.id));
  };

  return (
    <div className="page score-page">
      <PageHeader
        eyebrow="Score library"
        title="악보"
        description={
          remoteMode
            ? '레퍼토리 악보를 서버와 동기화합니다. MusicXML은 서버에서 초안을 분석합니다.'
            : 'MusicXML은 자동 인식하고, PDF와 이미지는 로컬에서 마디를 직접 매핑합니다.'
        }
        actions={
          <>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,image/*,.musicxml,.mxl,.xml"
              hidden
              onChange={(event) => void upload(event)}
            />
            <Button
              variant="primary"
              disabled={uploading || scores.loading || !canManageScores}
              onClick={() => inputRef.current?.click()}
            >
              <Upload size={18} aria-hidden /> {uploading ? '업로드 중…' : '악보 가져오기'}
            </Button>
          </>
        }
      />

      {pendingTempoDraft && pendingTempoDraft.repertoireItemId === repertoireItemId ? (
        <Card className="score-draft-review" role="status">
          <div>
            <strong>{pendingTempoDraft.filename} 템포맵 초안</strong>
            <span className="subtle">
              {pendingTempoDraft.draft.totalMeasures}마디 ·{' '}
              {pendingTempoDraft.draft.sections.length}구간 · 반복/이동{' '}
              {pendingTempoDraft.draft.jumps.length}개
            </span>
            <p className="subtle">
              {playbackReady
                ? `현재 r${playbackMap.revision} · ${playbackMap.totalMeasures}마디에서 새 revision으로 교체됩니다.`
                : '현재 템포맵이 없으면 이 초안이 첫 revision이 됩니다.'}
              {pendingTempoDraft.draft.anacrusis
                ? ` · 못갖춘마디 ${pendingTempoDraft.draft.anacrusis.beats}박`
                : ''}
            </p>
            <details className="score-draft-details">
              <summary>인식한 구간과 이동 지시 검토</summary>
              <ul>
                {pendingTempoDraft.draft.sections.map((section, index) => (
                  <li key={`section:${index}`}>{draftSectionSummary(section, index)}</li>
                ))}
              </ul>
              {pendingTempoDraft.draft.jumps.length ? (
                <ul>
                  {pendingTempoDraft.draft.jumps.map((jump, index) => (
                    <li key={`jump:${index}`}>{draftJumpSummary(jump, index)}</li>
                  ))}
                </ul>
              ) : (
                <p className="subtle">반복 또는 이동 지시는 인식되지 않았습니다.</p>
              )}
            </details>
            {pendingTempoDraft.draft.warnings.length ? (
              <ul>
                {pendingTempoDraft.draft.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="cluster">
            <Button onClick={() => setPendingTempoDraft(undefined)}>초안 버리기</Button>
            <Button
              variant="primary"
              disabled={savingDraft || !canManageScores}
              onClick={() => void savePendingTempoDraft()}
            >
              <Save size={17} aria-hidden /> {savingDraft ? '저장 중…' : '템포맵으로 저장'}
            </Button>
          </div>
        </Card>
      ) : null}

      {scores.loading && !scores.data ? (
        <Card className="loading-panel" role="status" aria-live="polite" aria-busy="true">
          악보 목록을 불러오는 중…
        </Card>
      ) : null}

      {scores.error ? (
        <Card className="error-panel score-data-message" role="alert">
          <strong>악보 목록을 불러오지 못했습니다.</strong>
          <span>{scores.error.message}</span>
          <Button onClick={scores.reload}>다시 시도</Button>
        </Card>
      ) : null}

      {scoreLoadError ? (
        <Card className="error-panel score-data-message" role="alert">
          <strong>선택한 악보를 열지 못했습니다.</strong>
          <span>{scoreLoadError}</span>
          <Button onClick={() => setScoreReloadToken((current) => current + 1)}>다시 시도</Button>
        </Card>
      ) : null}

      {scoreDataWarnings.length ? (
        <Card className="score-data-message" role="status">
          <strong>악보 본문은 열렸지만 일부 공동 데이터를 갱신하지 못했습니다.</strong>
          <ul>
            {scoreDataWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <Button onClick={() => setScoreReloadToken((current) => current + 1)}>다시 동기화</Button>
        </Card>
      ) : null}

      {playbackNotice ? (
        <Card
          className="score-data-message"
          role={playbackNotice.tone === 'danger' ? 'alert' : 'status'}
        >
          <strong>
            {playbackNotice.tone === 'danger'
              ? '재생 템포맵을 준비하지 못했습니다.'
              : '저장된 템포맵을 사용합니다.'}
          </strong>
          <span>{playbackNotice.message}</span>
          <Button onClick={() => setScoreReloadToken((current) => current + 1)}>
            템포맵 다시 불러오기
          </Button>
        </Card>
      ) : null}

      {remoteMode && repertoireAccess.data?.role === 'member' ? (
        <Card className="score-data-message" role="status">
          프로젝트 멤버는 악보를 읽고 필기할 수 있습니다. 업로드·마디 매핑·번호 보정은 리더에게
          요청하세요.
        </Card>
      ) : null}

      {remoteMode && repertoireAccess.error ? (
        <Card className="error-panel score-data-message" role="alert">
          <strong>악보 관리 권한을 확인하지 못했습니다.</strong>
          <span>읽기와 본인 필기 외의 관리 기능은 잠겨 있습니다.</span>
          <Button onClick={repertoireAccess.reload}>권한 다시 확인</Button>
        </Card>
      ) : null}

      {!scores.loading && !scores.error && parts.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BookOpen size={40} aria-hidden />}
            title="악보를 추가하세요"
            description="MusicXML은 마디와 템포를 자동 인식합니다. PDF와 사진도 지원합니다."
            action={
              <Button
                variant="primary"
                disabled={uploading || scores.loading || !canManageScores}
                onClick={() => inputRef.current?.click()}
              >
                {uploading ? '업로드 중…' : '파일 선택'}
              </Button>
            }
          />
        </Card>
      ) : parts.length > 0 ? (
        <>
          <div className="score-parts" role="tablist" aria-label="총보와 파트보">
            {parts.map((score, index) => (
              <button
                key={score.id}
                id={`score-part-tab-${score.id}`}
                role="tab"
                aria-selected={selected?.id === score.id}
                aria-controls="score-part-panel"
                tabIndex={selected?.id === score.id ? 0 : -1}
                className={selected?.id === score.id ? 'score-part--active' : ''}
                onClick={() => {
                  void navigate(scorePath(score.id));
                }}
                onKeyDown={(event) => selectPartFromKeyboard(event, index)}
              >
                {score.kind === 'full' ? (
                  <FileMusic size={16} aria-hidden />
                ) : (
                  <FileText size={16} aria-hidden />
                )}
                {score.instrument ?? (score.kind === 'full' ? '총보' : score.name)}
              </button>
            ))}
          </div>
          <div
            id="score-part-panel"
            className="score-layout"
            role="tabpanel"
            aria-labelledby={selected ? `score-part-tab-${selected.id}` : undefined}
          >
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
                    <Map size={17} /> 마디 매핑
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
                    const scoreMeasure = scoreMeasureNumber(
                      next,
                      measureMap?.measureNumberOffset ?? 0,
                    );
                    const target = measureMap?.regions.find(
                      (region) => region.measureNumber === scoreMeasure,
                    );
                    if (target) setPage(target.page);
                  }}
                />
                <Button
                  disabled={!selected || !playbackReady}
                  variant={metronome.playing ? 'primary' : 'secondary'}
                  onClick={() => void togglePlayback()}
                >
                  {metronome.playing ? <Square size={17} /> : <Play size={17} />}
                  {metronome.playing ? '악보 재생 정지' : '이 마디부터 재생'}
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
                              {!remoteMode ||
                              annotation.authorId === user?.id ||
                              canManageScores ? (
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
                {usingOfflineCache ? (
                  <StatusBadge tone="warning">오프라인 읽기 전용</StatusBadge>
                ) : null}
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
                {metronome.playing && !autoPageFollowing ? (
                  <Button
                    onClick={() => {
                      setAutoPageFollowing(true);
                      const scoreMeasure = scoreMeasureNumber(
                        metronome.position.measureNumber,
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
                          canonicalMeasureNumber(
                            region.measureNumber,
                            measureMap?.measureNumberOffset ?? 0,
                          ) === currentMeasure
                            ? 'measure-region measure-region--current'
                            : 'measure-region'
                        }
                        x={region.rect.x}
                        y={region.rect.y}
                        width={region.rect.w}
                        height={region.rect.h}
                      />
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
                      const content =
                        typeof text === 'string' || typeof text === 'number' ? String(text) : '';
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
                <Card
                  className="score-practice-notes"
                  aria-label={`${currentMeasure}마디 연습 메모`}
                >
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
          </div>
        </>
      ) : null}
    </div>
  );
}
