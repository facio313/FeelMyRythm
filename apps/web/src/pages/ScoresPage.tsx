import { assertValidTempoMap, type TempoMap } from '@feelmyrythm/core';
import type { components } from '@feelmyrythm/protocol';
import { Button, Card, EmptyState, useToast } from '@feelmyrythm/ui';
import { BookOpen, Save, Upload } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { ApiError } from '../lib/api';
import { AnnotationSyncClient, type AnnotationConnectionState } from '../lib/annotationClient';
import { useAuth } from '../lib/auth';
import { localDb, type LocalMeasureMap, type LocalScore } from '../lib/localDb';
import { musicXmlToTempoMap, readMusicXml } from '../lib/musicxml';
import {
  listPracticeLogs,
  practiceAnchorMarkers,
  type PracticeAnchorMarker,
} from '../lib/practiceApi';
import {
  canonicalMeasureNumber,
  createAnnotation,
  createMusicXmlDraft,
  createOmrDraft,
  deleteAnnotation as deleteRemoteAnnotation,
  downloadScore,
  getMeasureMap as getRemoteMeasureMap,
  getOmrDraft,
  getScore as getRemoteScore,
  listRepertoireAnnotations,
  listScores as listRemoteScores,
  localScoreListItem,
  measureMapFromOmrDraft,
  putMeasureMap as putRemoteMeasureMap,
  scoreMeasureNumber,
  scoreListItem,
  tempoMapFromMusicXmlDraft,
  updateAnnotation,
  updateScoreSettings,
  uploadScore,
  type MusicXmlDraft,
  type OmrDraft,
  type ScoreListItem,
  type VersionedAnnotation,
} from '../lib/scoreApi';
import { useAsync } from '../lib/useAsync';
import { createDefaultTempoMap } from '../lib/defaultTempoMap';
import { useMetronome } from '../lib/useMetronome';
import { ScorePartTabs } from './scores/ScorePartTabs';
import { ScoreStage } from './scores/ScoreStage';
import { ScoreTools } from './scores/ScoreTools';
import { annotationRevision, localPracticeMarkers } from './scores/annotationHelpers';
import { percentRectToNormalized, regionsFromSystem } from './scores/scoreGeometry';
import { nextPartIndex } from './scores/scorePartNavigation';
import {
  currentMeasurePracticeMarkers,
  editablePageAnnotations,
  projectedMeasureAnnotations,
  projectedPracticeMarkers,
  visibleOmrPageRegions,
  visiblePageAnnotations,
  visiblePageRegions,
} from './scores/scoreVisibility';
import { useScoreSurfaceGestures } from './scores/useScoreSurfaceGestures';
import {
  MUSIC_XML_MIME,
  draftJumpSummary,
  draftSectionSummary,
  isMusicXmlName,
  isNetworkFailure,
  localScoreFromRemote,
  mergeRemoteScoreMetadata,
  nextMeasureNumber,
  scoreContentType,
  supportsScore,
} from './scores/scoreFiles';
import type { AnnotationMode, AnnotationScope, NormalizedRect, PenPoint } from './scores/types';

type ServerTempoMap = components['schemas']['TempoMapOut'];

interface PendingTempoDraft {
  draft: MusicXmlDraft;
  filename: string;
  repertoireItemId: string;
}

