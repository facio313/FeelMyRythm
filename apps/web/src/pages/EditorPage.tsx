import {
  assertValidTempoMap,
  expandTimeline,
  validateTempoMap,
  type Accent,
  type JumpDirective,
  type TempoMap,
  type TempoSection,
} from '@feelmyrythm/core';
import type { components } from '@feelmyrythm/protocol';
import { Button, Card, Modal, StatusBadge, useToast } from '@feelmyrythm/ui';
import {
  Braces,
  ChevronDown,
  ChevronUp,
  Download,
  GitMerge,
  Plus,
  RotateCcw,
  Save,
  Scissors,
  Trash2,
  Upload,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type SetStateAction,
} from 'react';
import { useBeforeUnload, useBlocker, useParams, type BlockerFunction } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { createDefaultTempoMap } from '../lib/defaultTempoMap';
import { localDb } from '../lib/localDb';
import { rebaseTempoMapDraft } from '../lib/tempoMapMerge';
import { EditorField, JumpFields, SelectField } from './editor/EditorFields';
import {
  JUMP_LABELS,
  NOTE_VALUE_LABELS,
  accentsFor,
  calculateTapTempo,
  createJump,
  deleteTempoSection,
  fingerprint,
  friendlyIssue,
  isNetworkFailure,
  issueFor,
  mergeTempoSectionWithPrevious,
  moveTempoSection,
  resizeTempoMap,
  splitTempoSection,
  tempoMapContract,
  tempoMapFromServer,
  updateJump,
  updateSection,
  updateSectionMeter,
} from './editor/tempoMapEdits';

type ServerTempoMap = components['schemas']['TempoMapOut'];
type JumpType = JumpDirective['type'];

interface LoadConflict {
  local: TempoMap;
  server: TempoMap;
}

interface SaveConflict {
  draft: TempoMap;
  latest: TempoMap;
  rebased: TempoMap;
}

interface UndoDelete {
  map: TempoMap;
  selectedId: string;
  label: string;
}

