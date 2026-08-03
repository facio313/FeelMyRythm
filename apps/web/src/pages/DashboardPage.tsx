/** 그룹 → 프로젝트 → 레파토리 대시보드 (UI_DESIGN.md §7.5) */
import type { GroupMemberOut, GroupOut, ProjectOut, RepertoireOut } from '@feelmyrythm/protocol';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

export default function DashboardPage() {
  const [groups, setGroups] = useState<GroupOut[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<GroupOut | null>(null);
  const [members, setMembers] = useState<GroupMemberOut[]>([]);
  const [projects, setProjects] = useState<ProjectOut[]>([]);
  const [selectedProject, setSelectedProject] = useState<ProjectOut | null>(null);
  const [repertoire, setRepertoire] = useState<RepertoireOut[]>([]);
  const [error, setError] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const navigate = useNavigate();

  const [newGroup, setNewGroup] = useState('');
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [newProject, setNewProject] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newComposer, setNewComposer] = useState('');

  const guard = useCallback(<T,>(p: Promise<T>): Promise<T | undefined> => {
    return p.catch((e) => {
      setError(e.message);
      return undefined;
    });
  }, []);

  useEffect(() => {
    void guard(api<GroupOut[]>('/api/groups')).then((g) => g && setGroups(g));
  }, [guard]);

  useEffect(() => {
    if (!selectedGroup) return;
    void guard(api<ProjectOut[]>(`/api/groups/${selectedGroup.id}/projects`)).then((p) => p && setProjects(p));
    void guard(api<GroupMemberOut[]>(`/api/groups/${selectedGroup.id}/members`)).then((m) => m && setMembers(m));
    setSelectedProject(null);
    setRepertoire([]);
  }, [selectedGroup, guard]);

  useEffect(() => {
    if (!selectedProject) return;
    void guard(api<RepertoireOut[]>(`/api/projects/${selectedProject.id}/repertoire`)).then(
      (r) => r && setRepertoire(r),
    );
  }, [selectedProject, guard]);

  const canLead = selectedGroup?.myRole === 'owner' || selectedGroup?.myRole === 'leader';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <h1 className="section-title m-0 flex-1">내 그룹</h1>
        <input
          className="input w-32 uppercase"
          placeholder="세션 코드"
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
        />
        <button className="btn" disabled={joinCode.length < 4} onClick={() => navigate(`/session/${joinCode}`)}>
          세션 입장
        </button>
      </div>
      {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}

      {/* 그룹 목록 + 생성 */}
      <div className="flex flex-wrap gap-2">
        {groups.map((g) => (
          <button
            key={g.id}
            className="btn"
            style={selectedGroup?.id === g.id ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
            onClick={() => setSelectedGroup(g)}
          >
            {g.name}
          </button>
        ))}
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const g = await guard(api<GroupOut>('/api/groups', { method: 'POST', json: { name: newGroup } }));
            if (g) {
              setGroups((prev) => [...prev, g]);
              setNewGroup('');
            }
          }}
        >
          <input
            className="input w-40"
            placeholder="새 그룹 이름"
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
          />
          <button className="btn" disabled={!newGroup.trim()}>
            + 그룹
          </button>
        </form>
      </div>

      {selectedGroup && (
        <div className="grid gap-4 md:grid-cols-2">
          {/* 멤버 */}
          <div className="card">
            <h2 className="section-title">멤버</h2>
            <ul className="flex flex-col gap-1 text-sm">
              {members.map((m) => (
                <li key={m.userId} className="flex justify-between">
                  <span>{m.displayName}</span>
                  <span style={{ color: m.role === 'member' ? 'var(--text-muted)' : 'var(--accent)' }}>{m.role}</span>
                </li>
              ))}
            </ul>
            {canLead && (
              <form
                className="mt-3 flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const m = await guard(
                    api<GroupMemberOut[]>(`/api/groups/${selectedGroup.id}/members`, {
                      method: 'POST',
                      json: { email: newMemberEmail, role: 'member' },
                    }),
                  );
                  if (m) {
                    setMembers(m);
                    setNewMemberEmail('');
                  }
                }}
              >
                <input
                  type="email"
                  className="input flex-1"
                  placeholder="멤버 이메일 (가입자)"
                  value={newMemberEmail}
                  onChange={(e) => setNewMemberEmail(e.target.value)}
                />
                <button className="btn">추가</button>
              </form>
            )}
          </div>

          {/* 프로젝트 */}
          <div className="card">
            <h2 className="section-title">프로젝트 (공연·시즌)</h2>
            <ul className="flex flex-col gap-2">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    className="btn w-full justify-start"
                    style={selectedProject?.id === p.id ? { borderColor: 'var(--accent)' } : undefined}
                    onClick={() => setSelectedProject(p)}
                  >
                    {p.name}
                  </button>
                </li>
              ))}
            </ul>
            {canLead && (
              <form
                className="mt-3 flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const p = await guard(
                    api<ProjectOut>(`/api/groups/${selectedGroup.id}/projects`, {
                      method: 'POST',
                      json: { name: newProject },
                    }),
                  );
                  if (p) {
                    setProjects((prev) => [...prev, p]);
                    setNewProject('');
                  }
                }}
              >
                <input
                  className="input flex-1"
                  placeholder="새 프로젝트"
                  value={newProject}
                  onChange={(e) => setNewProject(e.target.value)}
                />
                <button className="btn">추가</button>
              </form>
            )}
          </div>
        </div>
      )}

      {selectedProject && (
        <div className="card">
          <h2 className="section-title">레파토리 — {selectedProject.name}</h2>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {repertoire.map((r) => (
              <Link
                key={r.id}
                to={`/repertoire/${r.id}`}
                className="card block"
                style={{ background: 'var(--surface-raised)' }}
              >
                <div className="font-semibold">{r.title}</div>
                <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  {r.composer || '작곡가 미상'}
                </div>
                <div className="mt-2 flex gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <span>{r.hasTempoMap ? '✓ 템포맵' : '템포맵 없음'}</span>
                  <span>악보 {r.scoreCount}</span>
                  {r.openTodoCount > 0 && <span style={{ color: 'var(--accent)' }}>할일 {r.openTodoCount}</span>}
                </div>
              </Link>
            ))}
          </div>
          <form
            className="mt-4 flex flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await guard(
                api<RepertoireOut>(`/api/projects/${selectedProject.id}/repertoire`, {
                  method: 'POST',
                  json: { title: newTitle, composer: newComposer },
                }),
              );
              if (r) {
                setRepertoire((prev) => [...prev, r]);
                setNewTitle('');
                setNewComposer('');
              }
            }}
          >
            <input className="input flex-1" placeholder="곡 제목" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            <input className="input w-40" placeholder="작곡가" value={newComposer} onChange={(e) => setNewComposer(e.target.value)} />
            <button className="btn" disabled={!newTitle.trim()}>
              + 곡 추가
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
