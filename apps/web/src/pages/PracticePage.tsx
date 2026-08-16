import { Button, Card, EmptyState, Field, Modal, StatusBadge, useToast } from '@feelmyrythm/ui';
import type { components } from '@feelmyrythm/protocol';
import { Check, Circle, ClipboardCheck, FilePenLine, MapPin, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MarkdownContent } from '../components/MarkdownContent';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../lib/auth';
import { localDb, type CachedPracticeLog } from '../lib/localDb';
import { useAsync } from '../lib/useAsync';

interface Todo {
  id: string;
  content: string;
  createdById?: string;
  assigneeId?: string;
  assigneeDisplayName?: string;
  dueDate?: string;
  completed: boolean;
}

interface TodoDraft {
  content: string;
  assigneeId: string;
  dueDate: string;
}

interface PracticeLog {
  id: string;
  authorId?: string;
  bodyMarkdown: string;
  measureNumber?: number;
  createdAt: string;
  authorDisplayName: string;
  todos: Todo[];
}

interface PracticeLoadResult {
  items: PracticeLog[];
  offline: boolean;
}

type ServerPracticeLog = components['schemas']['PracticeLogOut'];
type ServerTodo = components['schemas']['TodoOut'];
type ServerRepertoire = components['schemas']['RepertoireOut'];
type ServerProject = components['schemas']['ProjectOut'];
type ServerGroupMember = components['schemas']['GroupMemberOut'];

const EMPTY_TODO_DRAFT: TodoDraft = { content: '', assigneeId: '', dueDate: '' };

const isNetworkFailure = (error: unknown): boolean =>
  error instanceof TypeError && /fetch|network|load/i.test(error.message);

function practiceLogFromCache(log: CachedPracticeLog): PracticeLog {
  return {
    id: log.id,
    authorId: log.authorId,
    bodyMarkdown: log.content,
    ...(log.anchors[0]?.measureNumber === undefined
      ? {}
      : { measureNumber: log.anchors[0].measureNumber }),
    createdAt: log.createdAt,
    authorDisplayName: log.authorName,
    todos: log.todos ?? [],
  };
}