export function ScoresPage() {
  const { scoreId, repertoireItemId: routeRepertoireId } = useParams<{
    scoreId?: string;
    repertoireItemId?: string;
  }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { notify } = useToast();
  const { client, tokens, user } = useAuth();
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
  const annotationVersionsRef = useRef(new Map<string, { revision: number; deleted: boolean }>());
  const [annotationConnectionState, setAnnotationConnectionState] =
    useState<AnnotationConnectionState>('idle');
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
  const [omrDraft, setOmrDraft] = useState<OmrDraft>();
  const [omrRequesting, setOmrRequesting] = useState(false);
  const [omrPollingError, setOmrPollingError] = useState<string>();
  const [showOmrPreview, setShowOmrPreview] = useState(false);
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
      setOmrDraft(undefined);
      setOmrRequesting(false);
      setOmrPollingError(undefined);
      setShowOmrPreview(false);
      setAnnotations([]);
      annotationVersionsRef.current.clear();
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
          annotationVersionsRef.current = new Map(
            notes.map((annotation) => [
              annotation.id,
              { revision: annotationRevision(annotation), deleted: false },
            ]),
          );
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
            annotationVersionsRef.current = new Map(
              notes.map((annotation) => [
                annotation.id,
                { revision: annotationRevision(annotation), deleted: false },
              ]),
            );
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
    if (
      !remoteMode ||
      !repertoireItemId ||
      !tokens?.accessToken ||
      !selected ||
      selected.id !== scoreId ||
      usingOfflineCache
    ) {
      return;
    }
    const targetRepertoireId = repertoireItemId;
    let active = true;
    const sync = new AnnotationSyncClient(targetRepertoireId, tokens.accessToken, {
      onSnapshot: (snapshot) => {
        if (!active || activeRepertoireIdRef.current !== targetRepertoireId) return;
        annotationVersionsRef.current = new Map(
          snapshot.map((annotation) => [
            annotation.id,
            { revision: annotationRevision(annotation), deleted: false },
          ]),
        );
        setAnnotations(snapshot);
        const scoreIds = new Set([
          ...snapshot.map((annotation) => annotation.scoreId),
          ...(scores.data ?? []).map((item) => item.id),
        ]);
        void Promise.all(
          [...scoreIds].map((id) =>
            localDb.replaceAnnotations(
              id,
              snapshot.filter((annotation) => annotation.scoreId === id),
              remoteCacheScope,
            ),
          ),
        ).catch((error: unknown) => {
          if (!active) return;
          notify({
            title: '실시간 필기의 오프라인 사본을 갱신하지 못했습니다.',
            description: error instanceof Error ? error.message : String(error),
            tone: 'info',
          });
        });
      },
      onEvent: (event) => {
        if (!active || activeRepertoireIdRef.current !== targetRepertoireId) return;
        const known = annotationVersionsRef.current.get(event.annotationId);
        if (
          known &&
          (known.revision > event.revision ||
            (known.revision === event.revision && known.deleted && event.operation === 'upsert'))
        ) {
          return;
        }
        if (event.operation === 'delete') {
          annotationVersionsRef.current.set(event.annotationId, {
            revision: event.revision,
            deleted: true,
          });
          setAnnotations((current) =>
            current.filter((annotation) => annotation.id !== event.annotationId),
          );
          void localDb
            .deleteAnnotation(event.annotationId, remoteCacheScope)
            .catch(() => undefined);
          return;
        }
        const annotation = event.annotation;
        if (!annotation) return;
        annotationVersionsRef.current.set(annotation.id, {
          revision: annotationRevision(annotation, event.revision),
          deleted: false,
        });
        setAnnotations((current) => {
          const index = current.findIndex((item) => item.id === annotation.id);
          if (index < 0) return [...current, annotation];
          return current.map((item) => (item.id === annotation.id ? annotation : item));
        });
        void localDb.putAnnotation(annotation, remoteCacheScope).catch(() => undefined);
      },
      onStatus: ({ state }) => {
        if (active) setAnnotationConnectionState(state);
      },
      onUnauthorized: async (rejectedAccessToken) => {
        try {
          const refreshed = await client.refreshAccessToken(rejectedAccessToken);
          return refreshed.accessToken;
        } catch {
          return null;
        }
      },
    });
    sync.connect();
    return () => {
      active = false;
      sync.disconnect();
    };
  }, [
    client,
    notify,
    remoteCacheScope,
    remoteMode,
    repertoireItemId,
    scoreId,
    scores.data,
    selected,
    tokens?.accessToken,
    usingOfflineCache,
  ]);

  useEffect(() => {
    const jobId = omrDraft?.id;
    const scoreAtStart = omrDraft?.scoreId;
    if (!jobId || !scoreAtStart || !['pending', 'running'].includes(omrDraft.status)) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await getOmrDraft(client, jobId);
        if (!active || activeScoreIdRef.current !== scoreAtStart) return;
        setOmrDraft(next);
        setOmrPollingError(undefined);
        if (next.status === 'pending' || next.status === 'running') {
          timer = window.setTimeout(() => void poll(), 1_000);
        }
      } catch (error) {
        if (!active || activeScoreIdRef.current !== scoreAtStart) return;
        setOmrPollingError(error instanceof Error ? error.message : String(error));
      }
    };
    timer = window.setTimeout(() => void poll(), 500);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [client, omrDraft?.id, omrDraft?.scoreId, omrDraft?.status]);

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
        annotationVersionsRef.current.set(saved.id, {
          revision: annotationRevision(saved),
          deleted: false,
        });
        setAnnotations((current) => {
          const exists = current.some((item) => item.id === saved.id);
          return exists
            ? current.map((item) => (item.id === saved.id ? saved : item))
            : [...current, saved];
        });
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
          annotationVersionsRef.current = new Map(
            latest.map((item) => [item.id, { revision: annotationRevision(item), deleted: false }]),
          );
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
      if (remoteMode) {
        annotationVersionsRef.current.set(saved.id, {
          revision: annotationRevision(saved),
          deleted: false,
        });
      }
      setAnnotations((current) =>
        current.some((item) => item.id === saved.id) ? current : [...current, saved],
      );
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
      if (remoteMode) {
        annotationVersionsRef.current.set(annotation.id, {
          revision: annotationRevision(annotation),
          deleted: true,
        });
      }
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

  const requestOmrDraft = async () => {
    if (!selected || !remoteMode || usingOfflineCache || !canManageScores) return;
    const targetScore = selected;
    setOmrRequesting(true);
    setOmrPollingError(undefined);
    setShowOmrPreview(false);
    try {
      const created = await createOmrDraft(client, targetScore.id, measureMapRevision);
      if (activeScoreIdRef.current !== targetScore.id) return;
      setOmrDraft(created);
      notify({
        title: 'OMR 마디맵 초안 생성을 시작했습니다.',
        description: 'Audiveris가 악보를 분석하는 동안 이 화면을 계속 사용할 수 있습니다.',
        tone: 'info',
      });
    } catch (error) {
      if (activeScoreIdRef.current !== targetScore.id) return;
      if (error instanceof ApiError && error.status === 409) {
        try {
          await refreshScoreSettingsAfterConflict(targetScore);
        } catch {
          // The original conflict remains the actionable error shown below.
        }
      }
      notify({
        title: 'OMR 초안 생성을 시작하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      if (activeScoreIdRef.current === targetScore.id) setOmrRequesting(false);
    }
  };

  const refreshOmrDraft = async () => {
    if (!omrDraft || activeScoreIdRef.current !== omrDraft.scoreId) return;
    try {
      const next = await getOmrDraft(client, omrDraft.id);
      if (activeScoreIdRef.current !== next.scoreId) return;
      setOmrDraft(next);
      setOmrPollingError(undefined);
    } catch (error) {
      setOmrPollingError(error instanceof Error ? error.message : String(error));
    }
  };

  const applyOmrDraft = async () => {
    if (!selected || !omrDraft || omrDraft.status !== 'succeeded') return;
    const targetScore = selected;
    if (omrDraft.scoreId !== targetScore.id) return;
    if (omrDraft.expectedMeasureMapRevision !== measureMapRevision) {
      notify({
        title: 'OMR 초안의 기준 revision이 오래되었습니다.',
        description: '현재 마디 맵에 맞춰 OMR 초안을 다시 생성해 주세요.',
        tone: 'danger',
      });
      return;
    }
    const replacement = measureMapFromOmrDraft(omrDraft);
    replacement.measureNumberOffset = measureMap?.measureNumberOffset ?? measureNumberOffset;
    if (
      measureMap?.regions.length &&
      !window.confirm(
        `현재 ${measureMap.regions.length}개 마디 영역을 OMR 초안 ${replacement.regions.length}개로 교체할까요?`,
      )
    ) {
      return;
    }
    try {
      const saved = await putRemoteMeasureMap(client, replacement, measureMapRevision);
      await updateOfflineCopy(localDb.putMeasureMap(saved.map, remoteCacheScope), 'OMR 마디 맵');
      if (activeScoreIdRef.current !== targetScore.id) return;
      setMeasureMap(saved.map);
      setMeasureMapRevision(saved.revision);
      setMeasureNumberOffset(saved.map.measureNumberOffset);
      setFirstMeasure(nextMeasureNumber(saved.map));
      setShowOmrPreview(false);
      notify({
        title: 'OMR 초안을 마디 맵으로 저장했습니다.',
        description: '자동 인식 결과를 실제 악보와 대조해 각 영역을 확인해 주세요.',
        tone: 'success',
      });
    } catch (error) {
      if (activeScoreIdRef.current !== targetScore.id) return;
      if (error instanceof ApiError && error.status === 409) {
        try {
          await refreshScoreSettingsAfterConflict(targetScore);
        } catch {
          // Keep the conflict message below even when refreshing also fails.
        }
      }
      notify({
        title: 'OMR 초안을 저장하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  };

  const finishSystem = async () => {
    if (!selected || !systemRect || usingOfflineCache || !canManageScores) return;
    const targetScore = selected;
    const normalizedFirstMeasure = Math.max(1, Math.trunc(firstMeasure));
    const regions = regionsFromSystem(systemRect, boundaries, page, normalizedFirstMeasure);
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
    const rect = percentRectToNormalized(keyboardRegion);
    if (!rect) {
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

  const { scoreSurfaceKeyDown, pointerDown, pointerMove, pointerUp, pointerCancel } =
    useScoreSurfaceGestures({
      mode,
      setMode,
      measureMap,
      page,
      currentMeasure,
      selected,
      dragStart,
      setDragStart,
      systemRect,
      setSystemRect,
      setBoundaries,
      activePenPoints,
      setActivePenPoints,
      activeSurfacePointerIdRef,
      saveAnnotation,
      savePenAnnotation,
      selectCanonicalMeasure,
    });

  const visibleRegions = visiblePageRegions(measureMap, selected?.id, page);
  const visibleOmrRegions = visibleOmrPageRegions(omrDraft, selected?.id, page, showOmrPreview);
  const visibleAnnotations = visiblePageAnnotations(annotations, selected?.id, page);
  const visibleMeasureAnnotations = projectedMeasureAnnotations(
    annotations,
    visibleRegions,
    measureMap?.measureNumberOffset ?? 0,
  );
  const visibleEditableAnnotations = editablePageAnnotations(
    visibleAnnotations,
    visibleMeasureAnnotations,
    selected?.id,
  );
  const currentPracticeMarkers = currentMeasurePracticeMarkers(practiceMarkers, currentMeasure);
  const visiblePracticeMarkers = projectedPracticeMarkers(
    practiceMarkers,
    visibleRegions,
    selected?.id,
    page,
    measureMap?.measureNumberOffset ?? 0,
  );
  const parts = scores.data ?? [];
  const selectPartFromKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    const next = parts[nextPartIndex(event.key, currentIndex, parts.length - 1)];
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
          <ScorePartTabs
            parts={parts}
            selectedId={selected?.id}
            onSelect={(id) => {
              void navigate(scorePath(id));
            }}
            onKeyDown={selectPartFromKeyboard}
          />
          <div
            id="score-part-panel"
            className="score-layout"
            role="tabpanel"
            aria-labelledby={selected ? `score-part-tab-${selected.id}` : undefined}
          >
            <ScoreTools
              toolsOpen={toolsOpen}
              setToolsOpen={setToolsOpen}
              mode={mode}
              setMode={setMode}
              usingOfflineCache={usingOfflineCache}
              canManageScores={canManageScores}
              currentMeasure={currentMeasure}
              setCurrentMeasure={setCurrentMeasure}
              currentMeasureRef={currentMeasureRef}
              measureMap={measureMap}
              setPage={setPage}
              selected={selected}
              playbackReady={playbackReady}
              metronomePlaying={metronome.playing}
              togglePlayback={() => void togglePlayback()}
              annotationText={annotationText}
              setAnnotationText={setAnnotationText}
              saveAnnotation={saveAnnotation}
              annotationScope={annotationScope}
              setAnnotationScope={setAnnotationScope}
              visibleEditableAnnotations={visibleEditableAnnotations}
              remoteMode={remoteMode}
              userId={user?.id}
              removeAnnotation={removeAnnotation}
              firstMeasure={firstMeasure}
              setFirstMeasure={setFirstMeasure}
              keyboardRegion={keyboardRegion}
              setKeyboardRegion={setKeyboardRegion}
              addKeyboardRegion={() => void addKeyboardRegion()}
              finishSystem={() => void finishSystem()}
              measureMapRevision={measureMapRevision}
              annotationConnectionState={annotationConnectionState}
              omrDraft={omrDraft}
              omrRequesting={omrRequesting}
              omrPollingError={omrPollingError}
              requestOmrDraft={() => void requestOmrDraft()}
              refreshOmrDraft={() => void refreshOmrDraft()}
              showOmrPreview={showOmrPreview}
              setShowOmrPreview={setShowOmrPreview}
              applyOmrDraft={() => void applyOmrDraft()}
              scoreKind={scoreKind}
              setScoreKind={setScoreKind}
              instrument={instrument}
              setInstrument={setInstrument}
              measureNumberOffset={measureNumberOffset}
              setMeasureNumberOffset={setMeasureNumberOffset}
              savingMetadata={savingMetadata}
              saveMetadata={() => void saveMetadata()}
            />
            <ScoreStage
              scoreZoom={scoreZoom}
              setScoreZoom={setScoreZoom}
              metronomePlaying={metronome.playing}
              autoPageFollowing={autoPageFollowing}
              setAutoPageFollowing={setAutoPageFollowing}
              measureMap={measureMap}
              setPage={setPage}
              viewerRef={viewerRef}
              mode={mode}
              scoreSurfaceKeyDown={scoreSurfaceKeyDown}
              pointerDown={pointerDown}
              pointerMove={pointerMove}
              pointerUp={pointerUp}
              pointerCancel={pointerCancel}
              selected={selected}
              page={page}
              setPageCount={setPageCount}
              currentMeasure={currentMeasure}
              selectCanonicalMeasure={(canonical, targetPage) =>
                void selectCanonicalMeasure(canonical, targetPage)
              }
              visibleRegions={visibleRegions}
              visibleOmrRegions={visibleOmrRegions}
              omrDraftId={omrDraft?.id}
              systemRect={systemRect}
              boundaries={boundaries}
              visibleAnnotations={visibleAnnotations}
              visibleMeasureAnnotations={visibleMeasureAnnotations}
              activePenPoints={activePenPoints}
              visiblePracticeMarkers={visiblePracticeMarkers}
              currentPracticeMarkers={currentPracticeMarkers}
              pageCount={pageCount}
              metronomeMeasureNumber={metronome.position.measureNumber}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