export function EditorPage() {
  const { tempoMapId } = useParams();
  const { user, client } = useAuth();
  const { notify } = useToast();
  const [map, setMap] = useState<TempoMap>(() => createDefaultTempoMap());
  const [selectedId, setSelectedId] = useState(map.sections[0]?.id ?? '');
  const [zoom, setZoom] = useState(1);
  const [tableMode, setTableMode] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitMeasure, setSplitMeasure] = useState(2);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [cacheNotice, setCacheNotice] = useState<string>();
  const [offlineReadOnlyFor, setOfflineReadOnlyFor] = useState<{
    tempoMapId: string;
    userId: string;
  }>();
  const [reloadKey, setReloadKey] = useState(0);
  const [serverSnapshot, setServerSnapshot] = useState<TempoMap>();
  const [loadConflict, setLoadConflict] = useState<LoadConflict>();
  const [saveConflict, setSaveConflict] = useState<SaveConflict>();
  const [rebasedPending, setRebasedPending] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedFingerprint, setSavedFingerprint] = useState('');
  const [undoDelete, setUndoDelete] = useState<UndoDelete>();
  const [newJumpType, setNewJumpType] = useState<JumpType>('repeat');
  const [tapStatus, setTapStatus] = useState('두 번 이상 일정하게 두드리세요.');
  const tapTimesRef = useRef<number[]>([]);
  const importRef = useRef<HTMLInputElement>(null);
  const remoteCacheScope = useMemo(() => (user ? { userId: user.id } : undefined), [user]);
  const isOfflineReadOnly =
    offlineReadOnlyFor !== undefined &&
    offlineReadOnlyFor.tempoMapId === tempoMapId &&
    offlineReadOnlyFor.userId === user?.id;

  const editMap = useCallback(
    (next: SetStateAction<TempoMap>) => {
      if (!isOfflineReadOnly) setMap(next);
    },
    [isOfflineReadOnly],
  );

  const cacheMap = useCallback(
    async (next: TempoMap) => {
      try {
        await localDb.putTempoMap(next, remoteCacheScope);
        return true;
      } catch (error) {
        notify({
          title: '로컬 캐시를 동기화하지 못했습니다.',
          description: error instanceof Error ? error.message : String(error),
          tone: 'info',
        });
        return false;
      }
    },
    [notify, remoteCacheScope],
  );

  const fetchServerMap = useCallback(
    async (repertoireItemId: string): Promise<TempoMap> => {
      const response = await client.get<ServerTempoMap>(`/repertoire/${repertoireItemId}/tempomap`);
      return tempoMapFromServer(response, repertoireItemId);
    },
    [client],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      await Promise.resolve();
      if (cancelled) return;
      setLoadState('loading');
      setLoadError('');
      setCacheNotice(undefined);
      setOfflineReadOnlyFor(undefined);
      setLoadConflict(undefined);
      setSaveConflict(undefined);
      setRebasedPending(false);
      setServerSnapshot(undefined);
      setSplitOpen(false);
      setUndoDelete(undefined);

      const readCachedMap = async (): Promise<{ map?: TempoMap; error?: unknown }> => {
        const results = await Promise.allSettled([
          localDb.getTempoMapForRepertoire(tempoMapId ?? '', remoteCacheScope),
          localDb.getTempoMap(tempoMapId ?? '', remoteCacheScope),
        ]);
        const rejected = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        const error: unknown = rejected?.reason;
        const stored = results.find(
          (result): result is PromiseFulfilledResult<TempoMap | undefined> =>
            result.status === 'fulfilled' && result.value !== undefined,
        )?.value;
        if (!stored) return error ? { error } : {};
        try {
          return { map: tempoMapContract(stored), ...(error === undefined ? {} : { error }) };
        } catch (validationError) {
          return { error: validationError };
        }
      };

      const setCacheFailureNotice = () => {
        setCacheNotice(
          '로컬 사본을 읽거나 갱신하지 못했습니다. 서버 데이터는 정상적으로 사용 중입니다.',
        );
      };

      try {
        if (!tempoMapId) {
          const next = createDefaultTempoMap();
          if (cancelled) return;
          setMap(next);
          setSelectedId(next.sections[0]?.id ?? '');
          setServerSnapshot(undefined);
          setSavedFingerprint('');
          setLoadState('ready');
          return;
        }

        if (!user) {
          const { map: local, error } = await readCachedMap();
          if (cancelled) return;
          if (error) {
            throw error instanceof Error ? error : new Error('로컬 템포맵을 읽지 못했습니다.');
          }
          if (local) {
            setMap(local);
            setSelectedId(local.sections[0]?.id ?? '');
            setSavedFingerprint(fingerprint(local));
            setLoadState('ready');
            return;
          }
          const next = createDefaultTempoMap(tempoMapId, user ? 0 : 1);
          setMap(next);
          setSelectedId(next.sections[0]?.id ?? '');
          setSavedFingerprint('');
          setLoadState('ready');
          return;
        }

        // Start the best-effort cache read without allowing IndexedDB to delay or
        // override the authoritative server response. It is only consumed below
        // when fetch itself fails at the network boundary.
        const cachedMap = readCachedMap();
        void cachedMap.then(({ error }) => {
          if (!cancelled && error) setCacheFailureNotice();
        });

        try {
          const server = await fetchServerMap(tempoMapId);
          if (cancelled) return;
          setMap(server);
          setSelectedId(server.sections[0]?.id ?? '');
          setServerSnapshot(server);
          setSavedFingerprint(fingerprint(server));
          setLoadState('ready');
          void cacheMap(server).then((cached) => {
            if (!cancelled && !cached) setCacheFailureNotice();
          });
        } catch (serverError) {
          if (!isNetworkFailure(serverError)) throw serverError;
          const { map: cached, error } = await cachedMap;
          if (cancelled) return;
          if (!cached) {
            throw new Error(
              error
                ? '네트워크에 연결할 수 없고 로컬 사본도 읽지 못했습니다.'
                : '네트워크에 연결할 수 없고 저장된 템포맵도 없습니다.',
              { cause: serverError },
            );
          }
          setMap(cached);
          setSelectedId(cached.sections[0]?.id ?? '');
          setSavedFingerprint(fingerprint(cached));
          setOfflineReadOnlyFor({ tempoMapId, userId: user.id });
          if (error) setCacheFailureNotice();
          setLoadState('ready');
        }
      } catch (error) {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setLoadState('error');
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [cacheMap, fetchServerMap, reloadKey, remoteCacheScope, tempoMapId, user]);

  const selectedIndex = map.sections.findIndex((section) => section.id === selectedId);
  const selected = map.sections[selectedIndex] ?? map.sections[0];
  const validation = useMemo(() => validateTempoMap(map), [map]);
  const preview = useMemo(() => {
    if (!validation.valid) {
      return {
        timeline: null,
        error: `검증 오류 ${validation.issues.length}개를 먼저 해결하세요.`,
      };
    }
    try {
      return { timeline: expandTimeline(map), error: null };
    } catch (error) {
      return {
        timeline: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [map, validation]);
  const isRemote = Boolean(user && map.repertoireItemId !== 'local');
  const isDirty = fingerprint(map) !== savedFingerprint;
  const shouldWarnAboutUnsavedChanges = loadState === 'ready' && isDirty;
  const shouldBlockNavigation = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      shouldWarnAboutUnsavedChanges &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search ||
        currentLocation.hash !== nextLocation.hash),
    [shouldWarnAboutUnsavedChanges],
  );
  const blocker = useBlocker(shouldBlockNavigation);

  useBeforeUnload(
    useCallback(
      (event) => {
        if (!shouldWarnAboutUnsavedChanges) return;
        event.preventDefault();
        event.returnValue = '';
      },
      [shouldWarnAboutUnsavedChanges],
    ),
    { capture: true },
  );

  useEffect(() => {
    if (
      blocker.state === 'blocked' &&
      !shouldWarnAboutUnsavedChanges &&
      !isSaving &&
      !saveConflict
    ) {
      blocker.proceed();
    }
  }, [blocker, isSaving, saveConflict, shouldWarnAboutUnsavedChanges]);

  const applyServerMap = useCallback(
    async (next: TempoMap) => {
      setMap(next);
      setSelectedId((current) =>
        next.sections.some((section) => section.id === current)
          ? current
          : (next.sections[0]?.id ?? ''),
      );
      setServerSnapshot(next);
      setSavedFingerprint(fingerprint(next));
      setRebasedPending(false);
      setUndoDelete(undefined);
      await cacheMap(next);
    },
    [cacheMap],
  );

  const save = async (): Promise<boolean> => {
    if (isOfflineReadOnly) {
      notify({
        title: '오프라인 읽기 전용 상태에서는 저장할 수 없습니다.',
        tone: 'info',
      });
      return false;
    }
    if (!validation.valid || preview.error) {
      notify({
        title: '템포맵 오류를 먼저 고쳐 주세요.',
        description: preview.error ?? '필드 아래의 해결 방법을 확인하세요.',
        tone: 'danger',
      });
      return false;
    }
    setIsSaving(true);
    const draft = map;
    try {
      if (isRemote) {
        const prepared =
          serverSnapshot && draft.revision !== serverSnapshot.revision
            ? rebaseTempoMapDraft(draft, serverSnapshot)
            : draft;
        const response = await client.put<ServerTempoMap>(
          `/repertoire/${prepared.repertoireItemId}/tempomap`,
          { expectedRevision: prepared.revision, data: prepared },
        );
        const saved = tempoMapFromServer(response, prepared.repertoireItemId);
        await applyServerMap(saved);
      } else {
        const saved = { ...draft, revision: draft.revision + 1 };
        await localDb.putTempoMap(saved);
        setMap(saved);
        setSavedFingerprint(fingerprint(saved));
        setUndoDelete(undefined);
      }
      notify({ title: '템포맵을 저장했습니다.', tone: 'success' });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && isRemote) {
        try {
          const latest = await fetchServerMap(draft.repertoireItemId);
          if (!latest) {
            throw new Error('서버 최신 revision을 찾지 못했습니다.', { cause: error });
          }
          const rebased = rebaseTempoMapDraft(draft, latest);
          await cacheMap(rebased);
          setServerSnapshot(latest);
          setSaveConflict({ draft, latest, rebased });
        } catch (refreshError) {
          notify({
            title: '충돌 후 서버 최신본을 불러오지 못했습니다.',
            description:
              refreshError instanceof Error ? refreshError.message : String(refreshError),
            tone: 'danger',
          });
        }
      } else {
        notify({
          title: '저장하지 못했습니다.',
          description: error instanceof Error ? error.message : String(error),
          tone: 'danger',
        });
      }
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const saveAndContinueNavigation = async () => {
    if (blocker.state !== 'blocked') return;
    await save();
  };

  const split = () => {
    if (!selected) return;
    try {
      const nextId = crypto.randomUUID();
      editMap((current) => splitTempoSection(current, selected.id, splitMeasure, nextId));
      setSelectedId(nextId);
      setSplitOpen(false);
    } catch (error) {
      notify({
        title: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  };

  const mergePrevious = () => {
    if (!selected) return;
    const previous = map.sections[selectedIndex - 1];
    if (!previous) return;
    editMap((current) => mergeTempoSectionWithPrevious(current, selected.id));
    setSelectedId(previous.id);
  };

  const removeSection = () => {
    if (!selected || map.sections.length === 1) return;
    setUndoDelete({
      map,
      selectedId: selected.id,
      label: selected.label ?? `${selected.startMeasure}–${selected.endMeasure}마디`,
    });
    const result = deleteTempoSection(map, selected.id);
    editMap(result.map);
    setSelectedId(result.selectedId);
  };

  const tapTempo = () => {
    const now = performance.now();
    const previous = tapTimesRef.current.at(-1);
    tapTimesRef.current =
      previous !== undefined && now - previous <= 2_000
        ? [...tapTimesRef.current.slice(-7), now]
        : [now];
    const bpm = calculateTapTempo(tapTimesRef.current);
    if (!bpm || !selected) {
      setTapStatus('한 번 더 두드리세요.');
      return;
    }
    editMap((current) => updateSection(current, selected.id, { bpm }));
    setTapStatus(`탭 평균 ${bpm} BPM`);
  };

  const exportJson = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(map, null, 2)], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `feelmyrythm-${map.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (isOfflineReadOnly) {
      event.target.value = '';
      notify({ title: '오프라인 읽기 전용 상태에서는 가져올 수 없습니다.', tone: 'info' });
      return;
    }
    try {
      const imported: unknown = JSON.parse(await file.text());
      assertValidTempoMap(imported);
      expandTimeline(imported);
      editMap({ ...imported, id: imported.id || crypto.randomUUID() });
      setSelectedId(imported.sections[0]?.id ?? '');
      notify({ title: '템포맵을 가져왔습니다.', tone: 'success' });
    } catch (error) {
      notify({
        title: '올바른 템포맵 JSON이 아닙니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      event.target.value = '';
    }
  };

  const saveLabel = rebasedPending ? '재기준 초안 저장' : isSaving ? '저장 중…' : '저장';
  const editorActions =
    loadState === 'ready' ? (
      <>
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          hidden
          disabled={isOfflineReadOnly}
          onChange={(event) => void importJson(event)}
        />
        <Button onClick={() => importRef.current?.click()} disabled={isOfflineReadOnly}>
          <Upload size={17} aria-hidden /> 가져오기
        </Button>
        <Button onClick={exportJson}>
          <Download size={17} aria-hidden /> 내보내기
        </Button>
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={isSaving || isOfflineReadOnly}
        >
          <Save size={17} aria-hidden /> {saveLabel}
        </Button>
      </>
    ) : undefined;

  return (
    <div className="page editor-page" aria-busy={loadState === 'loading'}>
      <PageHeader
        eyebrow="Tempo map"
        title="템포맵 편집기"
        description="마디별 박자와 템포, 반복 진행을 연주 순서로 설계합니다."
        actions={editorActions}
      />

      {loadState === 'loading' ? (
        <Card className="loading-panel" role="status">
          로컬 초안과 서버 revision을 함께 확인하는 중…
        </Card>
      ) : null}
      {loadState === 'error' ? (
        <Card className="error-panel" role="alert">
          <strong>템포맵을 불러오지 못했습니다.</strong>
          <p>{loadError}</p>
          <Button onClick={() => setReloadKey((current) => current + 1)}>다시 시도</Button>
        </Card>
      ) : null}

      {loadState === 'ready' ? (
        <>
          {isOfflineReadOnly ? (
            <Card className="editor-offline-notice" role="status" aria-live="polite">
              <strong>오프라인 읽기 전용으로 열었습니다.</strong>
              <p>
                네트워크에 연결할 수 없어 현재 계정의 저장된 템포맵 사본을 표시합니다. 내보내기는
                가능하지만 편집·가져오기·저장은 연결을 복구한 뒤 다시 시도해 주세요.
              </p>
              <Button onClick={() => setReloadKey((current) => current + 1)}>연결 다시 확인</Button>
            </Card>
          ) : null}
          {cacheNotice ? (
            <div className="editor-cache-notice" role="status" aria-live="polite">
              {cacheNotice}
            </div>
          ) : null}
          <fieldset
            disabled={isOfflineReadOnly}
            aria-label={isOfflineReadOnly ? '오프라인 읽기 전용 편집기' : undefined}
            style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
          >
            <Card className="map-settings" aria-label="곡 전체 설정">
              <header>
                <div>
                  <span className="eyebrow">Whole score</span>
                  <h2>곡 전체 설정</h2>
                </div>
                <div className="cluster">
                  <StatusBadge tone={isDirty ? 'warning' : 'success'}>
                    {isDirty ? '저장 안 됨' : '저장됨'}
                  </StatusBadge>
                  <span className="revision-label">revision {map.revision}</span>
                </div>
              </header>
              <div className="map-settings__grid">
                <EditorField
                  label="총 마디 수"
                  type="number"
                  min={1}
                  value={map.totalMeasures}
                  error={issueFor(validation.issues, 'totalMeasures')}
                  onChange={(event) => {
                    const next = resizeTempoMap(map, Number(event.target.value));
                    editMap(next);
                    if (!next.sections.some((section) => section.id === selectedId)) {
                      setSelectedId(next.sections[0]?.id ?? '');
                    }
                  }}
                />
                <SelectField
                  label="예비박"
                  value={map.countIn.measures}
                  error={issueFor(validation.issues, 'countIn.measures')}
                  onChange={(event) =>
                    editMap((current) => ({
                      ...current,
                      countIn: {
                        measures: Number(event.target.value) as 1 | 2,
                        useSectionMeter: true,
                      },
                    }))
                  }
                >
                  <option value={1}>1마디</option>
                  <option value={2}>2마디</option>
                </SelectField>
                <SelectField
                  label="못갖춘마디"
                  value={map.anacrusis ? 'enabled' : 'none'}
                  error={issueFor(validation.issues, 'anacrusis', true)}
                  onChange={(event) =>
                    editMap((current) => {
                      if (event.target.value === 'enabled') {
                        return { ...current, anacrusis: current.anacrusis ?? { beats: 1 } };
                      }
                      const { anacrusis: _removed, ...withoutAnacrusis } = current;
                      void _removed;
                      return withoutAnacrusis;
                    })
                  }
                >
                  <option value="none">없음</option>
                  <option value="enabled">있음</option>
                </SelectField>
                {map.anacrusis ? (
                  <EditorField
                    label="못갖춘 박 수"
                    type="number"
                    min={1}
                    value={map.anacrusis.beats}
                    error={issueFor(validation.issues, 'anacrusis.beats')}
                    onChange={(event) =>
                      editMap((current) => ({
                        ...current,
                        anacrusis: { beats: Number(event.target.value) },
                      }))
                    }
                  />
                ) : null}
              </div>
            </Card>

            <Card className="timeline-card">
              <header className="timeline-card__header">
                <div className="cluster">
                  <strong>마디 타임라인</strong>
                  {preview.error ? (
                    <StatusBadge tone="danger">전개 오류</StatusBadge>
                  ) : (
                    <StatusBadge tone="success">유효함</StatusBadge>
                  )}
                </div>
                <div className="cluster">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="축소"
                    onClick={() => setZoom((current) => Math.max(0.5, current - 0.25))}
                  >
                    <ZoomOut size={18} aria-hidden />
                  </Button>
                  <span className="fmr-tabular">{Math.round(zoom * 100)}%</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="확대"
                    onClick={() => setZoom((current) => Math.min(3, current + 0.25))}
                  >
                    <ZoomIn size={18} aria-hidden />
                  </Button>
                  <Button variant="ghost" onClick={() => setTableMode((current) => !current)}>
                    <Braces size={18} aria-hidden /> {tableMode ? '블록' : '표'}
                  </Button>
                </div>
              </header>
              {tableMode ? (
                <div className="section-table">
                  <table aria-label="템포 구간">
                    <thead>
                      <tr>
                        <th scope="col">구간</th>
                        <th scope="col">마디</th>
                        <th scope="col">박자</th>
                        <th scope="col">BPM</th>
                      </tr>
                    </thead>
                    <tbody>
                      {map.sections.map((section) => (
                        <tr
                          key={section.id}
                          className={
                            section.id === selected?.id ? 'section-table__row--selected' : ''
                          }
                        >
                          <th scope="row">
                            <button
                              type="button"
                              className="section-table__selector"
                              aria-pressed={section.id === selected?.id}
                              onClick={() => setSelectedId(section.id)}
                            >
                              {section.label ?? '—'}
                            </button>
                          </th>
                          <td>
                            {section.startMeasure}–{section.endMeasure}
                          </td>
                          <td>
                            {section.timeSignature.num}/{section.timeSignature.denom}
                          </td>
                          <td>{section.bpm}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="measure-timeline">
                  <div
                    className="measure-timeline__track"
                    style={{ width: `${Math.max(100, map.totalMeasures * 18 * zoom)}px` }}
                  >
                    {map.sections.map((section, index) => {
                      const left = ((section.startMeasure - 1) / map.totalMeasures) * 100;
                      const width =
                        ((section.endMeasure - section.startMeasure + 1) / map.totalMeasures) * 100;
                      return (
                        <button
                          key={section.id}
                          className={
                            section.id === selected?.id
                              ? 'tempo-block tempo-block--selected'
                              : 'tempo-block'
                          }
                          style={
                            {
                              left: `${left}%`,
                              width: `${width}%`,
                              '--section-hue': String(38 + (index % 4) * 12),
                            } as React.CSSProperties
                          }
                          onClick={() => setSelectedId(section.id)}
                        >
                          <strong>{section.label ?? `S${index + 1}`}</strong>
                          <span>
                            {section.startMeasure}–{section.endMeasure} · {section.bpm}
                          </span>
                        </button>
                      );
                    })}
                    {map.jumps
                      .filter((jump) => jump.type === 'repeat')
                      .map((jump, index) => (
                        <div
                          key={index}
                          className="repeat-arch"
                          style={{
                            left: `${((jump.startMeasure - 1) / map.totalMeasures) * 100}%`,
                            width: `${((jump.endMeasure - jump.startMeasure + 1) / map.totalMeasures) * 100}%`,
                          }}
                          aria-label={`${jump.startMeasure}–${jump.endMeasure}마디 ${jump.times}회 반복`}
                        >
                          ×{jump.times}
                        </div>
                      ))}
                  </div>
                </div>
              )}
              <footer
                className="timeline-preview"
                role={preview.error ? 'alert' : 'status'}
                aria-live="polite"
              >
                {preview.timeline ? (
                  <>
                    연주 순서로 <strong>{preview.timeline.entries.length}마디</strong> ·{' '}
                    <strong>
                      {Math.floor(preview.timeline.totalDurationSec / 60)}분{' '}
                      {Math.round(preview.timeline.totalDurationSec % 60)}초
                    </strong>
                  </>
                ) : (
                  <span className="error-text">{preview.error}</span>
                )}
              </footer>
            </Card>

            {!validation.valid ? (
              <Card className="validation-summary" role="alert" aria-labelledby="validation-title">
                <strong id="validation-title">
                  저장 전 해결할 항목 {validation.issues.length}개
                </strong>
                <ul>
                  {validation.issues.map((issue, index) => (
                    <li key={`${issue.path}-${issue.code}-${index}`}>
                      <code>{issue.path}</code> — {friendlyIssue(issue)}
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            {rebasedPending ? (
              <div className="editor-rebase-notice" role="status" aria-live="polite">
                서버 revision {map.revision}에 재기준했습니다. 내용을 검토한 뒤 ‘재기준 초안 저장’을
                눌러 명시적으로 반영하세요.
              </div>
            ) : null}

            {undoDelete ? (
              <div className="editor-undo" role="status" aria-live="polite">
                <span>‘{undoDelete.label}’ 구간을 삭제했습니다.</span>
                <Button
                  onClick={() => {
                    editMap(undoDelete.map);
                    setSelectedId(undoDelete.selectedId);
                    setUndoDelete(undefined);
                  }}
                >
                  <RotateCcw size={16} aria-hidden /> 삭제 취소
                </Button>
              </div>
            ) : null}

            {selected ? (
              <div className="editor-grid">
                <Card className="section-properties">
                  <header>
                    <div>
                      <span className="eyebrow">Selected section</span>
                      <h2>{selected.label ?? '이름 없는 구간'}</h2>
                    </div>
                    <div className="cluster section-order-actions">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="구간 위로 이동"
                        disabled={selectedIndex <= 0}
                        onClick={() =>
                          editMap((current) => moveTempoSection(current, selected.id, -1))
                        }
                      >
                        <ChevronUp size={18} aria-hidden />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="구간 아래로 이동"
                        disabled={selectedIndex >= map.sections.length - 1}
                        onClick={() =>
                          editMap((current) => moveTempoSection(current, selected.id, 1))
                        }
                      >
                        <ChevronDown size={18} aria-hidden />
                      </Button>
                    </div>
                  </header>
                  <div className="property-grid">
                    <EditorField
                      label="구간 이름"
                      value={selected.label ?? ''}
                      error={issueFor(validation.issues, `sections[${selectedIndex}].label`)}
                      onChange={(event) =>
                        editMap((current) =>
                          updateSection(current, selected.id, { label: event.target.value }),
                        )
                      }
                    />
                    <EditorField
                      label="BPM"
                      type="number"
                      min={20}
                      max={400}
                      value={selected.bpm}
                      error={issueFor(validation.issues, `sections[${selectedIndex}].bpm`)}
                      onChange={(event) =>
                        editMap((current) =>
                          updateSection(current, selected.id, { bpm: Number(event.target.value) }),
                        )
                      }
                    />
                    <div className="tap-tempo-field">
                      <span className="fmr-field__label">탭 템포</span>
                      <Button onClick={tapTempo}>탭 템포</Button>
                      <small aria-live="polite">{tapStatus}</small>
                    </div>
                    <EditorField
                      label="시작 마디"
                      type="number"
                      value={selected.startMeasure}
                      readOnly
                      error={issueFor(validation.issues, `sections[${selectedIndex}].startMeasure`)}
                    />
                    <EditorField
                      label="끝 마디"
                      type="number"
                      value={selected.endMeasure}
                      readOnly
                      error={issueFor(validation.issues, `sections[${selectedIndex}].endMeasure`)}
                    />
                    <EditorField
                      label="박자 분자"
                      type="number"
                      min={1}
                      max={32}
                      value={selected.timeSignature.num}
                      error={issueFor(
                        validation.issues,
                        `sections[${selectedIndex}].timeSignature.num`,
                      )}
                      onChange={(event) =>
                        editMap((current) =>
                          updateSectionMeter(current, selected.id, {
                            timeSignature: {
                              ...selected.timeSignature,
                              num: Number(event.target.value),
                            },
                          }),
                        )
                      }
                    />
                    <SelectField
                      label="박자 분모"
                      value={selected.timeSignature.denom}
                      error={issueFor(
                        validation.issues,
                        `sections[${selectedIndex}].timeSignature.denom`,
                      )}
                      onChange={(event) =>
                        editMap((current) =>
                          updateSectionMeter(current, selected.id, {
                            timeSignature: {
                              ...selected.timeSignature,
                              denom: Number(event.target.value),
                            },
                          }),
                        )
                      }
                    >
                      {[2, 4, 8, 16].map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </SelectField>
                    <SelectField
                      label="박 단위"
                      value={selected.beatUnit}
                      error={issueFor(validation.issues, `sections[${selectedIndex}].beatUnit`)}
                      onChange={(event) =>
                        editMap((current) =>
                          updateSectionMeter(current, selected.id, {
                            beatUnit: event.target.value as TempoSection['beatUnit'],
                          }),
                        )
                      }
                    >
                      {Object.entries(NOTE_VALUE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </SelectField>
                    <SelectField
                      label="분할 클릭"
                      value={selected.subdivision ?? 1}
                      error={issueFor(validation.issues, `sections[${selectedIndex}].subdivision`)}
                      onChange={(event) =>
                        editMap((current) =>
                          updateSection(current, selected.id, {
                            subdivision: Number(event.target.value) as 1 | 2 | 3 | 4,
                          }),
                        )
                      }
                    >
                      {[1, 2, 3, 4].map((value) => (
                        <option key={value} value={value}>
                          {value}분할
                        </option>
                      ))}
                    </SelectField>
                    <SelectField
                      label="템포 변화"
                      value={selected.tempoChange?.type ?? 'none'}
                      error={issueFor(
                        validation.issues,
                        `sections[${selectedIndex}].tempoChange`,
                        true,
                      )}
                      onChange={(event) => {
                        const type = event.target.value;
                        editMap((current) => {
                          if (type === 'none') {
                            return {
                              ...current,
                              sections: current.sections.map((section) => {
                                if (section.id !== selected.id) return section;
                                const { tempoChange: _removed, ...withoutChange } = section;
                                void _removed;
                                return withoutChange;
                              }),
                            };
                          }
                          return updateSection(current, selected.id, {
                            tempoChange: {
                              type: type as 'rit' | 'accel',
                              targetBpm:
                                type === 'rit' ? Math.max(1, selected.bpm - 10) : selected.bpm + 10,
                            },
                          });
                        });
                      }}
                    >
                      <option value="none">없음</option>
                      <option value="rit">rit. (느려짐)</option>
                      <option value="accel">accel. (빨라짐)</option>
                    </SelectField>
                    {selected.tempoChange ? (
                      <EditorField
                        label="도착 BPM"
                        type="number"
                        min={20}
                        max={400}
                        value={selected.tempoChange.targetBpm}
                        error={
                          issueFor(
                            validation.issues,
                            `sections[${selectedIndex}].tempoChange.targetBpm`,
                          ) ?? issueFor(validation.issues, `sections[${selectedIndex}].tempoChange`)
                        }
                        onChange={(event) =>
                          editMap((current) =>
                            updateSection(current, selected.id, {
                              tempoChange: {
                                ...selected.tempoChange!,
                                targetBpm: Number(event.target.value),
                              },
                            }),
                          )
                        }
                      />
                    ) : null}
                  </div>
                  <fieldset className="accent-editor">
                    <legend>박별 강세 패턴</legend>
                    <p>0은 무음, 1은 일반 박, 2는 강박입니다.</p>
                    <div className="accent-grid">
                      {(selected.accentPattern ?? accentsFor(selected)).map((accent, index) => (
                        <SelectField
                          key={index}
                          label={`${index + 1}박`}
                          value={accent}
                          error={issueFor(
                            validation.issues,
                            `sections[${selectedIndex}].accentPattern[${index}]`,
                          )}
                          onChange={(event) => {
                            const pattern = [...(selected.accentPattern ?? accentsFor(selected))];
                            pattern[index] = Number(event.target.value) as Accent;
                            editMap((current) =>
                              updateSection(current, selected.id, { accentPattern: pattern }),
                            );
                          }}
                        >
                          <option value={0}>0 · 무음</option>
                          <option value={1}>1 · 보통</option>
                          <option value={2}>2 · 강박</option>
                        </SelectField>
                      ))}
                    </div>
                    {issueFor(
                      validation.issues,
                      `sections[${selectedIndex}].accentPattern`,
                      true,
                    ) ? (
                      <p className="inline-issue">
                        {issueFor(
                          validation.issues,
                          `sections[${selectedIndex}].accentPattern`,
                          true,
                        )}
                      </p>
                    ) : null}
                  </fieldset>
                  <div className="section-actions">
                    <Button
                      onClick={() => {
                        setSplitMeasure(Math.min(selected.endMeasure, selected.startMeasure + 1));
                        setSplitOpen(true);
                      }}
                      disabled={selected.startMeasure === selected.endMeasure}
                    >
                      <Scissors size={17} aria-hidden /> 구간 나누기
                    </Button>
                    <Button onClick={mergePrevious} disabled={selectedIndex <= 0}>
                      <GitMerge size={17} aria-hidden /> 이전과 합치기
                    </Button>
                    <Button
                      variant="danger"
                      onClick={removeSection}
                      disabled={map.sections.length === 1}
                    >
                      <Trash2 size={17} aria-hidden /> 삭제
                    </Button>
                  </div>
                </Card>

                <Card className="jump-panel">
                  <header>
                    <div>
                      <span className="eyebrow">Playback order</span>
                      <h2>반복과 이동</h2>
                    </div>
                  </header>
                  <div className="jump-adder">
                    <SelectField
                      label="새 진행 지시"
                      ariaLabel="새 이동 지시 종류"
                      value={newJumpType}
                      onChange={(event) => setNewJumpType(event.target.value as JumpType)}
                    >
                      {Object.entries(JUMP_LABELS).map(([type, label]) => (
                        <option key={type} value={type}>
                          {label}
                        </option>
                      ))}
                    </SelectField>
                    <Button
                      aria-label={`${JUMP_LABELS[newJumpType]} 추가`}
                      onClick={() =>
                        editMap((current) => ({
                          ...current,
                          jumps: [...current.jumps, createJump(newJumpType, current, selected)],
                        }))
                      }
                    >
                      <Plus size={18} aria-hidden /> 추가
                    </Button>
                  </div>
                  {issueFor(validation.issues, 'jumps', true) ? (
                    <p className="inline-issue">{issueFor(validation.issues, 'jumps', true)}</p>
                  ) : null}
                  {map.jumps.length === 0 ? (
                    <p className="subtle">반복, D.C./D.S., Fine, Coda 지시가 없습니다.</p>
                  ) : (
                    <div className="jump-list">
                      {map.jumps.map((jump, index) => (
                        <fieldset className="jump-editor" key={`${index}-${jump.type}`}>
                          <legend>
                            {index + 1}. {JUMP_LABELS[jump.type]}
                          </legend>
                          <div className="jump-editor__header">
                            <SelectField
                              label="지시 종류"
                              value={jump.type}
                              onChange={(event) =>
                                editMap((current) =>
                                  updateJump(
                                    current,
                                    index,
                                    createJump(event.target.value as JumpType, current, selected),
                                  ),
                                )
                              }
                            >
                              {Object.entries(JUMP_LABELS).map(([type, label]) => (
                                <option key={type} value={type}>
                                  {label}
                                </option>
                              ))}
                            </SelectField>
                            <Button
                              variant="ghost"
                              aria-label={`${JUMP_LABELS[jump.type]} 삭제`}
                              onClick={() =>
                                editMap((current) => ({
                                  ...current,
                                  jumps: current.jumps.filter(
                                    (_, itemIndex) => itemIndex !== index,
                                  ),
                                }))
                              }
                            >
                              <Trash2 size={16} aria-hidden /> 지시 삭제
                            </Button>
                          </div>
                          <JumpFields
                            jump={jump}
                            index={index}
                            map={map}
                            issues={validation.issues}
                            onChange={(next) =>
                              editMap((current) => updateJump(current, index, next))
                            }
                          />
                        </fieldset>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            ) : null}

            <div className="editor-save-bar" aria-live="polite">
              <span>
                {rebasedPending
                  ? `서버 revision ${map.revision}에 재기준했습니다. 검토 후 명시적으로 저장하세요.`
                  : isDirty
                    ? '저장되지 않은 변경이 있습니다.'
                    : `revision ${map.revision} 저장됨`}
              </span>
              <Button
                variant="primary"
                onClick={() => void save()}
                disabled={isSaving || isOfflineReadOnly}
              >
                <Save size={17} aria-hidden /> {saveLabel}
              </Button>
            </div>
          </fieldset>
        </>
      ) : null}

      <Modal
        open={blocker.state === 'blocked' && !saveConflict}
        onOpenChange={(open) => {
          if (!open && blocker.state === 'blocked' && !saveConflict) blocker.reset();
        }}
        title="저장하지 않은 변경이 있습니다"
        description="다른 화면으로 이동하기 전에 변경을 저장하거나 버릴지 선택하세요."
      >
        <div className="conflict-actions editor-navigation-actions">
          <Button
            variant="primary"
            onClick={() => void saveAndContinueNavigation()}
            disabled={isSaving}
          >
            <Save size={17} aria-hidden /> {isSaving ? '저장 중…' : '저장 후 이동'}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (blocker.state === 'blocked') blocker.proceed();
            }}
            disabled={isSaving}
          >
            변경 버리고 이동
          </Button>
          <Button
            onClick={() => {
              if (blocker.state === 'blocked') blocker.reset();
            }}
            disabled={isSaving}
          >
            계속 편집
          </Button>
        </div>
      </Modal>

      <Modal
        open={splitOpen}
        onOpenChange={setSplitOpen}
        title="구간 나누기"
        description="입력한 마디부터 새 구간이 시작되며 양쪽 경계는 빈틈 없이 보존됩니다."
      >
        <div className="stack">
          <EditorField
            label="새 구간 시작 마디"
            type="number"
            min={(selected?.startMeasure ?? 1) + 1}
            max={selected?.endMeasure}
            value={splitMeasure}
            onChange={(event) => setSplitMeasure(Number(event.target.value))}
          />
          <Button variant="primary" onClick={split}>
            <Scissors size={18} aria-hidden /> 나누기
          </Button>
        </div>
      </Modal>

      <Modal
        open={Boolean(loadConflict)}
        onOpenChange={() => undefined}
        title="같은 revision의 내용이 다릅니다"
        description="로컬 초안과 서버본 중 사용할 내용을 직접 선택해야 합니다. 자동으로 덮어쓰지 않습니다."
      >
        {loadConflict ? (
          <div className="conflict-dialog">
            <div className="conflict-compare">
              <div>
                <strong>로컬 초안 · revision {loadConflict.local.revision}</strong>
                <span>첫 구간 {loadConflict.local.sections[0]?.bpm ?? '—'} BPM</span>
              </div>
              <div>
                <strong>서버본 · revision {loadConflict.server.revision}</strong>
                <span>첫 구간 {loadConflict.server.sections[0]?.bpm ?? '—'} BPM</span>
              </div>
            </div>
            <div className="conflict-actions">
              <Button
                onClick={() => {
                  const chosen = loadConflict.local;
                  setMap(chosen);
                  setSelectedId(chosen.sections[0]?.id ?? '');
                  setSavedFingerprint(fingerprint(loadConflict.server));
                  setLoadConflict(undefined);
                  void cacheMap(chosen);
                }}
              >
                로컬 초안 사용
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const chosen = loadConflict.server;
                  setLoadConflict(undefined);
                  void applyServerMap(chosen);
                }}
              >
                서버본 사용
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(saveConflict)}
        onOpenChange={() => undefined}
        title="저장 충돌을 해결하세요"
        description="다른 멤버가 먼저 저장했습니다. 서버 최신본을 사용하거나 내 초안을 최신 revision에 재기준할 수 있습니다."
      >
        {saveConflict ? (
          <div className="conflict-dialog">
            <div className="conflict-compare">
              <div>
                <strong>내 초안 · revision {saveConflict.draft.revision}</strong>
                <span>첫 구간 {saveConflict.draft.sections[0]?.bpm ?? '—'} BPM</span>
              </div>
              <div>
                <strong>서버 최신본 · revision {saveConflict.latest.revision}</strong>
                <span>첫 구간 {saveConflict.latest.sections[0]?.bpm ?? '—'} BPM</span>
              </div>
            </div>
            <p className="subtle">
              재기준은 아직 저장이 아닙니다. 편집기로 돌아가 내용을 검토한 뒤 ‘재기준 초안 저장’을
              눌러야 서버에 반영됩니다.
            </p>
            <div className="conflict-actions">
              <Button
                onClick={() => {
                  const latest = saveConflict.latest;
                  setSaveConflict(undefined);
                  void applyServerMap(latest);
                }}
              >
                서버 최신본 불러오기
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const { rebased, latest } = saveConflict;
                  setMap(rebased);
                  setSelectedId(rebased.sections[0]?.id ?? '');
                  setServerSnapshot(latest);
                  setSavedFingerprint(fingerprint(latest));
                  setRebasedPending(true);
                  setSaveConflict(undefined);
                  void cacheMap(rebased);
                }}
              >
                내 초안을 최신 revision에 재기준
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
