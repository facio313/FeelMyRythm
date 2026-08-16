import { Button, Card, EmptyState, Field, Modal, StatusBadge, useToast } from '@feelmyrythm/ui';
import {
  BookOpen,
  FolderPlus,
  LogIn,
  Music2,
  Pencil,
  Plus,
  Settings2,
  SlidersHorizontal,
  Trash2,
  UserPlus,
  UserRoundCog,
  UsersRound,
} from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { localDb } from '../lib/localDb';
import { useAsync } from '../lib/useAsync';
import {
  loadWorkspace,
  type GroupSummary,
  type ProjectSummary,
  type RepertoireSummary,
} from '../lib/workspace';

type ManageTarget =
  | { kind: 'group-edit'; group: GroupSummary }
  | { kind: 'project-create'; groupId: string }
  | { kind: 'project-edit'; project: ProjectSummary }
  | { kind: 'repertoire-create'; projectId: string }
  | { kind: 'repertoire-edit'; repertoire: RepertoireSummary }
  | { kind: 'member-add'; groupId: string };

export function DashboardPage() {
  const { user, client } = useAuth();
  const navigate = useNavigate();
  const { notify } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const createGroupInFlight = useRef(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [manageTarget, setManageTarget] = useState<ManageTarget>();
  const manageInFlight = useRef(false);
  const [submittingManage, setSubmittingManage] = useState(false);
  const [manageName, setManageName] = useState('');
  const [manageDescription, setManageDescription] = useState('');
  const [manageComposer, setManageComposer] = useState('');
  const [memberRole, setMemberRole] = useState<'leader' | 'member'>('member');
  const [memberGroupId, setMemberGroupId] = useState<string>();
  const memberMutationsInFlight = useRef(new Set<string>());
  const [pendingMemberMutations, setPendingMemberMutations] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const groups = useAsync(async () => {
    if (!user) return { groups: [], failures: [] };
    return loadWorkspace(client);
  }, [client, user?.id]);
  const localMaps = useAsync(() => localDb.listTempoMaps(), []);

  async function createGroup(event: FormEvent) {
    event.preventDefault();
    if (createGroupInFlight.current) return;
    createGroupInFlight.current = true;
    setCreatingGroup(true);
    try {
      await client.post<GroupSummary>('/groups', { name: groupName });
      notify({ title: '그룹을 만들었습니다.', tone: 'success' });
      setCreateOpen(false);
      setGroupName('');
      groups.reload();
    } catch (error) {
      notify({
        title: '그룹을 만들지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      createGroupInFlight.current = false;
      setCreatingGroup(false);
    }
  }

  function openManage(target: ManageTarget) {
    setManageTarget(target);
    setManageName(
      target.kind === 'group-edit'
        ? target.group.name
        : target.kind === 'project-edit'
          ? target.project.name
          : target.kind === 'repertoire-edit'
            ? target.repertoire.title
            : '',
    );
    setManageDescription(
      target.kind === 'group-edit'
        ? target.group.description
        : target.kind === 'project-edit'
          ? target.project.description
          : target.kind === 'repertoire-edit'
            ? target.repertoire.notes
            : '',
    );
    setManageComposer(target.kind === 'repertoire-edit' ? target.repertoire.composer : '');
    setMemberRole('member');
  }

  async function submitManage(event: FormEvent) {
    event.preventDefault();
    if (!manageTarget || manageInFlight.current) return;
    manageInFlight.current = true;
    setSubmittingManage(true);
    try {
      switch (manageTarget.kind) {
        case 'group-edit':
          await client.patch(`/groups/${manageTarget.group.id}`, {
            name: manageName,
            description: manageDescription,
          });
          break;
        case 'project-create':
          await client.post(`/groups/${manageTarget.groupId}/projects`, {
            name: manageName,
            description: manageDescription,
          });
          break;
        case 'project-edit':
          await client.patch(`/projects/${manageTarget.project.id}`, {
            name: manageName,
            description: manageDescription,
          });
          break;
        case 'repertoire-create':
          await client.post(`/projects/${manageTarget.projectId}/repertoire`, {
            title: manageName,
            composer: manageComposer,
            notes: manageDescription,
          });
          break;
        case 'repertoire-edit':
          await client.patch(`/repertoire/${manageTarget.repertoire.id}`, {
            title: manageName,
            composer: manageComposer,
            notes: manageDescription,
          });
          break;
        case 'member-add':
          await client.post(`/groups/${manageTarget.groupId}/members`, {
            email: manageName,
            role: memberRole,
          });
          break;
      }
      notify({ title: '작업 공간을 업데이트했습니다.', tone: 'success' });
      setManageTarget(undefined);
      groups.reload();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setManageTarget(undefined);
        groups.reload();
      }
      notify({
        title: '작업 공간을 업데이트하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      manageInFlight.current = false;
      setSubmittingManage(false);
    }
  }

  async function remove(path: string, label: string) {
    if (!window.confirm(`${label}을(를) 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
    try {
      await client.delete(path);
      notify({ title: `${label}을(를) 삭제했습니다.` });
      groups.reload();
    } catch (error) {
      notify({
        title: `${label}을(를) 삭제하지 못했습니다.`,
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  }

  function memberMutationKey(groupId: string, userId: string) {
    return `${groupId}:${userId}`;
  }

  function beginMemberMutation(key: string) {
    if (memberMutationsInFlight.current.has(key)) return false;
    memberMutationsInFlight.current.add(key);
    setPendingMemberMutations((current) => new Set(current).add(key));
    return true;
  }

  function finishMemberMutation(key: string) {
    memberMutationsInFlight.current.delete(key);
    setPendingMemberMutations((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  function handleMemberPermissionFailure(error: unknown) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      setMemberGroupId(undefined);
    }
  }

  async function changeMemberRole(groupId: string, userId: string, role: 'leader' | 'member') {
    const key = memberMutationKey(groupId, userId);
    if (!beginMemberMutation(key)) return;
    try {
      await client.patch(`/groups/${groupId}/members/${userId}`, { role });
      notify({ title: '멤버 역할을 변경했습니다.', tone: 'success' });
    } catch (error) {
      handleMemberPermissionFailure(error);
      notify({
        title: '멤버 역할을 변경하지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      groups.reload();
      finishMemberMutation(key);
    }
  }

  async function removeMember(groupId: string, userId: string, displayName: string) {
    const key = memberMutationKey(groupId, userId);
    if (memberMutationsInFlight.current.has(key)) return;
    if (!window.confirm(`${displayName}님을 그룹에서 내보낼까요?`)) return;
    if (!beginMemberMutation(key)) return;
    try {
      await client.delete(`/groups/${groupId}/members/${userId}`);
      notify({ title: `${displayName}님을 그룹에서 내보냈습니다.` });
    } catch (error) {
      handleMemberPermissionFailure(error);
      notify({
        title: '멤버를 내보내지 못했습니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      groups.reload();
      finishMemberMutation(key);
    }
  }

  const manageTitle =
    manageTarget?.kind === 'group-edit'
      ? '그룹 설정'
      : manageTarget?.kind === 'project-create'
        ? '새 프로젝트'
        : manageTarget?.kind === 'project-edit'
          ? '프로젝트 설정'
          : manageTarget?.kind === 'repertoire-create'
            ? '새 레퍼토리'
            : manageTarget?.kind === 'repertoire-edit'
              ? '레퍼토리 설정'
              : '멤버 초대';

  return (
    <div className="page">
      <PageHeader
        eyebrow="Ensemble workspace"
        title={user ? `${user.displayName}님의 프로젝트` : '프로젝트'}
        description="레퍼토리, 악보, 템포맵과 남은 연습 과제를 한곳에서 확인하세요."
        actions={
          user ? (
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <FolderPlus size={18} aria-hidden /> 새 그룹
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => {
                void navigate('/login');
              }}
            >
              <LogIn size={18} aria-hidden /> 로그인
            </Button>
          )
        }
      />

      {!user ? (
        <Card className="dashboard-callout">
          <div>
            <StatusBadge tone="info">오프라인 모드</StatusBadge>
            <h2>
              {localMaps.loading && localMaps.data === null
                ? '이 기기의 연습 데이터를 확인하고 있습니다.'
                : localMaps.error
                  ? '이 기기의 연습 데이터를 불러오지 못했습니다.'
                  : '혼자 연습한 내용은 안전하게 이 기기에 있습니다.'}
            </h2>
            <p className="subtle">
              로그인하면 그룹 공유, 여러 기기 동기 재생, 프로젝트 일지를 사용할 수 있습니다.
            </p>
            {localMaps.error ? (
              <div className="dashboard-local-error" role="alert">
                <span>{localMaps.error.message}</span>
                <Button size="compact" onClick={localMaps.reload}>
                  다시 시도
                </Button>
              </div>
            ) : null}
          </div>
          <div
            className="dashboard-local-stat"
            role={localMaps.loading && localMaps.data === null ? 'status' : undefined}
            aria-live="polite"
            aria-busy={localMaps.loading && localMaps.data === null}
          >
            {localMaps.loading && localMaps.data === null ? (
              <>
                <strong className="fmr-tabular" aria-hidden="true">
                  —
                </strong>
                <span>저장된 템포맵 확인 중…</span>
              </>
            ) : localMaps.error ? (
              <>
                <strong className="fmr-tabular" aria-hidden="true">
                  —
                </strong>
                <span>개수를 확인할 수 없음</span>
              </>
            ) : (
              <>
                <strong className="fmr-tabular">{localMaps.data?.length}</strong>
                <span>저장된 템포맵</span>
              </>
            )}
          </div>
        </Card>
      ) : null}

      {groups.loading ? (
        <div className="loading-panel" role="status" aria-live="polite" aria-busy="true">
          프로젝트를 불러오는 중…
        </div>
      ) : null}
      {groups.error ? (
        <Card className="error-panel" role="alert">
          <h2>프로젝트를 불러오지 못했습니다.</h2>
          <p>{groups.error.message}</p>
          <Button onClick={groups.reload}>다시 시도</Button>
        </Card>
      ) : null}
      {groups.data && groups.data.failures.length > 0 ? (
        <Card className="error-panel" role="alert">
          <h2>일부 프로젝트 정보를 불러오지 못했습니다.</h2>
          <p>
            불러온 항목은 계속 사용할 수 있습니다. 누락된 {groups.data.failures.length}개 영역을
            다시 확인해 주세요.
          </p>
          <Button onClick={groups.reload}>누락된 정보 다시 시도</Button>
        </Card>
      ) : null}
      {user && !groups.loading && groups.data?.groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={<UsersRound size={36} aria-hidden />}
            title="첫 그룹을 만드세요"
            description="앙상블 멤버와 곡, 악보, 템포맵을 공유할 공간입니다."
            action={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                그룹 만들기
              </Button>
            }
          />
        </Card>
      ) : null}

      <div className="dashboard-groups">
        {groups.data?.groups.map((group) => (
          <section key={group.id} className="group-section">
            <header className="group-section__header">
              <div>
                <div className="cluster">
                  <h2>{group.name}</h2>
                  <StatusBadge>{group.myRole}</StatusBadge>
                </div>
                <span className="subtle">
                  {group.membersLoadError ? '멤버 정보를 불러오지 못함' : `${group.memberCount}명`}
                </span>
              </div>
              <div className="cluster">
                {group.myRole === 'owner' ? (
                  <>
                    <Button
                      variant="ghost"
                      onClick={() => openManage({ kind: 'member-add', groupId: group.id })}
                    >
                      <UserPlus size={17} /> 멤버 초대
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setMemberGroupId(group.id)}
                      disabled={Boolean(group.membersLoadError)}
                    >
                      <UserRoundCog size={17} /> 멤버 관리
                    </Button>
                  </>
                ) : null}
                {group.myRole !== 'member' ? (
                  <Button
                    variant="ghost"
                    onClick={() => openManage({ kind: 'project-create', groupId: group.id })}
                    disabled={Boolean(group.projectsLoadError)}
                  >
                    <Plus size={17} /> 프로젝트
                  </Button>
                ) : null}
                {group.myRole === 'owner' ? (
                  <Button variant="ghost" onClick={() => openManage({ kind: 'group-edit', group })}>
                    <Settings2 size={17} /> 그룹 설정
                  </Button>
                ) : null}
              </div>
            </header>
            <div className="project-grid">
              {group.projectsLoadError ? (
                <Card className="project-card" role="status">
                  <strong>{group.name}의 프로젝트 목록을 불러오지 못했습니다.</strong>
                  <span className="subtle">위의 다시 시도로 누락된 목록을 확인하세요.</span>
                </Card>
              ) : null}
              {group.projects.map((project) => (
                <Card key={project.id} className="project-card">
                  <div className="project-card__heading">
                    <div>
                      <span className="eyebrow">Project</span>
                      <h3>{project.name}</h3>
                    </div>
                    {group.myRole !== 'member' ? (
                      <div className="cluster">
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`${project.name} 레퍼토리 추가`}
                          disabled={Boolean(project.repertoireLoadError)}
                          onClick={() =>
                            openManage({ kind: 'repertoire-create', projectId: project.id })
                          }
                        >
                          <Plus size={17} />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`${project.name} 설정`}
                          onClick={() => openManage({ kind: 'project-edit', project })}
                        >
                          <Pencil size={17} />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`${project.name} 삭제`}
                          onClick={() => void remove(`/projects/${project.id}`, project.name)}
                        >
                          <Trash2 size={17} />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <div className="repertoire-list">
                    {project.repertoireLoadError ? (
                      <div className="session-entry__error" role="status">
                        <span>{project.name}의 레퍼토리를 불러오지 못했습니다.</span>
                      </div>
                    ) : null}
                    {!project.repertoireLoadError && project.repertoire.length === 0 ? (
                      <button
                        className="repertoire-empty-action"
                        type="button"
                        onClick={() =>
                          openManage({ kind: 'repertoire-create', projectId: project.id })
                        }
                        disabled={group.myRole === 'member'}
                      >
                        <BookOpen size={20} /> 첫 레퍼토리 추가
                      </button>
                    ) : null}
                    {project.repertoire.map((item) => (
                      <div key={item.id} className="repertoire-row">
                        <Music2 size={18} aria-hidden />
                        <Link className="repertoire-row__main" to={`/practice/${item.id}`}>
                          <strong>{item.title}</strong>
                          <small>
                            {item.composer ?? '작곡가 미입력'} · 악보 {item.scoreCount} · 할일{' '}
                            {item.openTodoCount}
                          </small>
                        </Link>
                        {item.currentTempoMapRevision ? (
                          <StatusBadge tone="success">
                            rev.{item.currentTempoMapRevision}
                          </StatusBadge>
                        ) : (
                          <StatusBadge tone="warning">템포맵 없음</StatusBadge>
                        )}
                        <div className="repertoire-row__actions">
                          <Link
                            className="dashboard-icon-link"
                            to={`/editor/${item.id}`}
                            aria-label={`${item.title} 템포맵`}
                          >
                            <SlidersHorizontal size={16} />
                          </Link>
                          <Link
                            className="dashboard-icon-link"
                            to={`/repertoire/${item.id}/scores`}
                            aria-label={`${item.title} 악보`}
                          >
                            <BookOpen size={16} />
                          </Link>
                          {group.myRole !== 'member' ? (
                            <>
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`${item.title} 설정`}
                                onClick={() =>
                                  openManage({ kind: 'repertoire-edit', repertoire: item })
                                }
                              >
                                <Pencil size={15} />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`${item.title} 삭제`}
                                onClick={() => void remove(`/repertoire/${item.id}`, item.title)}
                              >
                                <Trash2 size={15} />
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          </section>
        ))}
      </div>

      <Modal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="새 그룹"
        description="공유할 앙상블이나 연습팀 이름을 입력하세요."
      >
        <form className="stack" onSubmit={(event) => void createGroup(event)}>
          <Field
            label="그룹 이름"
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
            autoFocus
            required
          />
          <Button variant="primary" type="submit" disabled={creatingGroup}>
            {creatingGroup ? '만드는 중…' : '만들기'}
          </Button>
        </form>
      </Modal>

      <Modal
        open={manageTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setManageTarget(undefined);
        }}
        title={manageTitle}
        description="변경 내용은 그룹 멤버와 즉시 공유됩니다."
      >
        <form className="stack" onSubmit={(event) => void submitManage(event)}>
          <Field
            label={manageTarget?.kind === 'member-add' ? '멤버 이메일' : '이름'}
            type={manageTarget?.kind === 'member-add' ? 'email' : 'text'}
            value={manageName}
            onChange={(event) => setManageName(event.target.value)}
            autoFocus
            required
          />
          {manageTarget?.kind === 'repertoire-create' ||
          manageTarget?.kind === 'repertoire-edit' ? (
            <Field
              label="작곡가"
              value={manageComposer}
              onChange={(event) => setManageComposer(event.target.value)}
            />
          ) : null}
          {manageTarget?.kind !== 'member-add' ? (
            <label>
              <span className="fmr-field__label">설명 / 메모</span>
              <textarea
                className="fmr-input"
                value={manageDescription}
                onChange={(event) => setManageDescription(event.target.value)}
              />
            </label>
          ) : (
            <label>
              <span className="fmr-field__label">역할</span>
              <select
                className="fmr-input"
                value={memberRole}
                onChange={(event) => setMemberRole(event.target.value as 'leader' | 'member')}
              >
                <option value="member">멤버</option>
                <option value="leader">리더</option>
              </select>
            </label>
          )}
          <Button variant="primary" type="submit" disabled={submittingManage}>
            {submittingManage ? '저장 중…' : '저장'}
          </Button>
          {manageTarget?.kind === 'group-edit' ? (
            <Button
              variant="danger"
              type="button"
              onClick={() => {
                const group = manageTarget.group;
                setManageTarget(undefined);
                void remove(`/groups/${group.id}`, group.name);
              }}
            >
              <Trash2 size={17} /> 그룹 삭제
            </Button>
          ) : null}
        </form>
      </Modal>

      <Modal
        open={memberGroupId !== undefined}
        onOpenChange={(open) => {
          if (!open) setMemberGroupId(undefined);
        }}
        title="멤버 관리"
        description="리더는 프로젝트와 레퍼토리를 편집하고 동기 재생을 제어할 수 있습니다."
      >
        <div className="member-manager">
          {groups.data?.groups
            ?.find((group) => group.id === memberGroupId)
            ?.members.map((member) => {
              const pending = pendingMemberMutations.has(
                memberMutationKey(memberGroupId!, member.userId),
              );
              return (
                <div
                  key={member.userId}
                  className="member-manager__row"
                  role="group"
                  aria-label={`${member.displayName} 멤버 관리`}
                  aria-busy={pending}
                >
                  <span>
                    <strong>{member.displayName}</strong>
                    <small role={pending ? 'status' : undefined} aria-live="polite">
                      {pending ? '업데이트 중…' : member.email}
                    </small>
                  </span>
                  {member.role === 'owner' ? (
                    <StatusBadge>owner</StatusBadge>
                  ) : (
                    <>
                      <label>
                        <span className="sr-only">{member.displayName} 역할</span>
                        <select
                          className="fmr-input"
                          value={member.role}
                          disabled={pending}
                          aria-busy={pending}
                          onChange={(event) =>
                            void changeMemberRole(
                              memberGroupId!,
                              member.userId,
                              event.target.value as 'leader' | 'member',
                            )
                          }
                        >
                          <option value="member">멤버</option>
                          <option value="leader">리더</option>
                        </select>
                      </label>
                      <Button
                        size="icon"
                        variant="danger"
                        disabled={pending}
                        aria-busy={pending}
                        aria-label={
                          pending
                            ? `${member.displayName} 멤버 정보 업데이트 중`
                            : `${member.displayName} 내보내기`
                        }
                        onClick={() =>
                          void removeMember(memberGroupId!, member.userId, member.displayName)
                        }
                      >
                        {pending ? <span aria-hidden>…</span> : <Trash2 size={16} />}
                      </Button>
                    </>
                  )}
                </div>
              );
            })}
        </div>
      </Modal>
    </div>
  );
}