export function PracticePage() {
  const { repertoireItemId = 'local' } = useParams();
  const { user, client } = useAuth();
  const { notify } = useToast();
  const [body, setBody] = useState('');
  const [measure, setMeasure] = useState('');
  const [todoDrafts, setTodoDrafts] = useState<Record<string, TodoDraft>>({});
  const submittingLogRef = useRef(false);
  const [submittingLog, setSubmittingLog] = useState(false);
  const [submittingTodoId, setSubmittingTodoId] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string>();

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setBody('');
      setMeasure('');
      setTodoDrafts({});
      submittingLogRef.current = false;
      setSubmittingLog(false);
      setSubmittingTodoId(null);
      setPreviewing(false);
      setPendingDeleteId(undefined);
    });
    return () => {
      active = false;
    };
  }, [repertoireItemId, user?.id]);

  const members = useAsync(async () => {
    if (!user || repertoireItemId === 'local') return [];
    const repertoire = await client.get<ServerRepertoire>(`/repertoire/${repertoireItemId}`);
    const project = await client.get<ServerProject>(`/projects/${repertoire.projectId}`);
    return client.get<ServerGroupMember[]>(`/groups/${project.groupId}/members`);
  }, [client, user?.id, repertoireItemId]);
  const access = useAsync<{ role: 'owner' | 'leader' | 'member' }>(async () => {
    if (!user || repertoireItemId === 'local') return { role: 'owner' };
    return client.get(`/repertoire/${encodeURIComponent(repertoireItemId)}/access`);
  }, [client, user?.id, repertoireItemId]);
  const logs = useAsync<PracticeLoadResult>(async () => {
    if (!user) {
      const stored = localStorage.getItem(`fmr.practice.${repertoireItemId}`);
      return { items: stored ? (JSON.parse(stored) as PracticeLog[]) : [], offline: false };
    }
    const remoteCacheScope = { userId: user.id };
    try {
      const [serverLogs, serverTodos] = await Promise.all([
        client.get<ServerPracticeLog[]>(`/repertoire/${repertoireItemId}/logs`),
        client.get<ServerTodo[]>(`/repertoire/${repertoireItemId}/todos`),
      ]);
      const items = serverLogs.map((log): PracticeLog => ({
        id: log.id,
        authorId: log.authorId,
        bodyMarkdown: log.content,
        ...(log.anchors[0]?.measureNumber == null
          ? {}
          : { measureNumber: log.anchors[0].measureNumber }),
        createdAt: log.createdAt,
        authorDisplayName: log.authorName,
        todos: serverTodos
          .filter((todo) => todo.practiceLogId === log.id)
          .map((todo) => ({
            id: todo.id,
            content: todo.content,
            createdById: todo.createdById,
            ...(todo.assigneeId ? { assigneeId: todo.assigneeId } : {}),
            ...(todo.dueDate ? { dueDate: todo.dueDate } : {}),
            completed: todo.done,
          })),
      }));
      try {
        await localDb.putPracticeLogs(
          repertoireItemId,
          serverLogs.map((log) => ({
            id: log.id,
            repertoireId: log.repertoireId,
            authorId: log.authorId,
            authorName: log.authorName,
            content: log.content,
            anchors: log.anchors.map((anchor) => ({
              ...(anchor.measureNumber == null ? {} : { measureNumber: anchor.measureNumber }),
              ...(anchor.scoreId == null ? {} : { scoreId: anchor.scoreId }),
              ...(anchor.page == null ? {} : { page: anchor.page }),
              ...(anchor.x == null ? {} : { x: anchor.x }),
              ...(anchor.y == null ? {} : { y: anchor.y }),
              ...(anchor.note == null ? {} : { note: anchor.note }),
            })),
            createdAt: log.createdAt,
            updatedAt: log.updatedAt,
            todos: items.find((item) => item.id === log.id)?.todos ?? [],
          })),
          remoteCacheScope,
        );
      } catch {
        // The authoritative server result remains usable when cache maintenance fails.
      }
      return { items, offline: false };
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
      const cached = await localDb.getPracticeLogSnapshot(repertoireItemId, remoteCacheScope);
      if (!cached) throw error;
      return { items: cached.logs.map(practiceLogFromCache), offline: true };
    }
  }, [client, user?.id, repertoireItemId]);

  const memberNameById = new Map(
    (members.data ?? []).map((member) => [member.userId, member.displayName]),
  );
  const canManagePractice =
    !user || access.data?.role === 'owner' || access.data?.role === 'leader';
  const offlineReadOnly = logs.data?.offline === true;
  const editingDisabled = offlineReadOnly || logs.loading;

  function updateTodoDraft(logId: string, update: Partial<TodoDraft>) {
    setTodoDrafts((current) => ({
      ...current,
      [logId]: { ...(current[logId] ?? EMPTY_TODO_DRAFT), ...update },
    }));
  }

  async function createLog(event: FormEvent) {
    event.preventDefault();
    if (editingDisabled || submittingLogRef.current) return;
    const content = body.trim();
    if (!content) {
      notify({ title: '연습 메모를 입력해 주세요.', tone: 'danger' });
      setPreviewing(false);
      return;
    }
    submittingLogRef.current = true;
    setSubmittingLog(true);
    const localPayload = {
      bodyMarkdown: content,
      ...(measure ? { measureNumber: Number(measure) } : {}),
    };
    try {
      if (user) {
        await client.post(`/repertoire/${repertoireItemId}/logs`, {
          content,
          anchors: measure ? [{ measureNumber: Number(measure) }] : [],
        });
      } else {
        const next: PracticeLog[] = [
          {
            id: crypto.randomUUID(),
            ...localPayload,
            createdAt: new Date().toISOString(),
            authorDisplayName: '나',
            todos: [],
          },
          ...(logs.data?.items ?? []),
        ];
        localStorage.setItem(`fmr.practice.${repertoireItemId}`, JSON.stringify(next));
      }
      setBody('');
      setMeasure('');
      setPreviewing(false);
      logs.reload();
      notify({ title: '연습일지를 저장했습니다.', tone: 'success' });
    } catch (error) {
      notify({
        title: '연습일지를 저장하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      submittingLogRef.current = false;
      setSubmittingLog(false);
    }
  }

  async function addTodo(logId: string) {
    if (editingDisabled) return;
    const draft = todoDrafts[logId] ?? EMPTY_TODO_DRAFT;
    const content = draft.content.trim();
    if (!content) return;
    setSubmittingTodoId(logId);
    try {
      if (user) {
        await client.post(`/repertoire/${repertoireItemId}/todos`, {
          content,
          practiceLogId: logId,
          ...(draft.assigneeId ? { assigneeId: draft.assigneeId } : {}),
          ...(draft.dueDate ? { dueDate: draft.dueDate } : {}),
        });
      } else {
        const next = (logs.data?.items ?? []).map((log) =>
          log.id === logId
            ? {
                ...log,
                todos: [
                  ...log.todos,
                  {
                    id: crypto.randomUUID(),
                    content,
                    ...(draft.assigneeId === 'local' ? { assigneeDisplayName: '나' } : {}),
                    ...(draft.dueDate ? { dueDate: draft.dueDate } : {}),
                    completed: false,
                  },
                ],
              }
            : log,
        );
        localStorage.setItem(`fmr.practice.${repertoireItemId}`, JSON.stringify(next));
      }
      setTodoDrafts((current) => ({ ...current, [logId]: EMPTY_TODO_DRAFT }));
      logs.reload();
      notify({ title: '할일을 추가했습니다.', tone: 'success' });
    } catch (error) {
      notify({
        title: '할일을 추가하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      setSubmittingTodoId(null);
    }
  }

  async function toggleTodo(logId: string, todo: Todo) {
    if (editingDisabled) return;
    if (user && !canManagePractice && todo.createdById !== user.id && todo.assigneeId !== user.id)
      return;
    try {
      if (user) {
        await client.patch(`/todos/${todo.id}`, { done: !todo.completed });
      } else {
        const next = (logs.data?.items ?? []).map((log) =>
          log.id === logId
            ? {
                ...log,
                todos: log.todos.map((item) =>
                  item.id === todo.id ? { ...item, completed: !item.completed } : item,
                ),
              }
            : log,
        );
        localStorage.setItem(`fmr.practice.${repertoireItemId}`, JSON.stringify(next));
      }
      logs.reload();
    } catch (error) {
      notify({
        title: '할일을 수정하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  }

  async function deleteLog(logId: string) {
    if (editingDisabled) return;
    const target = logs.data?.items.find((log) => log.id === logId);
    if (!target) return;
    if (user && target.authorId !== user.id && !canManagePractice) return;
    try {
      if (user) {
        await client.delete(`/logs/${logId}`);
      } else {
        const next = (logs.data?.items ?? []).filter((log) => log.id !== logId);
        localStorage.setItem(`fmr.practice.${repertoireItemId}`, JSON.stringify(next));
      }
      logs.reload();
      notify({ title: '일지를 삭제했습니다.' });
    } catch (error) {
      notify({
        title: '일지를 삭제하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  }

  return (
    <div className="page page--narrow">
      <PageHeader
        eyebrow="Practice journal"
        title="연습일지"
        description={
          user
            ? '마디에 연결된 메모와 팀의 할일을 기록합니다.'
            : '오프라인 개인 일지입니다. 로그인하면 프로젝트와 공유할 수 있습니다.'
        }
      />
      <Card>
        <form className="practice-form" onSubmit={(event) => void createLog(event)}>
          <label>
            <span className="practice-form__label-row">
              <span className="fmr-field__label">오늘의 메모 (Markdown)</span>
              <button
                type="button"
                className="practice-preview-toggle"
                aria-pressed={previewing}
                onClick={() => setPreviewing((current) => !current)}
              >
                {previewing ? '편집' : '미리보기'}
              </button>
            </span>
            {previewing ? (
              <div className="practice-form__preview" aria-label="Markdown 미리보기">
                {body.trim() ? (
                  <MarkdownContent>{body}</MarkdownContent>
                ) : (
                  <span className="subtle">내용을 입력하면 미리보기가 표시됩니다.</span>
                )}
              </div>
            ) : (
              <textarea
                className="fmr-input practice-form__body"
                disabled={editingDisabled}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="26마디 crescendo의 시작을 더 분명하게…"
                required
              />
            )}
          </label>
          <Field
            label="연결할 마디 (선택)"
            type="number"
            min={1}
            disabled={editingDisabled}
            value={measure}
            onChange={(event) => setMeasure(event.target.value)}
          />
          <Button variant="primary" type="submit" disabled={editingDisabled || submittingLog}>
            <FilePenLine size={18} aria-hidden /> {submittingLog ? '저장 중…' : '일지 저장'}
          </Button>
        </form>
      </Card>

      {logs.loading && !logs.data ? (
        <Card className="loading-panel practice-data-message" role="status">
          연습일지를 불러오는 중…
        </Card>
      ) : null}
      {logs.error ? (
        <Card className="error-panel practice-data-message" role="alert">
          <strong>연습일지를 불러오지 못했습니다.</strong>
          <span>{logs.error.message}</span>
          <Button size="compact" onClick={logs.reload}>
            다시 시도
          </Button>
        </Card>
      ) : null}
      {logs.data?.offline ? (
        <Card className="score-data-message practice-data-message" role="status">
          <strong>저장된 오프라인 연습일지를 표시합니다.</strong>
          <span>네트워크가 복구될 때까지 일지와 할일은 읽기 전용입니다.</span>
          <Button size="compact" onClick={logs.reload}>
            다시 연결
          </Button>
        </Card>
      ) : null}
      {user && members.error ? (
        <Card className="error-panel practice-data-message" role="alert">
          <strong>그룹 멤버를 불러오지 못했습니다.</strong>
          <span>할일은 저장할 수 있지만 담당자는 지정할 수 없습니다.</span>
          <Button size="compact" onClick={members.reload}>
            멤버 다시 불러오기
          </Button>
        </Card>
      ) : null}
      {user && access.error ? (
        <Card className="error-panel practice-data-message" role="alert">
          <strong>연습일지 권한을 확인하지 못했습니다.</strong>
          <span>본인이 만든 일지와 할일만 수정할 수 있습니다.</span>
          <Button size="compact" onClick={access.reload}>
            권한 다시 확인
          </Button>
        </Card>
      ) : null}
      {user && !members.loading && !members.error && members.data?.length === 0 ? (
        <p className="subtle practice-member-empty" role="status">
          지정할 수 있는 그룹 멤버가 없습니다. 그룹에 멤버를 초대하면 담당자를 선택할 수 있습니다.
        </p>
      ) : null}

      <div className="practice-log-list">
        {!logs.loading && logs.data?.items.length === 0 ? (
          <Card>
            <EmptyState
              icon={<ClipboardCheck size={36} aria-hidden />}
              title="아직 연습일지가 없습니다"
              description="오늘 발견한 한 가지부터 기록해 보세요."
            />
          </Card>
        ) : null}
        {logs.data?.items.map((log) => (
          <Card key={log.id} className="practice-log">
            <header>
              <div className="cluster">
                <strong>{log.authorDisplayName}</strong>
                <span className="subtle">{new Date(log.createdAt).toLocaleString('ko-KR')}</span>
              </div>
              {log.measureNumber ? (
                <Link
                  className="practice-anchor-link"
                  to={
                    repertoireItemId === 'local'
                      ? `/scores?measure=${log.measureNumber}`
                      : `/repertoire/${encodeURIComponent(repertoireItemId)}/scores?measure=${log.measureNumber}`
                  }
                  aria-label={`${log.measureNumber}마디를 악보에서 보기`}
                >
                  <StatusBadge tone="info">
                    <MapPin size={13} aria-hidden /> {log.measureNumber}마디 · 악보에서 보기
                  </StatusBadge>
                </Link>
              ) : null}
            </header>
            <MarkdownContent>{log.bodyMarkdown}</MarkdownContent>
            <div className="todo-list">
              {log.todos.length === 0 ? (
                <p className="todo-list__empty">아직 할일이 없습니다.</p>
              ) : (
                log.todos.map((todo) => {
                  const canUpdateTodo =
                    !user ||
                    canManagePractice ||
                    todo.createdById === user.id ||
                    todo.assigneeId === user.id;
                  const assigneeName = todo.assigneeDisplayName
                    ? todo.assigneeDisplayName
                    : todo.assigneeId
                      ? members.loading
                        ? '담당자 확인 중…'
                        : (memberNameById.get(todo.assigneeId) ?? '탈퇴한 멤버')
                      : null;
                  const dueDateLabel = todo.dueDate
                    ? `${new Date(`${todo.dueDate}T00:00:00`).toLocaleDateString('ko-KR')}까지`
                    : null;
                  return (
                    <button
                      key={todo.id}
                      className="todo-row"
                      type="button"
                      aria-pressed={todo.completed}
                      aria-label={[
                        todo.content,
                        todo.completed ? '완료됨' : '미완료',
                        assigneeName ? `담당 ${assigneeName}` : null,
                        dueDateLabel,
                        canUpdateTodo ? null : '수정 권한 없음',
                      ]
                        .filter(Boolean)
                        .join(', ')}
                      disabled={!canUpdateTodo || editingDisabled}
                      onClick={() => void toggleTodo(log.id, todo)}
                    >
                      {todo.completed ? (
                        <Check className="todo-row__done" size={18} aria-hidden />
                      ) : (
                        <Circle size={18} aria-hidden />
                      )}
                      <span className={todo.completed ? 'todo-row__content--done' : ''}>
                        {todo.content}
                      </span>
                      {assigneeName ? <small>{assigneeName}</small> : null}
                      {dueDateLabel ? <small>{dueDateLabel}</small> : null}
                    </button>
                  );
                })
              )}
              <form
                className="todo-adder"
                onSubmit={(event) => {
                  event.preventDefault();
                  void addTodo(log.id);
                }}
              >
                <label>
                  <span>할일</span>
                  <input
                    className="fmr-input"
                    disabled={editingDisabled}
                    value={(todoDrafts[log.id] ?? EMPTY_TODO_DRAFT).content}
                    onChange={(event) => updateTodoDraft(log.id, { content: event.target.value })}
                    placeholder="할일 추가"
                    required
                  />
                </label>
                <label>
                  <span>담당자 (선택)</span>
                  <select
                    className="fmr-input"
                    value={(todoDrafts[log.id] ?? EMPTY_TODO_DRAFT).assigneeId}
                    onChange={(event) =>
                      updateTodoDraft(log.id, { assigneeId: event.target.value })
                    }
                    disabled={
                      editingDisabled ||
                      (user
                        ? members.loading || Boolean(members.error) || members.data?.length === 0
                        : false)
                    }
                  >
                    <option value="">담당자 없음</option>
                    {user ? (
                      members.data?.map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.displayName} ({member.email})
                        </option>
                      ))
                    ) : (
                      <option value="local">나</option>
                    )}
                  </select>
                </label>
                <Field
                  label="기한 (선택)"
                  type="date"
                  disabled={editingDisabled}
                  value={(todoDrafts[log.id] ?? EMPTY_TODO_DRAFT).dueDate}
                  onChange={(event) => updateTodoDraft(log.id, { dueDate: event.target.value })}
                />
                <Button
                  size="icon"
                  type="submit"
                  aria-label="할일 추가"
                  disabled={editingDisabled || submittingTodoId === log.id}
                >
                  <Plus size={18} aria-hidden />
                </Button>
                {(!user || log.authorId === user.id || canManagePractice) && !offlineReadOnly ? (
                  <Button
                    size="icon"
                    type="button"
                    variant="ghost"
                    aria-label="일지 삭제"
                    onClick={() => setPendingDeleteId(log.id)}
                  >
                    <Trash2 size={18} aria-hidden />
                  </Button>
                ) : null}
              </form>
            </div>
          </Card>
        ))}
      </div>

      <Modal
        open={pendingDeleteId !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(undefined);
        }}
        title="연습일지를 삭제할까요?"
        description="연결된 할일도 함께 삭제되며 되돌릴 수 없습니다."
      >
        <div className="cluster modal-actions">
          <Button variant="ghost" onClick={() => setPendingDeleteId(undefined)}>
            취소
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              const logId = pendingDeleteId;
              setPendingDeleteId(undefined);
              if (logId) void deleteLog(logId);
            }}
          >
            <Trash2 size={18} aria-hidden /> 삭제
          </Button>
        </div>
      </Modal>
    </div>
  );
}
